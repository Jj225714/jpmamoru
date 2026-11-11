import base64
import contextlib
import http.client
import io
import json
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from config import Config
from server import COOKIE, MAX_BODY, MAX_EVENT, MODEL_PATHS, PREFIX, GatewayServer, TimedConnection, Upstream, validate_request
from state import SESSION_TTL, State, StateError

PNG = b"\x89PNG\r\n\x1a\n" + b"test-image"
JPEG = b"\xff\xd8\xff\xe0JFIF\x00" + b"test-image"
DATA_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()
SECRET = "provider-key-must-never-appear"


class FakeResponse(io.BytesIO):
    def __init__(self, body=b'{"output_text":"hello"}', status=200, mime="application/json", extra=None):
        super().__init__(body)
        self.status = status
        self.headers = {"Content-Type": mime, **(extra or {})}
        self.read_sizes = []

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def readline(self, size=-1):
        self.read_sizes.append(size)
        return super().readline(size)


class FakeConnection:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class FakeUpstream:
    def __init__(self):
        self.calls = []
        self.make_response = lambda: FakeResponse()
        self.last_connection = None

    def request(self, *args):
        self.calls.append(args)
        self.last_connection = FakeConnection()
        return self.last_connection, self.make_response()


class MediaFailure(Exception):
    def __init__(self, status):
        self.status = status
        super().__init__(SECRET)


class FakeMedia:
    def __init__(self):
        self.items = {}

    def register(self, url, owner):
        token = "opaque_" + str(len(self.items)).zfill(36)
        self.items[token] = (url, owner)
        return token

    def fetch(self, token, owner):
        if token not in self.items or self.items[token][1] != owner:
            raise MediaFailure(404)
        return PNG, "image/png"


