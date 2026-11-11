"""Private, owner-bound image relay. Only trusted upstream adapters call register.

MediaError.code/status/message are safe for HTTP responses; never expose causes.
No image cache: every fetch revalidates DNS and downloads at most MAX_BYTES.
The service must provision state_dir with private Windows ACLs on Windows;
POSIX directory/file permissions are enforced here.
"""

import hashlib
from contextlib import contextmanager
import hmac
import http.client
import ipaddress
import os
from pathlib import Path
import queue
import re
import secrets
import socket
import sqlite3
import ssl
import threading
import time
from urllib.parse import urljoin, urlsplit

TTL_SECONDS = 24 * 60 * 60
MAX_BYTES = 32 * 1024 * 1024
TOTAL_TIMEOUT = 60
READ_TIMEOUT = 10
MAX_RECORDS = 10000
_DNS_SLOTS = threading.BoundedSemaphore(4)
_FETCH_SLOTS = threading.BoundedSemaphore(4)


class MediaError(Exception):
    def __init__(self, code, status, message):
        self.code, self.status, self.message = code, status, message
        super().__init__(message)


def _invalid():
    return MediaError("media_target_rejected", 502, "Media destination rejected")


def _remaining(deadline):
    left = deadline - time.monotonic()
    if left <= 0:
        raise MediaError("media_timeout", 504, "Media request timed out")
    return min(READ_TIMEOUT, left)


def _public(address):
    ip = ipaddress.ip_address(address)
    if (not ip.is_global or ip.is_multicast or ip.is_reserved
            or getattr(ip, "ipv4_mapped", None) is not None
            or getattr(ip, "sixtofour", None) is not None
            or getattr(ip, "teredo", None) is not None):
        raise _invalid()
    return ip


def _parse(url):
    if (not isinstance(url, str) or len(url) > 16384
            or any(ord(c) <= 32 or ord(c) >= 127 for c in url)
            or "\\" in url):
        raise _invalid()
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port or 443
        if (parts.scheme != "https" or not host or parts.username is not None
                or parts.password is not None or parts.fragment or "%" in host
                or port != 443):
            raise _invalid()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if (host.rstrip(".").lower() == "localhost"
                    or host.rstrip(".").lower().endswith(".localhost")
                    or not re.fullmatch(r"[A-Za-z0-9.-]+", host)):
                raise _invalid()
        else:
            _public(host)
        return host, port, parts.path or "/", parts.query
    except ValueError:
        raise _invalid() from None


