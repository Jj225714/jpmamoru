import base64
import contextlib
import struct
import threading
import time
import unittest
from unittest.mock import patch
from editor import EditorJobs
from state import StateError


def png(width=64, height=32):
    raw = b"\x89PNG\r\n\x1a\n" + b"\0\0\0\rIHDR" + struct.pack(">II", width, height)
    return "data:image/png;base64," + base64.b64encode(raw).decode()


class State:
    calls = 0
    @contextlib.contextmanager
    def reserve(self, token, kind, count):
        self.calls += 1
        yield {"id": "owner"}


class Media:
    def register(self, url, owner):
        assert url.startswith("https://")
        return "media-owned-by-" + owner


class EditorTests(unittest.TestCase):
    def setUp(self):
        self.state = State()
        self.jobs = EditorJobs(self.state, Media())
        self.jobs.fal = "test-secret"
        self.data = dict(operation="layers", documentId="document", revision=3, idempotencyKey="once", image=png(), width=64, height=32)

    def wait(self, id):
        for _ in range(100):
            task = self.jobs.get("owner", id)
            if task["status"] in ("succeeded", "failed", "canceled"):
                return task
            time.sleep(.01)
        self.fail("worker did not terminate")

    def test_unconfigured_and_dimension_spoofing(self):
        self.jobs.fal = ""
        with self.assertRaises(StateError) as caught:
            self.jobs.validate(self.data, lambda _: None)
        self.assertEqual(caught.exception.code, "editor_not_configured")
        self.jobs.fal = "test"
        with self.assertRaises(StateError):
            self.jobs.validate({**self.data, "width": 100}, lambda _: None)
        with self.assertRaises(StateError):
            self.jobs.validate({**self.data, "operation": "erase", "mask": png(1, 1)}, lambda _: None)

    def test_idempotency_owner_and_revision(self):
        with patch.object(self.jobs, "fal_run", return_value={"images": [{"url": "private"}]}):
            first = self.jobs.submit("owner", "session", self.data, lambda _: None)
            self.wait(first["id"])
            second = self.jobs.submit("owner", "session", self.data, lambda _: None)
            self.assertEqual(first["id"], second["id"])
            self.assertEqual(self.state.calls, 1)
            self.assertEqual(second["revision"], 3)
            self.assertNotIn("owner", second)
            with self.assertRaises(StateError):
                self.jobs.get("another-owner", first["id"])
            with self.assertRaises(StateError):
                self.jobs.submit("owner", "session", {**self.data, "revision": 4}, lambda _: None)

    def test_cancel_discards_late_success_and_preserves_concurrency_slot(self):
        entered, finish = threading.Event(), threading.Event()
        def provider(job, data):
            entered.set(); finish.wait(2); return {"images": [{"url": "late"}]}
        with patch.object(self.jobs, "fal_run", side_effect=provider):
            task = self.jobs.submit("owner", "session", self.data, lambda _: None)
            entered.wait(1)
            self.jobs.get("owner", task["id"], cancel=True)
            with self.assertRaises(StateError):
                self.jobs.submit("owner", "session", {**self.data, "idempotencyKey": "second"}, lambda _: None)
            finish.set()
            result = self.wait(task["id"])
            self.assertEqual(result["status"], "canceled")
            self.assertNotIn("result", result)

    def test_failure_is_sanitized_and_not_retried(self):
        with patch.object(self.jobs, "fal_run", side_effect=RuntimeError("private-provider-key")) as provider:
            task = self.jobs.submit("owner", "session", self.data, lambda _: None)
            result = self.wait(task["id"])
            self.assertEqual(result["status"], "failed")
            self.assertNotIn("private", result["error"])
            self.assertEqual(provider.call_count, 1)

    def test_provider_uses_real_mask_and_fixed_host(self):
        calls = []
        def provider(host, path, headers, body=None, method=None):
            calls.append((host, path, body))
            if body: return {"request_id": "123"}
            if path.endswith("/status"): return {"status": "COMPLETED"}
            return {"images": [{"url": "https://fal.media/image.png"}]}
        self.jobs.provider = provider
        event = threading.Event()
        with patch.object(event, "wait", return_value=False):
            result = self.jobs.fal_run({"owner": "owner", "cancel": event}, {**self.data, "operation": "erase", "mask": png()})
        self.assertEqual(calls[0][2]["mask_url"], png())
        self.assertTrue(all(c[0] == "queue.fal.run" for c in calls))
        self.assertEqual(calls[1][1], "/fal-ai/flux-pro/requests/123/status")
        self.assertEqual(result["images"][0]["url"], "/api/managed/media/media-owned-by-owner")


if __name__ == "__main__":
    unittest.main()