def multipart_body(fields, files=None):
    boundary = "test-boundary"
    chunks = []
    for name, value in fields:
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for name, mime, data in (files or []):
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="unsafe-client-name.png"\r\nContent-Type: {mime}\r\n\r\n'.encode() + data + b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), "multipart/form-data; boundary=" + boundary


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.config = Config("https://canvas.example", "https://bm.example/v1", SECRET, state_dir=self.directory.name)
        self.state = State(self.config)
        self.owner, self.code = self.state.create_code("用户01")
        self.token, self.principal = self.state.login(self.code, "192.0.2.1")
        self.media, self.upstream = FakeMedia(), FakeUpstream()
        self.server = GatewayServer(self.config, self.state, self.media, self.upstream, address=("127.0.0.1", 0))
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.02), daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.directory.cleanup()

    def request(self, path, method="GET", body=None, auth=True, headers=None):
        request_headers = {"Host": "canvas.example", "Origin": self.config.origin}
        if auth:
            request_headers["Cookie"] = COOKIE + "=" + self.token
        if method == "POST" and path in MODEL_PATHS:
            request_headers["X-Managed-Principal"] = self.owner
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            request_headers["Content-Type"] = "application/json"
        if method == "POST" and body is None:
            body = b""
        request_headers.update(headers or {})
        request_headers = {key: value for key, value in request_headers.items() if value is not None}
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            conn.request(method, PREFIX + path, body, request_headers)
            response = conn.getresponse()
            result = response.status, dict(response.getheaders()), response.read()
            return result
        finally:
            conn.close()

    def image(self, **extra):
        return {"model": "gpt-image-2", "prompt": "A basket", **extra}

    def test_commerce_policy_http_permissions_revision_and_revocation(self):
        path = "/commerce-policies"
        self.assertEqual(self.request(path, auth=False)[0], 401)
        status, _, raw = self.request(path)
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(raw)["canManage"])
        self.assertNotIn("draft", json.loads(raw))
        headers = {"X-Managed-Principal": self.owner}
        body = {"action": "save", "revision": 0, "package": {"name": "unfinished draft"}}
        self.assertEqual(self.request(path, "POST", body, headers=headers)[0], 403)
        self.state.set_rules_admin(self.owner, True)
        self.assertEqual(self.request(path, "POST", body)[0], 409)
        self.assertEqual(self.request(path, "POST", body, headers={**headers, "Origin": "https://other.example"})[0], 403)
        status, _, raw = self.request(path, "POST", body, headers=headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["revision"], 1)
        self.assertEqual(self.request(path, "POST", body, headers=headers)[0], 409)
        status, _, raw = self.request(path, "POST", {"action": "validate"}, headers=headers)
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(raw)["valid"])
        self.state.set_rules_admin(self.owner, False)
        self.assertEqual(self.request(path, "POST", {"action": "publish", "revision": 1}, headers=headers)[0], 403)
        self.assertEqual(self.upstream.calls, [])

    def test_commerce_uploaded_examples_are_private_until_publication(self):
        from PIL import Image
        self.state.set_rules_admin(self.owner, True)
        data = io.BytesIO()
        Image.new("RGB", (3, 3), "white").save(data, format="PNG")
        body = {"action": "upload", "dataUrl": "data:image/png;base64," + base64.b64encode(data.getvalue()).decode()}
        status, _, raw = self.request("/commerce-policies", "POST", body, headers={"X-Managed-Principal": self.owner})
        self.assertEqual(status, 200)
        asset = json.loads(raw)["asset"]
        path = asset["url"][len(PREFIX):]
        self.assertEqual(self.request(path, auth=False)[0], 401)
        status, _, payload = self.request(path)
        self.assertEqual(status, 200)
        self.assertEqual(payload, data.getvalue())
        self.state.set_rules_admin(self.owner, False)
        self.assertEqual(self.request(path)[0], 403)
        self.assertEqual(self.upstream.calls, [])

    def test_editor_routes_require_session_principal_and_origin(self):
        self.assertEqual(self.request("/editor/capabilities", auth=False)[0], 401)
        self.assertEqual(self.request("/editor/capabilities")[0], 409)
        headers = {"X-Managed-Principal": self.owner}
        self.server.editor.fal = ""
        status, _, body = self.request("/editor/capabilities", headers=headers)
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(body)["operations"]["erase"]["enabled"])
        self.assertNotIn(SECRET.encode(), body)
        self.assertEqual(self.request("/editor/tasks", "POST", {}, headers={**headers, "Origin": "https://other.example"})[0], 403)

    def test_editor_http_idempotency_and_private_results(self):
        import struct
        image = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR" + struct.pack(">II", 64, 32)).decode()
        payload = dict(operation="layers", image=image, width=64, height=32, documentId="draft", revision=7, idempotencyKey="same")
        headers = {"X-Managed-Principal": self.owner}
        self.server.editor.fal = "editor-test-secret"
        with patch.object(self.server.editor, "fal_run", return_value={"images": [{"url": "private"}]}) as provider:
            status, _, body = self.request("/editor/tasks", "POST", payload, headers=headers)
            self.assertEqual(status, 202)
            job = json.loads(body)
            status, _, repeated = self.request("/editor/tasks", "POST", payload, headers=headers)
            self.assertEqual(status, 202)
            self.assertEqual(json.loads(repeated)["id"], job["id"])
            for _ in range(30):
                status, _, result = self.request("/editor/tasks/" + job["id"], headers=headers)
                if json.loads(result)["status"] == "succeeded":
                    break
                time.sleep(.01)
            self.assertEqual(json.loads(result)["revision"], 7)
            self.assertEqual(provider.call_count, 1)
            other_owner, code = self.state.create_code("other")
            other_token, _ = self.state.login(code, "192.0.2.2")
            other_headers = {"X-Managed-Principal": other_owner, "Cookie": COOKIE + "=" + other_token}
            self.assertEqual(self.request("/editor/tasks/" + job["id"], headers=other_headers)[0], 404)
            self.assertEqual(self.request("/editor/tasks/" + job["id"] + "/cancel", "POST", {}, headers=other_headers)[0], 404)

    def text(self, **extra):
        return {"model": "gpt-5.5", "input": [{"role": "user", "content": "Hello"}], **extra}

    def test_login_status_cookie_and_logout(self):
        result = self.request("/session", auth=False)
        self.assertEqual(json.loads(result[2]), {"authenticated": False, "enabled": True})
        result = self.request("/login", "POST", {"code": self.code}, auth=False)
        self.assertEqual(result[0], 200)
        cookie = result[1]["Set-Cookie"]
        for attribute in ("Secure", "HttpOnly", "SameSite=Strict", "Path=/api/managed/", "Max-Age=43200"):
            self.assertIn(attribute, cookie)
        status = json.loads(result[2])
        self.assertEqual(status["principal"], {"id": self.owner, "name": "用户01"})
        self.assertEqual(status["defaults"], {"imageModel": "gpt-image-2", "textModel": "gpt-5.5"})
        self.assertEqual(status["quota"]["images"]["limit"], 20)
        for secret in (self.code, self.token, SECRET, "code_hash", "upstream_base_url"):
            self.assertNotIn(secret, result[2].decode())
        result = self.request("/logout", "POST")
        self.assertEqual(result[0], 200)
        self.assertIn("Max-Age=0", result[1]["Set-Cookie"])
        self.assertEqual(self.request("/v1/models")[0], 401)

    def test_logout_is_idempotent_for_missing_expired_and_disabled_sessions(self):
        for session in ("missing", "expired", "disabled"):
            with self.subTest(session=session):
                if session == "expired":
                    self.state.clock = lambda: time.time() + SESSION_TTL + 1
                elif session == "disabled":
                    self.state.clock = time.time
                    self.state.disable(self.owner)
                for _ in range(2):
                    status, headers, raw = self.request("/logout", "POST", auth=session != "missing")
                    self.assertEqual(status, 200)
                    self.assertEqual(json.loads(raw), {"authenticated": False, "enabled": True})
                    cookie = headers["Set-Cookie"]
                    for attribute in (COOKIE + "=;", "Max-Age=0", "Secure", "HttpOnly", "SameSite=Strict", "Path=/api/managed/"):
                        self.assertIn(attribute, cookie)
                if session != "missing":
                    self.assertIsNone(self.state.authenticate(self.token))
        self.assertEqual(self.upstream.calls, [])

    def test_anonymous_logout_retains_origin_and_body_limits(self):
        for headers in ({"Origin": None}, {"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("/logout", "POST", auth=False, headers=headers)[0], 403)
        self.assertEqual(self.request("/logout", "POST", b"x" * 4097, auth=False)[0], 413)

    def test_all_protected_routes_authenticate_and_disable(self):
        for path, method in (("/v1/models", "GET"), ("/v1/images/generations", "POST"),
                             ("/v1/images/edits", "POST"), ("/v1/responses", "POST"),
                             ("/v1/chat/completions", "POST"), ("/media/" + "x" * 43, "GET")):
            self.assertEqual(self.request(path, method, auth=False)[0], 401)
        self.state.disable(self.owner)
        self.assertFalse(json.loads(self.request("/session")[2])["authenticated"])
        self.assertEqual(self.request("/v1/models")[0], 401)
        self.assertEqual(self.request("/media/" + "x" * 43)[0], 401)
        self.assertEqual(self.request("/v1/responses", "POST", self.text())[0], 401)
        self.assertEqual(self.upstream.calls, [])

    def test_expired_session_fails(self):
        self.state.clock = lambda: time.time() + SESSION_TTL + 1
        self.assertEqual(self.request("/v1/models")[0], 401)
        self.assertFalse(json.loads(self.request("/session")[2])["authenticated"])

    def test_exact_origin_host_and_fetch_metadata(self):
        for headers in ({"Origin": None}, {"Origin": "null"}, {"Origin": "https://evil.example"},
                        {"Origin": self.config.origin + "/"}, {"Host": "alternate.example"},
                        {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("/login", "POST", {"code": self.code}, auth=False, headers=headers)[0], 403)
                self.assertEqual(self.request("/v1/responses", "POST", self.text(), headers=headers)[0], 403)
        self.assertEqual(self.request("/session", headers={"Host": "other.example"})[0], 403)
        self.assertEqual(self.request("/session", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.upstream.calls, [])

    def test_routes_queries_methods_and_no_cors(self):
        for path in ("/v1/models?target=https://evil.example", "/v1/responses?x=1", "/media/x?url=https://evil.example"):
            self.assertEqual(self.request(path)[0], 400)
        for path in ("/v1/embeddings", "/v1/responses/abc", "/v1/../responses", "/v1/%72esponses"):
            self.assertEqual(self.request(path, "POST", self.text())[0], 404)
        for method in ("GET", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "TRACE"):
            result = self.request("/v1/responses", method)
            self.assertEqual(result[0], 405)
            self.assertFalse(any(key.lower().startswith("access-control") for key in result[1]))
        self.assertEqual(self.upstream.calls, [])

    def test_readonly_models_are_allowlisted_no_provider_call(self):
        status, _, raw = self.request("/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in json.loads(raw)["data"]], ["gpt-image-2", "gpt-5.5"])
        self.assertEqual(self.upstream.calls, [])

    def test_paid_routes_require_matching_principal_before_body_or_admission(self):
        with patch.object(self.state, "admit", side_effect=AssertionError("Must not admit")):
            for path in MODEL_PATHS:
                for value in (None, "wrong-principal", self.owner.upper(), self.owner + "," + self.owner):
                    with self.subTest(path=path, value=value):
                        result = self.request(path, "POST", b"invalid-json", headers={"X-Managed-Principal": value})
                        self.assertEqual(result[0], 409)
                        self.assertEqual(json.loads(result[2])["error"]["code"], "principal_changed")
        self.assertEqual(self.upstream.calls, [])
        self.assertEqual(self.state.quota(self.principal)["images"]["used"], 0)
        self.assertEqual(self.state.quota(self.principal)["text"]["used"], 0)

    def test_cookie_switch_cannot_bill_new_principal_for_old_tab_request(self):
        _, code = self.state.create_code("用户02")
        token, principal = self.state.login(code, "192.0.2.2")
        for path in MODEL_PATHS:
            result = self.request(path, "POST", self.image(), headers={"Cookie": COOKIE + "=" + token})
            self.assertEqual(result[0], 409)
            self.assertEqual(json.loads(result[2])["error"]["code"], "principal_changed")
        for owner in (self.principal, principal):
            self.assertEqual(self.state.quota(owner)["images"]["used"], 0)
            self.assertEqual(self.state.quota(owner)["text"]["used"], 0)
        self.assertEqual(self.upstream.calls, [])

    def test_principal_mismatch_and_duplicates_rejected_without_reading_body(self):
        for value, extra, expected in (("wrong-principal", "", 409),
                                       (None, "", 409),
                                       (self.owner, "X-Managed-Principal: " + self.owner + "\r\n", 400)):
            with self.raw_connection("/v1/responses", MAX_BODY, self.token, extra, principal=value) as conn:
                response = http.client.HTTPResponse(conn)
                response.begin()
                self.assertEqual(response.status, expected)
                response.read()
        self.assertEqual(self.state._admitted, 0)
        self.assertEqual(self.state.quota(self.principal)["text"]["used"], 0)
        self.assertEqual(self.upstream.calls, [])

    def test_image_validation_before_quota(self):
        cases = [self.image(n=value) for value in (0, 16, -1, True, "2", 1.5)]
        cases += [self.image(model="arbitrary-paid-model"), self.image(model=["gpt-image-2"]),
                  self.image(url="https://evil.example"), self.image(async_=True), self.image(tools=[]),
                  self.image(size="9999x9999"), self.image(prompt=""), self.image(quality="ultra")]
        for body in cases:
            with self.subTest(body=body):
                self.assertEqual(self.request("/v1/images/generations", "POST", body)[0], 400)
        self.assertEqual(self.upstream.calls, [])
        self.assertEqual(self.state.quota(self.principal)["images"]["used"], 0)

    def test_duplicate_json_keys_and_nonfinite_numbers_rejected(self):
        for raw in (b'{"model":"gpt-image-2","model":"evil","prompt":"x"}',
                    b'{"model":"gpt-image-2","prompt":"x","n":1,"n":15}',
                    b'{"model":"gpt-image-2","prompt":"x","n":NaN}'):
            self.assertEqual(self.request("/v1/images/generations", "POST", raw, headers={"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.upstream.calls, [])

    def test_image_charge_count_and_rewrite_only_url_fields(self):
        source = {"data": [{"url": "https://images.example/generated.png", "revised_prompt": "https://example.com is text"},
                           {"b64_json": "abc", "image_url": {"url": "https://images.example/second.png"}}]}
        self.upstream.make_response = lambda: FakeResponse(json.dumps(source).encode())
        status, _, raw = self.request("/v1/images/generations", "POST", self.image(n=2))
        self.assertEqual(status, 200)
        result = json.loads(raw)
        self.assertTrue(result["data"][0]["url"].startswith(PREFIX + "/media/"))
        self.assertEqual(result["data"][0]["revised_prompt"], source["data"][0]["revised_prompt"])
        self.assertEqual(result["data"][1]["b64_json"], "abc")
        self.assertEqual(len(self.media.items), 2)
        self.assertEqual(self.state.quota(self.principal)["images"]["used"], 2)
        self.assertEqual(json.loads(self.upstream.calls[0][1])["n"], 2)
        media_path = result["data"][0]["url"][len(PREFIX):]
        fetched = self.request(media_path)
        self.assertEqual(fetched[0], 200)
        self.assertEqual(fetched[2], PNG)
        self.assertEqual(fetched[1]["X-Content-Type-Options"], "nosniff")
        self.assertEqual(fetched[1]["Cache-Control"], "no-store")
        _, code = self.state.create_code("用户02")
        second, _ = self.state.login(code, "192.0.2.2")
        self.assertEqual(self.request(media_path, headers={"Cookie": COOKIE + "=" + second})[0], 404)

    def test_media_errors_generic_and_no_arbitrary_url(self):
        self.assertEqual(self.request("/media/https://evil.example")[0], 404)
        for status in (404, 502, 503, 504):
            with patch.object(self.media, "fetch", side_effect=MediaFailure(status)):
                result = self.request("/media/" + "x" * 43)
                self.assertEqual(result[0], status)
                self.assertNotIn(SECRET.encode(), result[2])

    def test_inline_image_response_urls_validated_without_media_registration(self):
        self.upstream.make_response = lambda: FakeResponse(json.dumps({"data": [{"url": DATA_URL}]}).encode())
        result = self.request("/v1/images/generations", "POST", self.image())
        self.assertEqual(result[0], 200)
        self.assertEqual(json.loads(result[2])["data"][0]["url"], DATA_URL)
        self.assertEqual(self.media.items, {})
        for url in ("data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,ZmFrZQ=="):
            self.upstream.make_response = lambda: FakeResponse(json.dumps({"data": [{"url": url}]}).encode())
            result = self.request("/v1/images/generations", "POST", self.image())
            self.assertEqual(result[0], 502)
        self.assertEqual(self.media.items, {})

    def test_json_edit_validates_inline_images(self):
        self.assertEqual(self.request("/v1/images/edits", "POST", self.image(image=DATA_URL))[0], 200)
        self.assertEqual(self.request("/v1/images/edits", "POST", self.image(image="https://internal.example/x"))[0], 400)
        self.assertEqual(self.request("/v1/images/edits", "POST", self.image(image=DATA_URL, images=[DATA_URL]))[0], 400)
        self.assertEqual(len(self.upstream.calls), 1)

    def test_multipart_reconstructed_and_repeated_images_allowed(self):
        raw, mime = multipart_body([("model", "gpt-image-2"), ("prompt", "test"), ("n", "2")],
                                  [("image[]", "image/png", PNG), ("image[]", "image/png", PNG)])
        self.assertEqual(self.request("/v1/images/edits", "POST", raw, headers={"Content-Type": mime})[0], 200)
        forwarded = self.upstream.calls[0]
        self.assertNotIn(b"unsafe-client-name", forwarded[1])
        self.assertNotEqual(forwarded[2], mime)
        self.assertEqual(forwarded[1].count(b'name="image[]"'), 2)
        self.assertEqual(self.state.quota(self.principal)["images"]["used"], 2)

    def test_multipart_repairs_stale_declared_raster_mime(self):
        raw, mime = multipart_body([("model", "gpt-image-2"), ("prompt", "test")],
                                  [("image", "image/png", JPEG)])
        self.assertEqual(self.request("/v1/images/edits", "POST", raw, headers={"Content-Type": mime})[0], 200)
        forwarded = self.upstream.calls[0][1]
        self.assertIn(b"Content-Type: image/jpeg", forwarded)
        self.assertNotIn(b"Content-Type: image/png", forwarded)

    def test_multipart_binary_newlines_never_enter_email_body_parser(self):
        raw, mime = multipart_body([("model", "gpt-image-2"), ("prompt", "test")],
                                  [("image", "image/png", PNG + b"\n" * 100000)])
        from email.parser import BytesParser
        original = BytesParser.parsebytes
        parsed_lengths = []

        def inspect(parser, data, *args, **kwargs):
            parsed_lengths.append(len(data))
            return original(parser, data, *args, **kwargs)

        with patch.object(BytesParser, "parsebytes", inspect):
            self.assertEqual(self.request("/v1/images/edits", "POST", raw, headers={"Content-Type": mime})[0], 200)
        self.assertTrue(parsed_lengths)
        self.assertLess(max(parsed_lengths), 8192)

    def test_multipart_ambiguity_unknown_fields_and_nonimages_denied(self):
        base = [("model", "gpt-image-2"), ("prompt", "test"), ("n", "1")]
        for extra in (("model", "gpt-image-2"), ("n", "15"), ("url", "https://evil.example"), ("async", "true")):
            raw, mime = multipart_body(base + [extra], [("image", "image/png", PNG)])
            self.assertEqual(self.request("/v1/images/edits", "POST", raw, headers={"Content-Type": mime})[0], 400)
        raw, mime = multipart_body(base, [("image", "image/svg+xml", b"<svg/>")])
        self.assertEqual(self.request("/v1/images/edits", "POST", raw, headers={"Content-Type": mime})[0], 400)
        raw, mime = multipart_body(base, [("image", "image/png", PNG)])
        raw = raw.replace(b'name="model"', b'name="model"; name="n"')
        self.assertEqual(self.request("/v1/images/edits", "POST", raw, headers={"Content-Type": mime})[0], 400)
        raw, mime = multipart_body(base, [("image", "image/png", PNG)])
        raw = raw.replace(b'Content-Disposition: form-data; name="model"', b'Content-Disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="n"')
        self.assertEqual(self.request("/v1/images/edits", "POST", raw, headers={"Content-Type": mime})[0], 400)
        self.assertEqual(self.upstream.calls, [])
        self.assertEqual(self.state.quota(self.principal)["images"]["used"], 0)

    def test_text_paid_extras_and_bounded_output(self):
        cases = ({"tools": [{"type": "web_search"}]}, {"tools": [{"type": "image_generation"}]},
                 {"background": True}, {"store": True}, {"previous_response_id": "other"},
                 {"max_output_tokens": 8193}, {"max_output_tokens": True}, {"service_tier": "priority"},
                 {"input": [{"type": "function_call", "name": "code_interpreter"}]},
                 {"input": [{"role": "user", "content": [{"type": "input_file", "file_id": "secret"}]}]})
        for extra in cases:
            with self.subTest(extra=extra):
                self.assertEqual(self.request("/v1/responses", "POST", self.text(**extra))[0], 400)
        self.assertEqual(self.upstream.calls, [])
        body = self.text(tools=[], tool_choice="auto", background=False, reasoning={"effort": "high"})
        self.assertEqual(self.request("/v1/responses", "POST", body)[0], 200)
        forwarded = json.loads(self.upstream.calls[0][1])
        self.assertIs(forwarded["store"], False)
        self.assertEqual(forwarded["max_output_tokens"], 8192)
        self.assertNotIn("tools", forwarded)
        self.assertNotIn("background", forwarded)
        self.assertEqual(forwarded["reasoning"], {"effort": "high"})

    def test_vision_and_chat(self):
        vision = self.text(input=[{"role": "user", "content": [
            {"type": "input_text", "text": "Describe"}, {"type": "input_image", "image_url": DATA_URL}]}])
        self.assertEqual(self.request("/v1/responses", "POST", vision)[0], 200)
        chat = {"model": "gpt-5.5", "messages": [{"role": "user", "content": [
            {"type": "text", "text": "Describe"}, {"type": "image_url", "image_url": {"url": DATA_URL}}]}]}
        self.assertEqual(self.request("/v1/chat/completions", "POST", chat)[0], 200)
        forwarded = json.loads(self.upstream.calls[-1][1])
        self.assertEqual(forwarded["max_completion_tokens"], 8192)
        for extras in ({"n": 2}, {"max_tokens": 10000}, {"audio": {}}, {"modalities": ["audio"]}):
            self.assertEqual(self.request("/v1/chat/completions", "POST", {**chat, **extras})[0], 400)

    def test_upstream_auth_errors_generic_no_headers_no_retries_or_refunds(self):
        for upstream_status in (401, 403, 302, 500):
            with self.subTest(status=upstream_status):
                self.upstream.make_response = lambda: FakeResponse(SECRET.encode(), upstream_status, extra={"Authorization": SECRET, "Location": "https://evil.example"})
                result = self.request("/v1/responses", "POST", self.text())
                self.assertEqual(result[0], 502)
                self.assertNotIn(SECRET, result[2].decode() + str(result[1]))
                self.assertNotIn("Location", result[1])
                if upstream_status in (401, 403):
                    self.assertEqual(json.loads(result[2])["error"]["code"], "server_configuration")
        self.assertEqual(len(self.upstream.calls), 4)
        self.assertEqual(self.state.quota(self.principal)["text"]["used"], 4)
        self.assertTrue(self.upstream.last_connection.closed)

    def test_transport_failure_keeps_charge_and_releases_admission(self):
        with patch.object(self.upstream, "request", side_effect=OSError(SECRET)) as call:
            result = self.request("/v1/images/generations", "POST", self.image(n=3))
        self.assertEqual(result[0], 502)
        self.assertNotIn(SECRET.encode(), result[2])
        call.assert_called_once()
        self.assertEqual(self.state.quota(self.principal)["images"]["used"], 3)
        self.assertEqual(self.state._admitted, 0)
        self.assertEqual(self.state._active, 0)
        self.assertEqual(self.request("/v1/images/generations", "POST", self.image())[0], 200)

    def test_body_error_even_with_http_200_is_redacted_and_success_echo_redacted(self):
        for payload in ({"error": {"message": SECRET}}, {"code": 1, "msg": SECRET}, {"response": {"error": {"message": SECRET}}}):
            self.upstream.make_response = lambda: FakeResponse(json.dumps(payload).encode())
            result = self.request("/v1/responses", "POST", self.text())
            self.assertEqual(result[0], 502)
            self.assertNotIn(SECRET.encode(), result[2])
        self.upstream.make_response = lambda: FakeResponse(json.dumps({"output_text": SECRET, "api_key": SECRET}).encode())
        result = self.request("/v1/responses", "POST", self.text())
        self.assertEqual(result[0], 200)
        self.assertNotIn(SECRET.encode(), result[2])
        self.assertNotIn(b"api_key", result[2])

    def test_sse_http_framing_bounded_events_and_errors_redacted(self):
        raw = (b'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"hello"}\r\n\r\n'
               b'event: response.completed\ndata: {"type":"response.completed","response":{"output_text":"hello"}}\n\n'
               b'data: [DONE]\n\n')
        response = FakeResponse(raw, mime="text/event-stream")
        self.upstream.make_response = lambda: response
        status, headers, body = self.request("/v1/responses", "POST", self.text(stream=True))
        self.assertEqual(status, 200)
        self.assertEqual(headers["Transfer-Encoding"], "chunked")
        self.assertNotIn("Content-Length", headers)
        self.assertEqual(headers["X-Accel-Buffering"], "no")
        self.assertIn(b'"delta": "hello"', body)
        self.assertIn(b"data: [DONE]", body)
        self.assertTrue(all(size == MAX_EVENT + 1 for size in response.read_sizes))
        error = json.dumps({"type": "response.failed", "response": {"error": {"message": SECRET}}}).encode()
        self.upstream.make_response = lambda: FakeResponse(b"data: " + error + b"\n\n", mime="text/event-stream")
        result = self.request("/v1/responses", "POST", self.text(stream=True))
        self.assertIn(b"Model service stream failed", result[2])
        self.assertNotIn(SECRET.encode(), result[2])

    def test_sse_oversize_event_is_bounded_and_slot_released(self):
        self.upstream.make_response = lambda: FakeResponse(b"data: " + b"x" * MAX_EVENT + b"\n\n", mime="text/event-stream")
        result = self.request("/v1/responses", "POST", self.text(stream=True))
        self.assertLess(len(result[2]), 1024)
        self.assertIn(b"stream failed", result[2])
        self.wait_admitted(0)
        self.assertEqual(self.state._active, 0)
        self.assertEqual(self.state._admitted, 0)

    def test_sse_truncation_and_event_error_without_json_type_are_generic(self):
        streams = [b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
                   b'event: error\ndata: {"message":"raw provider diagnostics must not escape"}\n\n']
        for stream in streams:
            self.upstream.make_response = lambda: FakeResponse(stream, mime="text/event-stream")
            result = self.request("/v1/responses", "POST", self.text(stream=True))
            self.assertIn(b"stream failed", result[2])
            self.assertNotIn(b"raw provider diagnostics", result[2])

    def test_upstream_unexpected_content_and_malformed_json(self):
        for mime, body, extra in (("text/html", SECRET.encode(), {}),
                                  ("application/json", SECRET.encode(), {}),
                                  ("application/json", b"[]", {}),
                                  ("application/json", b'{}', {"Content-Encoding": "gzip"})):
            self.upstream.make_response = lambda: FakeResponse(body, mime=mime, extra=extra)
            result = self.request("/v1/responses", "POST", self.text())
            self.assertEqual(result[0], 502)
            self.assertNotIn(SECRET.encode(), result[2])

    def test_json_allocation_amplification_rejected_before_dispatch(self):
        raw = b'{"model":"gpt-5.5","input":[' + b'{},' * 20001 + b'{}]}'
        result = self.request("/v1/responses", "POST", raw, headers={"Content-Type": "application/json"})
        self.assertEqual(result[0], 400)
        self.assertEqual(self.upstream.calls, [])
        self.assertEqual(self.state.quota(self.principal)["text"]["used"], 0)

    def test_handler_concurrency_rejects_second_image_without_charging(self):
        entered, release = threading.Event(), threading.Event()
        results = []

        def block_response():
            entered.set()
            if not release.wait(3):
                raise RuntimeError("test deadline")
            return FakeResponse(b'{"data":[]}')

        self.upstream.make_response = block_response
        first = threading.Thread(target=lambda: results.append(self.request("/v1/images/generations", "POST", self.image(n=2))))
        first.start()
        try:
            self.assertTrue(entered.wait(3))
            second = self.request("/v1/images/generations", "POST", self.image(n=3))
            self.assertEqual(second[0], 429)
            self.assertEqual(self.state.quota(self.principal)["images"]["used"], 2)
            self.assertEqual(len(self.upstream.calls), 1)
        finally:
            release.set()
            first.join(3)
        self.assertEqual(results[0][0], 200)
        self.wait_admitted(0)

    def raw_connection(self, path, length, token=None, extra="", principal="default"):
        conn = socket.create_connection(("127.0.0.1", self.port), timeout=3)
        cookie = "Cookie: " + COOKIE + "=" + token + "\r\n" if token else ""
        principal = self.owner if principal == "default" else principal
        principal_header = "X-Managed-Principal: " + principal + "\r\n" if principal is not None else ""
        request = (f"POST {PREFIX}{path} HTTP/1.1\r\nHost: canvas.example\r\nOrigin: {self.config.origin}\r\n"
                   f"{cookie}{principal_header}Content-Type: application/json\r\nContent-Length: {length}\r\n{extra}\r\n")
        conn.sendall(request.encode())
        return conn

    def wait_admitted(self, number):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with self.state._lock:
                if self.state._admitted == number:
                    return
            time.sleep(0.005)
        self.fail("Admission did not reach expected count")

    def test_auth_and_size_rejected_before_reading_body(self):
        for token, length, status in ((None, MAX_BODY, 401), (self.token, MAX_BODY + 1, 413)):
            with self.raw_connection("/v1/responses", length, token) as conn:
                response = http.client.HTTPResponse(conn)
                response.begin()
                self.assertEqual(response.status, status)
                response.read()
        self.assertEqual(self.upstream.calls, [])

    def test_four_body_admissions_before_parsing_no_paid_reservations(self):
        sockets = []
        try:
            for _ in range(4):
                sockets.append(self.raw_connection("/v1/responses", 100, self.token))
            self.wait_admitted(4)
            with self.raw_connection("/v1/responses", 100, self.token) as conn:
                response = http.client.HTTPResponse(conn)
                response.begin()
                self.assertEqual(response.status, 429)
                response.read()
            self.assertEqual(self.state.quota(self.principal)["text"]["used"], 0)
            self.assertEqual(self.upstream.calls, [])
        finally:
            for conn in sockets:
                conn.close()
        self.wait_admitted(0)

    def test_per_code_image_body_admission_and_memory_budget(self):
        first = self.raw_connection("/v1/images/edits", MAX_BODY, self.token)
        try:
            self.wait_admitted(1)
            for path in ("/v1/images/generations", "/v1/responses"):
                with self.raw_connection(path, 1, self.token) as conn:
                    response = http.client.HTTPResponse(conn)
                    response.begin()
                    self.assertEqual(response.status, 429)
                    response.read()
            self.assertEqual(self.state.quota(self.principal)["images"]["used"], 0)
        finally:
            first.close()
        self.wait_admitted(0)

    def test_duplicate_framing_and_cookies_rejected(self):
        for extra in ("Content-Length: 2\r\n", "Transfer-Encoding: chunked\r\n", "Origin: https://evil.example\r\n",
                      "Cookie: " + COOKIE + "=" + self.token + "\r\n"):
            with self.raw_connection("/v1/responses", 100, self.token, extra) as conn:
                response = http.client.HTTPResponse(conn)
                response.begin()
                self.assertEqual(response.status, 400)
                response.read()
        self.assertEqual(self.request("/v1/models", headers={"Cookie": f"{COOKIE}={self.token}; {COOKIE}={self.token}"})[0], 400)

    def test_login_ip_limit_ignores_forwarded_for_and_client_auth(self):
        for index in range(10):
            result = self.request("/login", "POST", {"code": "wrong"}, auth=False,
                                  headers={"X-Real-IP": "198.51.100.20", "X-Forwarded-For": f"203.0.113.{index}"})
            self.assertEqual(result[0], 401)
        self.assertEqual(self.request("/login", "POST", {"code": self.code}, auth=False,
                                      headers={"X-Real-IP": "198.51.100.20"})[0], 429)
        self.assertEqual(self.request("/login", "POST", {"code": self.code}, auth=False,
                                      headers={"X-Real-IP": "198.51.100.21"})[0], 200)
        self.assertEqual(self.request("/v1/responses", "POST", self.text(), auth=False,
                                      headers={"Authorization": "Bearer " + self.token})[0], 401)

    def test_no_sensitive_request_or_exception_logs(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.request("/v1/models?secret=" + SECRET)
            self.request("/login", "POST", {"code": SECRET}, auth=False)
            with patch.object(self.upstream, "request", side_effect=RuntimeError(SECRET)):
                self.request("/v1/responses", "POST", self.text())
        self.assertEqual(out.getvalue() + err.getvalue(), "")


class TransportTests(unittest.TestCase):
    def test_fixed_upstream_and_server_only_authorization(self):
        config = Config("https://canvas.example", "https://bm.example/v1", SECRET, state_dir=tempfile.gettempdir())
        with patch("http.client.HTTPSConnection") as factory, patch("threading.Timer") as timer:
            connection = factory.return_value
            timed, _ = Upstream(config).request("/v1/responses", b"{}", "application/json", True)
            factory.assert_called_once_with("bm.example", 443, timeout=180)
            args, kwargs = connection.request.call_args
            self.assertEqual(args, ("POST", "/v1/responses"))
            self.assertEqual(kwargs["headers"]["Authorization"], "Bearer " + SECRET)
            self.assertEqual(set(kwargs["headers"]), {"Authorization", "Content-Type", "Accept", "Accept-Encoding"})
            connection.getresponse.assert_called_once()
            self.assertEqual(timer.call_args.args[0], 300)
            timed.close()
            timer.return_value.cancel.assert_called_once()
        with patch("http.client.HTTPSConnection") as factory, patch("threading.Timer") as timer:
            with self.assertRaises(StateError):
                Upstream(config).request("https://evil.example", b"{}", "application/json", False)
            factory.return_value.request.assert_not_called()

    def test_image_timeout_and_total_deadline_abort_socket(self):
        config = Config("https://canvas.example", "https://bm.example/v1", SECRET, state_dir=tempfile.gettempdir())
        with patch("http.client.HTTPSConnection") as factory, patch("threading.Timer") as timer:
            timed, _ = Upstream(config).request("/v1/images/generations", b"{}", "application/json", False)
            factory.assert_called_once_with("bm.example", 443, timeout=600)
            self.assertEqual(timer.call_args.args[0], 610)
            timed.abort()
            factory.return_value.sock.shutdown.assert_called_once_with(socket.SHUT_RDWR)
            timed.deadline = time.monotonic() - 1
            with self.assertRaises(StateError) as caught:
                timed.check_deadline()
            self.assertEqual(caught.exception.status, 504)
            timed.close()
            timer.return_value.cancel.assert_called_once()

    def test_public_bind_prohibited(self):
        config = Config("https://canvas.example", "https://bm.example", SECRET, state_dir=tempfile.gettempdir())
        with self.assertRaises(ValueError):
            GatewayServer(config, address=("0.0.0.0", 3180))


if __name__ == "__main__":
    unittest.main()