def _resolve(host, port, deadline):
    # getaddrinfo has no portable timeout. Bound both caller wait and stuck
    # resolver threads; daemon workers cannot prevent process shutdown.
    if not _DNS_SLOTS.acquire(blocking=False):
        raise MediaError("media_busy", 503, "Media relay busy")
    result = queue.Queue(maxsize=1)

    def work():
        try:
            result.put((True, socket.getaddrinfo(
                host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)))
        except Exception:
            result.put((False, None))
        finally:
            _DNS_SLOTS.release()

    threading.Thread(target=work, daemon=True).start()
    try:
        ok, records = result.get(timeout=_remaining(deadline))
    except queue.Empty:
        raise MediaError("media_timeout", 504, "Media request timed out") from None
    if not ok or not records:
        raise _invalid()
    for family, kind, proto, canon, address in records:
        if family not in (socket.AF_INET, socket.AF_INET6):
            raise _invalid()
        _public(address[0])
    return records[0][0], records[0][4]


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, family, address, deadline):
        super().__init__(host, port, timeout=_remaining(deadline),
                         context=ssl.create_default_context())
        self.family, self.address, self.deadline = family, address, deadline
        self._transport = None
        self._expired = threading.Event()

    def abort(self):
        self._expired.set()
        transport = self._transport
        if transport is not None:
            try:
                transport.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def connect(self):
        # Direct socket.connect on the numeric sockaddr: no second DNS lookup.
        raw = socket.socket(self.family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
        self._transport = raw
        try:
            raw.settimeout(_remaining(self.deadline))
            raw.connect(self.address)
            secured = self._context.wrap_socket(
                raw, server_hostname=self.host, do_handshake_on_connect=False)
            self._transport = secured
            if self._expired.is_set():
                raise TimeoutError()
            secured.settimeout(_remaining(self.deadline))
            secured.do_handshake()
            self.sock = secured
        except BaseException:
            self._transport.close()
            raise


def _mime(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _download(url):
    deadline = time.monotonic() + TOTAL_TIMEOUT
    for hop in range(4):
        host, port, path, query = _parse(url)
        family, address = _resolve(host, port, deadline)
        conn = _PinnedHTTPSConnection(host, port, family, address, deadline)
        timer = threading.Timer(max(0, deadline - time.monotonic()), conn.abort)
        timer.daemon = True
        response = None
        timer.start()
        try:
            conn.request("GET", path + ("?" + query if query else ""), headers={
                "Accept": "image/png,image/jpeg,image/webp,image/gif",
                "Accept-Encoding": "identity", "Connection": "close"})
            response = conn.getresponse()
            _remaining(deadline)
            if response.status in (301, 302, 303, 307, 308):
                locations = response.headers.get_all("Location", [])
                if hop == 3 or len(locations) != 1:
                    raise _invalid()
                if not locations[0] or any(ord(c) <= 32 or ord(c) >= 127 for c in locations[0]):
                    raise _invalid()
                _parse(locations[0] if "://" in locations[0] else urljoin(url, locations[0]))
                url = urljoin(url, locations[0])
                continue
            if response.status != 200:
                raise MediaError("media_unavailable", 502, "Media unavailable")
            types = response.headers.get_all("Content-Type", [])
            mime = types[0].split(";", 1)[0].strip().lower() if len(types) == 1 else None
            if mime not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
                raise MediaError("media_type_rejected", 502, "Media type rejected")
            if response.getheader("Content-Encoding", "identity").lower() != "identity":
                raise MediaError("media_type_rejected", 502, "Media type rejected")
            lengths = response.headers.get_all("Content-Length", [])
            transfer = response.getheader("Transfer-Encoding")
            if (len(lengths) > 1 or (lengths and transfer)
                    or (transfer and transfer.lower() != "chunked")):
                raise MediaError("media_unavailable", 502, "Media unavailable")
            length = None
            if lengths:
                if not re.fullmatch(r"[0-9]{1,12}", lengths[0]):
                    raise MediaError("media_unavailable", 502, "Media unavailable")
                length = int(lengths[0])
                if length > MAX_BYTES:
                    raise MediaError("media_too_large", 502, "Media exceeds size limit")
            data = bytearray()
            while True:
                _remaining(deadline)
                chunk = response.read1(min(65536, MAX_BYTES + 1 - len(data)))
                _remaining(deadline)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > MAX_BYTES:
                    raise MediaError("media_too_large", 502, "Media exceeds size limit")
            if length is not None and len(data) != length:
                raise MediaError("media_unavailable", 502, "Media unavailable")
            if _mime(data) != mime:
                raise MediaError("media_type_rejected", 502, "Media type rejected")
            return bytes(data), mime
        finally:
            timer.cancel()
            if response is not None:
                response.close()
            conn.close()


class MediaStore:
    def __init__(self, state_dir):
        root = Path(state_dir)
        if root.is_symlink():
            raise ValueError("State directory must not be a symlink")
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.name != "nt":
            root.chmod(0o700)
        self.db_path = root / "media.sqlite"
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        try:
            fd = os.open(self.db_path, flags, 0o600)
        except FileExistsError:
            if self.db_path.is_symlink() or not self.db_path.is_file():
                raise ValueError("Invalid media registry")
        else:
            os.close(fd)
        if os.name != "nt":
            self.db_path.chmod(0o600)
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS media (token_hash TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, url TEXT NOT NULL, expires REAL NOT NULL)")
            db.execute("CREATE INDEX IF NOT EXISTS media_expiry ON media(expires)")
            db.execute("DELETE FROM media WHERE expires <= ?", (time.time(),))

    def _db(self):
        # Explicit close is supplied by this small context manager, since the
        # sqlite Connection context manager commits but does not close.
        @contextmanager
        def connection():
            db = sqlite3.connect(self.db_path, timeout=5)
            try:
                with db:
                    yield db
            finally:
                db.close()
        return connection()

    @staticmethod
    def _digest(value):
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    def register(self, url, owner_id):
        _parse(url)
        if not isinstance(owner_id, str) or not owner_id:
            raise ValueError("A trusted principal ID is required")
        token = secrets.token_urlsafe(32)
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM media WHERE expires <= ?", (time.time(),))
            if db.execute("SELECT COUNT(*) FROM media").fetchone()[0] >= MAX_RECORDS:
                raise MediaError("media_busy", 503, "Media relay busy")
            db.execute("INSERT INTO media VALUES (?, ?, ?, ?)",
                       (self._digest(token), self._digest(owner_id), url,
                        time.time() + TTL_SECONDS))
        return token

    def fetch(self, token, owner_id):
        missing = MediaError("media_not_found", 404, "Media not found")
        if (not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token)
                or not isinstance(owner_id, str) or not owner_id):
            raise missing
        with self._db() as db:
            row = db.execute("SELECT owner_hash, url, expires FROM media WHERE token_hash = ?",
                             (self._digest(token),)).fetchone()
        if (not hmac.compare_digest(row[0] if row else "0" * 64, self._digest(owner_id))
                or not row or row[2] <= time.time()):
            raise missing
        if not _FETCH_SLOTS.acquire(blocking=False):
            raise MediaError("media_busy", 503, "Media relay busy")
        try:
            return _download(row[1])
        except MediaError:
            raise
        except (TimeoutError, socket.timeout):
            raise MediaError("media_timeout", 504, "Media request timed out") from None
        except (OSError, ValueError, http.client.HTTPException):
            raise MediaError("media_unavailable", 502, "Media unavailable") from None
        finally:
            _FETCH_SLOTS.release()
