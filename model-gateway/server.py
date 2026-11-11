"""Loopback-only managed gateway. Run one process behind the trusted Nginx proxy.

Nginx must overwrite X-Real-IP with remote_addr, preserve Host/Origin/Cookie,
and allow at most 128 MiB. No client headers or redirect targets go upstream.
"""

import argparse
import base64
import binascii
import http.client
import ipaddress
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
from email import policy
from email.parser import BytesParser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from config import DEFAULT_CONFIG, load_config
from state import SESSION_TTL, State, StateError

PREFIX = "/api/managed"
COOKIE = "aoweisi_managed_session"
MAX_BODY = 128 * 1024 * 1024
MAX_TEXT = 1024 * 1024
MAX_EVENT = 1024 * 1024
MAX_TOKENS = 8192
MODEL_PATHS = {"/v1/images/generations", "/v1/images/edits", "/v1/responses", "/v1/chat/completions"}
RASTER_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


def invalid():
    raise StateError(400, "invalid_request", "Invalid or unsupported request.")


def json_loads(raw):
    # Bound allocation amplification before json builds millions of tiny objects.
    # Delimiters in quoted prompts count too; base64 image data has none.
    marks = (b"{", b"[", b",") if isinstance(raw, bytes) else ("{", "[", ",")
    if sum(raw.count(mark) for mark in marks) > 20000:
        invalid()
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                invalid()
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: invalid())
    except (ValueError, UnicodeError, RecursionError):
        invalid()


