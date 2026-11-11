import io
from email.message import Message
import socket
import queue
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

import media

PNG = b"\x89PNG\r\n\x1a\n" + b"test image"


def answer(ip="93.184.216.34"):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "",
            (ip, 443, 0, 0) if family == socket.AF_INET6 else (ip, 443))


class Response:
    def __init__(self, body=PNG, mime="image/png", status=200, headers=()):
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = mime
        for key, value in headers:
            self.headers[key] = value
        self.body = io.BytesIO(body)

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read1(self, count):
        return self.body.read(count)

    def close(self):
        self.body.close()


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = media.MediaStore(self.tmp.name)
        # Every test denies real network access even if its mocks regress.
        self.socket = patch.object(media.socket, "socket", side_effect=AssertionError("Real socket forbidden")).start()
        self.dns = patch.object(media.socket, "getaddrinfo", return_value=[answer()]).start()
        self.addCleanup(patch.stopall)

    def token(self, url="https://images.example/image?signature=secret"):
        return self.store.register(url, "owner")

    def check_error(self, code, action):
        with self.assertRaises(media.MediaError) as caught:
            action()
        self.assertEqual(code, caught.exception.code)
        self.assertNotIn("secret", str(caught.exception))
        return caught.exception

    def fetch_responses(self, token, responses):
        with patch.object(media, "_PinnedHTTPSConnection") as cls:
            cls.return_value.getresponse.side_effect = responses
            result = self.store.fetch(token, "owner")
            return result, cls

    def test_owner_unknown_and_expired_never_network(self):
        token = self.token()
        for owner, value in (("other", token), ("owner", "x" * 43), ("owner", "../bad")):
            error = self.check_error("media_not_found", lambda: self.store.fetch(value, owner))
            self.assertEqual(404, error.status)
        with self.store._db() as db:
            db.execute("UPDATE media SET expires = ?", (time.time() - 1,))
        self.check_error("media_not_found", lambda: self.store.fetch(token, "owner"))
        self.dns.assert_not_called()
        self.socket.assert_not_called()

    def test_persist_hash_and_restore(self):
        token = self.token()
        self.assertRegex(token, r"^[A-Za-z0-9_-]{43}$")
        self.assertNotEqual(token, self.token())
        with self.store._db() as db:
            digest, owner, expires = db.execute("SELECT token_hash,owner_hash,expires FROM media LIMIT 1").fetchone()
        self.assertNotEqual(token, digest)
        self.assertNotEqual("owner", owner)
        self.assertAlmostEqual(expires - time.time(), 86400, delta=5)
        self.store = media.MediaStore(self.tmp.name)
        result, _ = self.fetch_responses(token, [Response()])
        self.assertEqual((PNG, "image/png"), result)

    def test_bad_urls(self):
        for url in ("http://example.com/i", "file:///x", "data:image/png,abc",
                    "https://user:secret@example.com/i", "https://example.com:80/i",
                    "https://localhost/i", "https://a.localhost/i", "https://127.0.0.1/i",
                    "https://10.0.0.1/i", "https://169.254.169.254/i", "https://[::1]/i",
                    "https://[::ffff:8.8.8.8]/i", "https://[fe80::1%25eth0]/i",
                    "https://example.com/\r\nX: secret", "https://example.com\\@other/i"):
            with self.subTest(url=url):
                self.check_error("media_target_rejected", lambda: self.token(url))
        self.dns.assert_not_called()

    def test_all_dns_answers_validated_before_connect(self):
        for ip in ("10.0.0.2", "127.0.0.1", "169.254.1.2", "100.64.0.1", "::ffff:8.8.8.8", "ff02::1"):
            self.dns.return_value = [answer(), answer(ip)]
            self.check_error("media_target_rejected", lambda: self.store.fetch(self.token(), "owner"))
        self.socket.assert_not_called()

    def test_redirect_private_and_mixed_dns(self):
        for location in ("https://127.0.0.1/secret", "http://public.example/i", "https://u:secret@public.example/i"):
            with patch.object(media, "_PinnedHTTPSConnection") as cls:
                cls.return_value.getresponse.return_value = Response(status=302, headers=[("Location", location)])
                self.check_error("media_target_rejected", lambda: self.store.fetch(self.token(), "owner"))
                self.assertEqual(1, cls.call_count)
        self.dns.side_effect = [[answer()], [answer(), answer("10.0.0.1")]]
        with patch.object(media, "_PinnedHTTPSConnection") as cls:
            cls.return_value.getresponse.return_value = Response(status=302, headers=[("Location", "https://next.example/i")])
            self.check_error("media_target_rejected", lambda: self.store.fetch(self.token(), "owner"))
            self.assertEqual(1, cls.call_count)

    def test_redirect_limit_and_no_sensitive_headers(self):
        responses = [Response(status=302, headers=[("Location", "/next")]) for _ in range(4)]
        with patch.object(media, "_PinnedHTTPSConnection") as cls:
            cls.return_value.getresponse.side_effect = responses
            self.check_error("media_target_rejected", lambda: self.store.fetch(self.token(), "owner"))
            self.assertEqual(4, cls.call_count)
            for call in cls.return_value.request.call_args_list:
                headers = {name.lower() for name in call.kwargs["headers"]}
                self.assertFalse(headers & {"authorization", "cookie", "proxy-authorization"})

    def test_three_redirects_succeed_no_cache(self):
        token = self.token()
        result, cls = self.fetch_responses(token, [
            Response(status=302, headers=[("Location", "/next")]) for _ in range(3)] + [Response()])
        self.assertEqual((PNG, "image/png"), result)
        self.assertEqual(4, cls.call_count)
        self.fetch_responses(token, [Response()])
        self.assertEqual(5, self.dns.call_count)

    def test_rebinding_pinned_socket_sni_and_host(self):
        raw, secured, context = MagicMock(), MagicMock(), MagicMock()
        context.wrap_socket.return_value = secured
        with patch.object(media.socket, "socket", return_value=raw), patch.object(media.ssl, "create_default_context", return_value=context):
            family, address = media._resolve("images.example", 443, time.monotonic() + 60)
            self.dns.return_value = [answer("127.0.0.1")]
            conn = media._PinnedHTTPSConnection("images.example", 443, family, address, time.monotonic() + 60)
            conn.request("GET", "/image")
            raw.connect.assert_called_once_with(("93.184.216.34", 443))
            context.wrap_socket.assert_called_once_with(raw, server_hostname="images.example", do_handshake_on_connect=False)
            secured.do_handshake.assert_called_once()
            self.assertIn(b"Host: images.example\r\n", secured.sendall.call_args.args[0])
            self.assertEqual(1, self.dns.call_count)
            conn.close()

    def test_formats_and_content_type_match(self):
        for body, mime in ((PNG, "image/png"), (b"\xff\xd8\xffabc", "image/jpeg"),
                           (b"GIF89aabc", "image/gif"), (b"RIFF1234WEBPabc", "image/webp")):
            result, _ = self.fetch_responses(self.token(), [Response(body, mime)])
            self.assertEqual((body, mime), result)
        for body, mime in ((PNG, "text/html"), (b"<svg></svg>", "image/svg+xml"),
                           (b"<html>hello", "image/png"), (PNG, "image/jpeg"), (b"", "image/png")):
            self.check_error("media_type_rejected", lambda: self.fetch_responses(self.token(), [Response(body, mime)]))

    def test_size_caps_declared_and_streamed(self):
        with patch.object(media, "MAX_BYTES", 16):
            for response in (Response(headers=[("Content-Length", "17")]), Response(body=PNG * 8)):
                self.check_error("media_too_large", lambda: self.fetch_responses(self.token(), [response]))
            self.assertEqual((PNG[:16], "image/png"), self.fetch_responses(self.token(), [Response(PNG[:16])])[0])

    def test_bad_framing_and_compression(self):
        for headers in ([('Content-Length', '200')], [('Content-Length', '-1')],
                        [('Content-Length', '1'), ('Content-Length', '2')],
                        [('Content-Length', '1'), ('Transfer-Encoding', 'chunked')]):
            self.check_error("media_unavailable", lambda: self.fetch_responses(self.token(), [Response(headers=headers)]))
        self.check_error("media_type_rejected", lambda: self.fetch_responses(self.token(), [Response(headers=[('Content-Encoding', 'gzip')])]))

    def test_total_deadline_and_safe_network_errors(self):
        with patch.object(media, "TOTAL_TIMEOUT", -1):
            self.check_error("media_timeout", lambda: self.store.fetch(self.token(), "owner"))
        for failure, code in ((TimeoutError("secret"), "media_timeout"), (OSError("secret"), "media_unavailable")):
            with patch.object(media, "_PinnedHTTPSConnection", side_effect=failure):
                self.check_error(code, lambda: self.store.fetch(self.token(), "owner"))

    def test_registry_capacity_and_expiry_pruning(self):
        with patch.object(media, "MAX_RECORDS", 1):
            self.token()
            self.check_error("media_busy", self.token)
            with self.store._db() as db:
                db.execute("UPDATE media SET expires=0")
            self.token()
            with self.store._db() as db:
                self.assertEqual(1, db.execute("SELECT COUNT(*) FROM media").fetchone()[0])

    def test_resolver_timeout_and_saturation(self):
        with patch.object(media.queue.Queue, "get", side_effect=queue.Empty):
            self.check_error("media_timeout", lambda: self.store.fetch(self.token(), "owner"))
        with patch.object(media, "_DNS_SLOTS") as slots:
            slots.acquire.return_value = False
            self.check_error("media_busy", lambda: self.store.fetch(self.token(), "owner"))
        with patch.object(media, "_FETCH_SLOTS") as slots:
            slots.acquire.return_value = False
            self.check_error("media_busy", lambda: self.store.fetch(self.token(), "owner"))

    def test_download_deadline_checked_after_read(self):
        clock = [100.0]
        response = Response()
        original = response.read1

        def slow_read(size):
            clock[0] += 61
            return original(size)

        response.read1 = slow_read
        with patch.object(media.time, "monotonic", side_effect=lambda: clock[0]):
            self.check_error("media_timeout", lambda: self.fetch_responses(self.token(), [response]))

    def test_abort_interrupts_transport(self):
        conn = media._PinnedHTTPSConnection("images.example", 443, socket.AF_INET,
                                            ("93.184.216.34", 443), time.monotonic() + 60)
        conn._transport = MagicMock()
        conn.abort()
        conn._transport.shutdown.assert_called_once_with(socket.SHUT_RDWR)
        self.assertTrue(conn._expired.is_set())


if __name__ == "__main__":
    unittest.main()