def fields(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or not set(required) <= set(value):
        invalid()


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        invalid()
    return value


def text(value, limit=MAX_TEXT):
    if not isinstance(value, str) or len(value) > limit:
        invalid()
    return value


def raster(data, mime):
    """Validate raster bytes and return their actual MIME type.

    Older clients could label provider JPEG output as PNG. Trusting the label
    rejects valid historical images, while trusting the signature keeps the
    same raster-only security boundary and lets us repair the part upstream.
    """
    if mime not in RASTER_TYPES or not data:
        invalid()
    actual = ("image/png" if data.startswith(b"\x89PNG\r\n\x1a\n") else
              "image/jpeg" if data.startswith(b"\xff\xd8\xff") else
              "image/webp" if data[:4] == b"RIFF" and data[8:12] == b"WEBP" else
              "image/gif" if data[:6] in (b"GIF87a", b"GIF89a") else None)
    if actual is None:
        invalid()
    return actual


def image_data(value):
    # Vision references carry bytes, never arbitrary server-side fetch targets.
    if not isinstance(value, str) or len(value) > MAX_BODY:
        invalid()
    match = re.match(r"^data:(image/(?:png|jpeg|webp|gif));base64,", value)
    if not match:
        invalid()
    try:
        data = base64.b64decode(value[match.end():], validate=True)
    except (ValueError, binascii.Error):
        invalid()
    raster(data, match[1])


def validate_image(body, path, config, uploaded=False):
    allowed = {"model", "prompt", "n", "size", "quality", "background", "output_format", "output_compression", "response_format"}
    if path.endswith("/edits") and not uploaded:
        allowed |= {"image", "images", "mask", "input_fidelity"}
    elif path.endswith("/edits"):
        allowed |= {"input_fidelity"}
    fields(body, allowed, ("model", "prompt"))
    if not isinstance(body["model"], str) or body["model"] not in config.image_models:
        invalid()
    if not text(body["prompt"], 64000).strip():
        invalid()
    n = integer(body.get("n", 1), 1, 15)
    for key, values in {
        "quality": {"auto", "low", "medium", "high"},
        "background": {"auto", "opaque", "transparent"},
        "output_format": {"png", "jpeg", "webp"},
        "response_format": {"url", "b64_json"},
        "input_fidelity": {"low", "high"},
    }.items():
        if key in body and (not isinstance(body[key], str) or body[key] not in values):
            invalid()
    if "size" in body:
        size = body["size"]
        if not isinstance(size, str):
            invalid()
        if size != "auto":
            match = re.fullmatch(r"([1-9][0-9]{2,3})x([1-9][0-9]{2,3})", size)
            if not match:
                invalid()
            width, height = map(int, match.groups())
            if max(width, height) > 4096 or min(width, height) < 256 or width * height > 16777216:
                invalid()
    if "output_compression" in body:
        integer(body["output_compression"], 0, 100)
    if path.endswith("/edits") and not uploaded:
        if ("image" in body) == ("images" in body):
            invalid()
        images = body.get("image", body.get("images"))
        images = images if isinstance(images, list) else [images]
        if not 1 <= len(images) <= 16:
            invalid()
        for value in images:
            image_data(value)
        if "mask" in body:
            image_data(body["mask"])
    return n


def validate_messages(messages, responses):
    if responses and isinstance(messages, str):
        text(messages)
        return
    if not isinstance(messages, list) or not 1 <= len(messages) <= 200:
        invalid()
    text_count, image_count = 0, 0
    for message in messages:
        fields(message, ("role", "content", "type"), ("role", "content"))
        if (message["role"] not in ("user", "assistant", "system", "developer")
                or ("type" in message and (not responses or message["type"] != "message"))):
            invalid()
        content = message["content"]
        if isinstance(content, str):
            text_count += len(text(content))
        else:
            if not isinstance(content, list) or not 1 <= len(content) <= 64:
                invalid()
            for item in content:
                if not isinstance(item, dict):
                    invalid()
                kind = item.get("type")
                if kind == ("input_text" if responses else "text"):
                    fields(item, ("type", "text"), ("type", "text"))
                    text_count += len(text(item["text"]))
                elif kind == ("input_image" if responses else "image_url"):
                    if responses:
                        fields(item, ("type", "image_url", "detail"), ("type", "image_url"))
                        value, detail = item["image_url"], item.get("detail", "auto")
                    else:
                        fields(item, ("type", "image_url"), ("type", "image_url"))
                        fields(item["image_url"], ("url", "detail"), ("url",))
                        value, detail = item["image_url"]["url"], item["image_url"].get("detail", "auto")
                    if detail not in ("auto", "low", "high"):
                        invalid()
                    image_data(value)
                    image_count += 1
                else:
                    invalid()
        if text_count > MAX_TEXT or image_count > 16:
            invalid()


def validate_text(body, path, config):
    responses = path == "/v1/responses"
    allowed = {"model", "stream", "store", "background", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p"}
    allowed |= {"input", "instructions", "max_output_tokens", "reasoning", "text"} if responses else {
        "messages", "max_tokens", "max_completion_tokens", "reasoning_effort", "response_format", "n", "stream_options"}
    fields(body, allowed, ("model", "input" if responses else "messages"))
    if not isinstance(body["model"], str) or body["model"] not in config.text_models:
        invalid()
    for key in ("stream", "store", "background", "parallel_tool_calls"):
        if key in body and type(body[key]) is not bool:
            invalid()
    if body.get("store", False) or body.get("background", False) or body.get("tools", []) != []:
        invalid()
    if body.get("tool_choice", "none") not in ("none", "auto"):
        invalid()
    # Explicitly prohibit retention; omit no-op tool flags unsupported by providers.
    body["store"] = False
    for key in ("background", "tools", "tool_choice", "parallel_tool_calls"):
        body.pop(key, None)
    validate_messages(body["input" if responses else "messages"], responses)
    if "instructions" in body:
        text(body["instructions"], 64000)
    if "n" in body:
        integer(body["n"], 1, 1)
    for key, high in (("temperature", 2), ("top_p", 1)):
        if key in body and (type(body[key]) not in (int, float) or not 0 <= body[key] <= high):
            invalid()
    token_keys = ("max_output_tokens",) if responses else ("max_tokens", "max_completion_tokens")
    if sum(key in body for key in token_keys) > 1:
        invalid()
    for key in token_keys:
        if key in body:
            integer(body[key], 1, MAX_TOKENS)
    if not any(key in body for key in token_keys):
        body[token_keys[-1]] = MAX_TOKENS
    efforts = ("none", "minimal", "low", "medium", "high", "xhigh")
    if "reasoning" in body:
        fields(body["reasoning"], ("effort",), ("effort",))
        if body["reasoning"]["effort"] not in efforts:
            invalid()
    if "reasoning_effort" in body and body["reasoning_effort"] not in efforts:
        invalid()
    if "text" in body:
        fields(body["text"], ("format", "verbosity"))
        if "verbosity" in body["text"] and body["text"]["verbosity"] not in ("low", "medium", "high"):
            invalid()
        if "format" in body["text"]:
            fields(body["text"]["format"], ("type",), ("type",))
            if body["text"]["format"]["type"] not in ("text", "json_object"):
                invalid()
    if "response_format" in body:
        fields(body["response_format"], ("type",), ("type",))
        if body["response_format"]["type"] not in ("text", "json_object"):
            invalid()
    if "stream_options" in body:
        fields(body["stream_options"], ("include_usage",))
        if "include_usage" in body["stream_options"] and type(body["stream_options"]["include_usage"]) is not bool:
            invalid()


def multipart(raw, content_type, config, path):
    if path != "/v1/images/edits" or len(content_type) > 256 or "\r" in content_type or "\n" in content_type:
        invalid()
    try:
        message = BytesParser(policy=policy.default).parsebytes(
            b"Content-Type: " + content_type.encode("ascii") + b"\r\n\r\n")
    except UnicodeError:
        invalid()
    boundary = message.get_boundary()
    if (not boundary or not re.fullmatch(r"[A-Za-z0-9'()+_,./:=?-]{1,70}", boundary)
            or any(header.defects for header in message.values())
            or message.get_content_type() != "multipart/form-data"):
        invalid()
    body, files = {}, []
    delimiter = b"--" + boundary.encode("ascii")
    if not raw.startswith(delimiter + b"\r\n"):
        invalid()
    cursor, count = len(delimiter) + 2, 0
    while True:
        count += 1
        if count > 40:
            invalid()
        # Parse only bounded part HEADERS with email; its MIME body parser splits
        # binary data into lines and can amplify a malicious 128 MiB upload.
        header_end = raw.find(b"\r\n\r\n", cursor, cursor + 8192)
        if header_end < 0:
            invalid()
        part = BytesParser(policy=policy.default).parsebytes(raw[cursor:header_end] + b"\r\n\r\n")
        end = raw.find(b"\r\n" + delimiter, header_end + 4)
        if end < 0:
            invalid()
        if (part.defects or any(header.defects for header in part.values())
                or part.is_multipart() or part.get_content_disposition() != "form-data"
                or part.get("Content-Transfer-Encoding") is not None
                or len(part.get_all("Content-Disposition", [])) != 1
                or len(part.get_all("Content-Type", [])) > 1
                or any(key.lower() not in ("content-type", "content-disposition") for key in part.keys())):
            invalid()
        name = part.get_param("name", header="content-disposition")
        data = raw[header_end + 4:end]
        if name in ("image", "image[]", "mask"):
            if part.get_filename() is None:
                invalid()
            mime = raster(data, part.get_content_type())
            files.append((name, mime, data))
        else:
            if part.get_filename() is not None or name in body or not name or len(data) > MAX_TEXT:
                invalid()
            try:
                body[name] = data.decode("utf-8")
            except UnicodeError:
                invalid()
        cursor = end + 2 + len(delimiter)
        if raw[cursor:cursor + 2] == b"--":
            if raw[cursor + 2:] not in (b"", b"\r\n"):
                invalid()
            break
        if raw[cursor:cursor + 2] != b"\r\n":
            invalid()
        cursor += 2
    names = [name for name, _, _ in files]
    if (not 1 <= sum(name in ("image", "image[]") for name in names) <= 16
            or names.count("mask") > 1 or names.count("image") > 1
            or ("image" in names and "image[]" in names)):
        invalid()
    for key in ("n", "output_compression"):
        if key in body:
            if not re.fullmatch(r"[0-9]{1,3}", body[key]):
                invalid()
            body[key] = int(body[key])
    n = validate_image(body, path, config, uploaded=True)
    # Rebuild the multipart body; client filenames/part headers never go upstream.
    boundary = "gateway-" + secrets.token_hex(24)
    chunks = []
    for key, value in body.items():
        chunks.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n').encode())
    for name, mime, data in files:
        chunks.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="image"\r\nContent-Type: {mime}\r\n\r\n').encode() + data + b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), "multipart/form-data; boundary=" + boundary, n


def validate_request(raw, content_type, path, config):
    if content_type.lower().startswith("multipart/form-data;"):
        data, mime, count = multipart(raw, content_type, config, path)
        return data, mime, "images", count, False
    if content_type.lower().split(";")[0].strip() != "application/json":
        invalid()
    body = json_loads(raw)
    if not isinstance(body, dict):
        invalid()
    if path.startswith("/v1/images/"):
        count = validate_image(body, path, config)
        kind = "images"
    else:
        validate_text(body, path, config)
        count, kind = 1, "text"
    try:
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
    except UnicodeError:
        invalid()
    return encoded, "application/json", kind, count, body.get("stream", False)


class TimedConnection:
    """A socket timeout alone permits indefinitely trickling response bodies."""

    def __init__(self, connection, seconds):
        self.connection = connection
        self.socket = None
        self.deadline = time.monotonic() + seconds
        self.timer = threading.Timer(seconds, self.abort)
        self.timer.daemon = True
        self.timer.start()

    def abort(self):
        stream = self.socket or self.connection.sock
        if stream is not None:
            try:
                stream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            stream.close()

    def check_deadline(self):
        if time.monotonic() >= self.deadline:
            raise StateError(504, "upstream_timeout", "Model service timed out.")

    def close(self):
        self.timer.cancel()
        self.connection.close()


class Upstream:
    def __init__(self, config):
        self.config = config

    def request(self, path, data, content_type, stream):
        target = urlsplit(self.config.upstream_base_url)
        image = path.startswith("/v1/images/")
        connection = http.client.HTTPSConnection(target.hostname, 443, timeout=600 if image else 180)
        timed = TimedConnection(connection, 610 if image else 300)
        try:
            # The only route is an exact member of MODEL_PATHS. Never urljoin input.
            if path not in MODEL_PATHS:
                invalid()
            connection.connect()
            timed.socket = connection.sock
            timed.check_deadline()
            connection.request("POST", path, body=data, headers={
                "Authorization": "Bearer " + self.config.api_key,
                "Content-Type": content_type,
                "Accept": "text/event-stream" if stream else "application/json",
                "Accept-Encoding": "identity",
            })
            timed.socket = connection.sock
            response = connection.getresponse()
            timed.check_deadline()
            return timed, response
        except BaseException:
            timed.close()
            raise


def sanitize(value, secret):
    """Suppress provider errors and redact exact credentials even in success echoes."""
    if isinstance(value, dict):
        if (value.get("error") or value.get("type") in ("error", "response.failed", "response.error")
                or ("code" in value and type(value["code"]) is int and value["code"] != 0)):
            raise StateError(502, "upstream_error", "Model service request failed.")
        return {k.replace(secret, "[redacted]"): sanitize(v, secret) for k, v in value.items()
                if k.lower() not in ("authorization", "api_key", "headers", "request_headers")}
    if isinstance(value, list):
        return [sanitize(v, secret) for v in value]
    if isinstance(value, str):
        return value.replace(secret, "[redacted]")
    return value


def rewrite_images(value, media, owner):
    if isinstance(value, list):
        return [rewrite_images(v, media, owner) for v in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key in ("url", "image_url") and isinstance(item, str):
                if item.startswith("data:"):
                    try:
                        image_data(item)
                    except StateError:
                        raise StateError(502, "upstream_error", "Model service returned an invalid image.") from None
                    result[key] = item
                    continue
                token = media.register(item, owner)
                if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", token):
                    raise ValueError("Invalid media token")
                result[key] = PREFIX + "/media/" + token
            else:
                result[key] = rewrite_images(item, media, owner)
        return result
    return value


class GatewayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config, state=None, media=None, upstream=None, address=("127.0.0.1", 3180)):
        if address[0] != "127.0.0.1":
            raise ValueError("Gateway may bind only to loopback")
        self.config = config
        self.state = state or State(config)
        if media is None:
            from media import MediaStore
            media = MediaStore(config.state_dir)
        self.media = media
        self.upstream = upstream or Upstream(config)
        from editor import EditorJobs
        self.editor = EditorJobs(self.state, self.media)
        from commerce_policies import CommercePolicies
        self.commerce_policies = CommercePolicies(config)
        self._handler_slots = threading.BoundedSemaphore(24)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        # Bound idle/unauthenticated connection threads below systemd TasksMax.
        if not self._handler_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._handler_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._handler_slots.release()

    def handle_error(self, request, client_address):
        # BaseServer's default traceback may contain credentials or provider bodies.
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ManagedGateway"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(30)
        self._started = False

    def log_message(self, format, *args):
        # Do not log raw request targets, credentials, prompts, headers or failures.
        pass

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"error": {"code": "invalid_http", "message": "Invalid HTTP request."}})

    def headers_start(self, status, mime, length=None, cookie=None):
        self._started = True
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Connection", "close")
        if length is not None:
            self.send_header("Content-Length", str(length))
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)

    def reply(self, status, payload, cookie=None):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        self.headers_start(status, "application/json; charset=utf-8", len(body), cookie)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def one_header(self, name, default=None):
        values = self.headers.get_all(name, [])
        if len(values) > 1:
            invalid()
        return values[0] if values else default

    def token(self):
        raw = self.one_header("Cookie", "")
        if len(raw) > 8192 or sum(p.strip().split("=", 1)[0] == COOKIE for p in raw.split(";")) > 1:
            invalid()
        try:
            cookies = SimpleCookie()
            cookies.load(raw)
            token = cookies[COOKIE].value if COOKIE in cookies else ""
            return token if re.fullmatch(r"[A-Za-z0-9_-]{43}", token) else ""
        except Exception:
            invalid()

    @staticmethod
    def cookie(token=""):
        return (f"{COOKIE}={token}; Path={PREFIX}/; Max-Age={SESSION_TTL if token else 0}; "
                "Secure; HttpOnly; SameSite=Strict")

    def public_status(self, principal):
        result = {"authenticated": principal is not None, "enabled": True}
        if principal:
            result.update(principal={"id": principal["id"], "name": principal["name"]},
                          models=self.server.config.public_models(),
                          defaults={"imageModel": self.server.config.default_image_model,
                                    "textModel": self.server.config.default_text_model},
                          quota=self.server.state.quota(principal))
        return result

    def request_length(self, maximum=MAX_BODY):
        if self.one_header("Transfer-Encoding") is not None or self.one_header("Content-Encoding") is not None:
            invalid()
        length = self.one_header("Content-Length")
        if length is None or not re.fullmatch(r"[0-9]{1,10}", length):
            invalid()
        length = int(length)
        if length > maximum:
            raise StateError(413, "payload_too_large", "Request is too large.")
        return length

    def request_body(self, maximum=MAX_BODY):
        length = self.request_length(maximum)
        def abort():
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        # Nginx buffers uploads, but retain a hard deadline for direct loopback
        # clients; per-read socket timeouts alone do not stop slow trickles.
        timer = threading.Timer(120, abort)
        timer.daemon = True
        timer.start()
        try:
            raw = self.rfile.read(length)
        finally:
            timer.cancel()
        if len(raw) != length:
            invalid()
        return raw

    def check_origin(self):
        config = self.server.config
        if self.one_header("Host") != urlsplit(config.origin).netloc:
            raise StateError(403, "origin_denied", "Request origin is not allowed.")
        origin = self.one_header("Origin")
        if ((self.command == "POST" and origin != config.origin)
                or (origin is not None and origin != config.origin)
                or self.one_header("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none")):
            raise StateError(403, "origin_denied", "Request origin is not allowed.")

    def do_GET(self):
        self.run_request()

    def do_POST(self):
        self.run_request()

    def do_HEAD(self):
        self.run_request()

    do_OPTIONS = do_HEAD
    do_PUT = do_HEAD
    do_DELETE = do_HEAD
    do_PATCH = do_HEAD
    do_TRACE = do_HEAD

    def handle_expect_100(self):
        # Reject Expect early; do not send interim success before authentication.
        self.reply(417, {"error": {"code": "expectation_failed", "message": "Unsupported request expectation."}})
        return False

    def run_request(self):
        try:
            self.check_origin()
            if "?" in self.path or "#" in self.path or not self.path.startswith(PREFIX + "/"):
                invalid()
            path = self.path[len(PREFIX):]
            token = self.token()
            principal = self.server.state.authenticate(token)
            if path == "/session" and self.command == "GET":
                self.reply(200, self.public_status(principal), self.cookie() if not principal else None)
                return
            if path == "/login" and self.command == "POST":
                if self.one_header("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                    invalid()
                # Login bodies get a much smaller bound than image uploads.
                length = self.one_header("Content-Length", "")
                if not re.fullmatch(r"[0-9]{1,5}", length) or int(length) > 4096:
                    invalid()
                body = json_loads(self.request_body())
                fields(body, ("code",), ("code",))
                code = text(body["code"], 128)
                raw_ip = self.one_header("X-Real-IP", self.client_address[0])
                try:
                    ip = str(ipaddress.ip_address(raw_ip))
                except ValueError:
                    invalid()
                token, principal = self.server.state.login(code, ip)
                self.reply(200, self.public_status(principal), self.cookie(token))
                return
            if path == "/logout" and self.command == "POST":
                self.request_body(4096)
                if token:
                    self.server.state.logout(token)
                self.reply(200, {"authenticated": False, "enabled": True}, self.cookie())
                return
            if principal is None:
                raise StateError(401, "authentication_required", "Sign in with your access code.")
            if path == "/commerce-policies" or path.startswith("/commerce-policies/assets/"):
                admin = bool(principal.get("rules_admin", False))
                if path == "/commerce-policies" and self.command == "GET":
                    self.reply(200, self.server.commerce_policies.snapshot(admin))
                    return
                if not admin:
                    raise StateError(403, "rules_admin_required", "需要服务端规则管理员权限。")
                if path.startswith("/commerce-policies/assets/") and self.command == "GET":
                    from commerce_policies import ASSET
                    name = path.rsplit("/", 1)[-1]
                    if not ASSET.fullmatch(name):
                        invalid()
                    asset = self.server.commerce_policies.root / "assets" / name
                    if not asset.is_file():
                        raise StateError(404, "asset_not_found", "规则图片不存在。")
                    data = asset.read_bytes()
                    mime = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}[name.rsplit(".", 1)[-1]]
                    self.headers_start(200, mime, len(data))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                if path == "/commerce-policies" and self.command == "POST":
                    if self.one_header("X-Managed-Principal") != principal["id"]:
                        raise StateError(409, "principal_changed", "Your signed-in user changed. Refresh before trying again.")
                    if self.one_header("Content-Type", "").split(";")[0] != "application/json":
                        invalid()
                    self.reply(200, self.server.commerce_policies.action(json_loads(self.request_body(30 * 1024 * 1024)), principal["id"]))
                    return
                raise StateError(405, "method_not_allowed", "Method is not allowed.")
            if path.startswith("/editor/"):
                if self.one_header("X-Managed-Principal") != principal["id"]:
                    raise StateError(409, "principal_changed", "Your signed-in user changed. Refresh before trying again.")
                if path == "/editor/capabilities" and self.command == "GET":
                    self.reply(200, self.server.editor.capabilities())
                    return
                if path == "/editor/tasks" and self.command == "POST":
                    if self.one_header("Content-Type", "").split(";")[0] != "application/json":
                        invalid()
                    from editor import MAX_REQUEST
                    size = self.request_length(MAX_REQUEST)
                    with self.server.state.admit(token, "images", size):
                        data = json_loads(self.request_body(MAX_REQUEST))
                        self.reply(202, self.server.editor.submit(principal["id"], token, data, image_data))
                    return
                match = re.fullmatch(r"/editor/tasks/([A-Za-z0-9_-]{24})(/cancel)?", path)
                if match and self.command == ("POST" if match[2] else "GET"):
                    if match[2]:
                        self.request_body(4096)
                    self.reply(200, self.server.editor.get(principal["id"], match[1], bool(match[2])))
                    return
                raise StateError(404, "not_found", "Route not found.")
            if path == "/v1/models" and self.command == "GET":
                self.reply(200, {"object": "list", "data": [
                    {"id": item["name"], "object": "model", "capability": item["capability"]}
                    for item in self.server.config.public_models()]})
            elif path.startswith("/media/") and self.command == "GET":
                media_token = path[len("/media/"):]
                if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", media_token):
                    raise StateError(404, "media_unavailable", "Image is unavailable.")
                try:
                    data, mime = self.server.media.fetch(media_token, principal["id"])
                    if mime not in RASTER_TYPES or not isinstance(data, bytes) or len(data) > MAX_BODY:
                        raise ValueError("Invalid media")
                except Exception as exc:
                    status = getattr(exc, "status", 502)
                    status = status if status in (404, 413, 502, 503, 504) else 502
                    raise StateError(status, "media_unavailable", "Image is unavailable.") from None
                if not self.server.state.authenticate(token):
                    raise StateError(401, "authentication_required", "Sign in with your access code.")
                self.headers_start(200, mime, len(data))
                self.end_headers()
                self.wfile.write(data)
            elif path in MODEL_PATHS and self.command == "POST":
                if self.one_header("X-Managed-Principal") != principal["id"]:
                    raise StateError(409, "principal_changed", "Your signed-in user changed. Refresh before trying again.")
                size = self.request_length()
                kind = "images" if path.startswith("/v1/images/") else "text"
                with self.server.state.admit(token, kind, size):
                    raw = self.request_body()
                    data, mime, kind, count, stream = validate_request(raw, self.one_header("Content-Type", ""), path, self.server.config)
                    del raw
                    with self.server.state.reserve(token, kind, count) as owner:
                        self.relay(path, data, mime, stream, owner["id"])
            elif path in MODEL_PATHS or path in ("/login", "/logout", "/session", "/v1/models") or path.startswith("/media/"):
                raise StateError(405, "method_not_allowed", "Method is not allowed.")
            else:
                raise StateError(404, "not_found", "Route not found.")
        except StateError as exc:
            if not self._started:
                self.reply(exc.status, {"error": {"code": exc.code, "message": exc.message}})
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            if not self._started:
                self.reply(504, {"error": {"code": "upstream_timeout", "message": "Model service timed out."}})
        except Exception:
            if not self._started:
                self.reply(502, {"error": {"code": "gateway_error", "message": "Model service is unavailable."}})

    def relay(self, path, data, mime, stream, owner):
        connection = response = None
        try:
            connection, response = self.server.upstream.request(path, data, mime, stream)
            status = response.status
            if status in (401, 403):
                raise StateError(502, "server_configuration", "Model service configuration error. Contact the administrator.")
            if status != 200:
                mapped = status if status in (400, 413, 422, 429) else 502
                raise StateError(mapped, "upstream_error", "Model service request failed.")
            encoding = response.getheader("Content-Encoding", "identity")
            if encoding not in ("identity", ""):
                raise StateError(502, "upstream_error", "Model service returned an invalid response.")
            content_type = response.getheader("Content-Type", "").split(";")[0].strip().lower()
            if stream and content_type == "text/event-stream":
                self.relay_sse(response)
                return
            if content_type != "application/json":
                raise StateError(502, "upstream_error", "Model service returned an invalid response.")
            raw = response.read(MAX_BODY + 1)
            if hasattr(connection, "check_deadline"):
                connection.check_deadline()
            if len(raw) > MAX_BODY:
                raise StateError(502, "upstream_error", "Model service response is too large.")
            try:
                payload = json_loads(raw)
            except StateError:
                raise StateError(502, "upstream_error", "Model service returned an invalid response.") from None
            if not isinstance(payload, dict):
                raise StateError(502, "upstream_error", "Model service returned an invalid response.")
            payload = sanitize(payload, self.server.config.api_key)
            if path.startswith("/v1/images/"):
                payload = rewrite_images(payload, self.server.media, owner)
            if hasattr(connection, "check_deadline"):
                connection.check_deadline()
            self.reply(200, payload)
        finally:
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()

    def relay_sse(self, response):
        self.headers_start(200, "text/event-stream; charset=utf-8")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        size, event, total, completed = 0, [], 0, False
        started = time.monotonic()
        try:
            while True:
                line = response.readline(MAX_EVENT + 1)
                total += len(line)
                size += len(line)
                if size > MAX_EVENT or total > 16 * MAX_TEXT or time.monotonic() - started > 300:
                    raise ValueError("Stream limit")
                if line not in (b"\n", b"\r\n", b""):
                    event.append(line)
                    continue
                if event:
                    completed = self.sse_event(event) or completed
                    event, size = [], 0
                else:
                    size = 0
                if not line:
                    if not completed:
                        raise ValueError("Incomplete stream")
                    break
        except (BrokenPipeError, ConnectionResetError):
            raise
        except Exception:
            self.chunk(b'event: error\ndata: {"type":"error","error":{"code":"upstream_error","message":"Model service stream failed."}}\n\n')
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def sse_event(self, lines):
        values = []
        event_type = None
        for raw in lines:
            line = raw.decode("utf-8").rstrip("\r\n")
            if line.startswith("data:"):
                values.append(line[5:].lstrip(" "))
            elif line.startswith("event:"):
                event_type = line[6:].strip()
                if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", event_type):
                    raise ValueError("Invalid event")
        if not values:
            return
        data = "\n".join(values)
        completed = data == "[DONE]"
        if event_type in ("error", "response.failed", "response.error"):
            raise ValueError("Upstream event error")
        if data != "[DONE]":
            value = sanitize(json_loads(data), self.server.config.api_key)
            if isinstance(value, dict) and value.get("type") in ("response.completed", "response.incomplete"):
                completed = True
            data = json.dumps(value, ensure_ascii=False, allow_nan=False)
        prefix = "event: " + event_type + "\n" if event_type else ""
        self.chunk((prefix + "data: " + data + "\n\n").encode())
        return completed

    def chunk(self, data):
        # Bound individual writes while retaining valid HTTP chunk framing.
        for start in range(0, len(data), 16384):
            part = data[start:start + 16384]
            self.wfile.write(f"{len(part):x}\r\n".encode() + part + b"\r\n")
        self.wfile.flush()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Loopback managed model gateway")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    args = parser.parse_args(argv)
    if os.name == "posix":
        os.umask(0o077)
    try:
        server = GatewayServer(load_config(args.config))
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    except Exception:
        print("Gateway failed to start. Check private configuration and service permissions.", file=sys.stderr)
        return 1
    finally:
        if "server" in locals():
            server.server_close()


if __name__ == "__main__":
    sys.exit(main())
