import concurrent.futures
import json
import tempfile
import threading
import unittest
from dataclasses import replace
from datetime import datetime, timezone

from config import Config
from state import SESSION_TTL, State, StateError, digest


class StateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.now = 1800000000.0
        self.config = Config("https://canvas.example", "https://bm.example/v1", "test-provider-secret",
                             state_dir=self.directory.name)
        self.state = State(self.config, clock=lambda: self.now)
        self.owner, self.code = self.state.create_code("用户01")
        self.token, self.principal = self.state.login(self.code, "192.0.2.1")

    def test_secrets_are_independent_hashes_and_stable_principal(self):
        self.assertNotEqual(self.code, self.token)
        self.assertGreaterEqual(len(self.code), 43)
        second, _ = self.state.login(self.code, "192.0.2.2")
        self.assertNotEqual(second, self.token)
        with self.state._db() as db:
            dump = "\n".join(db.iterdump())
        for secret in (self.code, self.token, second, self.config.api_key):
            self.assertNotIn(secret, dump)
        self.assertIn(digest("code", self.code), dump)
        self.assertIn(digest("session", self.token), dump)
        reopened = State(self.config, clock=lambda: self.now)
        self.assertEqual(reopened.authenticate(second)["id"], self.owner)
        public = json.dumps(self.state.list_principals())
        self.assertNotIn("hash", public)
        self.assertNotIn(self.code, public)

    def test_logout_expiry_disable_and_no_cross_revocation(self):
        second, _ = self.state.login(self.code, "192.0.2.2")
        self.state.logout(self.token)
        self.assertIsNone(self.state.authenticate(self.token))
        self.assertIsNotNone(self.state.authenticate(second))
        self.now += SESSION_TTL
        self.assertIsNone(self.state.authenticate(second))
        third, _ = self.state.login(self.code, "192.0.2.3")
        self.state.disable(self.owner)
        self.assertIsNone(self.state.authenticate(third))
        with self.assertRaises(StateError) as caught:
            self.state.login(self.code, "192.0.2.4")
        self.assertEqual(caught.exception.status, 401)

    def test_login_rate_limit_is_persistent_per_ip_and_expires(self):
        for _ in range(10):
            with self.assertRaises(StateError) as caught:
                self.state.login("wrong", "198.51.100.9")
            self.assertEqual(caught.exception.status, 401)
        other = State(self.config, clock=lambda: self.now)
        with self.assertRaises(StateError) as caught:
            other.login(self.code, "198.51.100.9")
        self.assertEqual(caught.exception.status, 429)
        other.login(self.code, "198.51.100.10")
        self.now += 900
        other.login(self.code, "198.51.100.9")

    def test_conservative_charges_and_slot_release(self):
        with self.assertRaises(OSError):
            with self.state.reserve(self.token, "images", 15):
                raise OSError("ambiguous upstream failure")
        self.assertEqual(self.state.quota(self.principal)["images"]["used"], 15)
        with self.state.reserve(self.token, "images", 5):
            pass
        with self.assertRaises(StateError):
            with self.state.reserve(self.token, "images"):
                self.fail("Over-quota reservation entered")
        self.assertEqual(self.state._active, 0)
        self.assertEqual(self.state._images, set())

    def test_atomic_global_quota_across_independent_state_connections(self):
        config = replace(self.config, global_text_daily_limit=7)
        states = [State(config, clock=lambda: self.now) for _ in range(8)]
        barrier = threading.Barrier(8)

        def attempt(index):
            barrier.wait()
            try:
                with states[index].reserve(self.token, "text"):
                    return True
            except StateError:
                return False

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(attempt, range(8))), 7)
        self.assertEqual(self.state.quota(self.principal)["text"]["used"], 7)

    def test_global_failure_does_not_charge_local_quota(self):
        state = State(replace(self.config, global_image_daily_limit=0), clock=lambda: self.now)
        with self.assertRaises(StateError):
            with state.reserve(self.token, "images"):
                pass
        self.assertEqual(state.quota(self.principal)["images"]["used"], 0)

    def test_image_and_global_concurrency(self):
        with self.state.reserve(self.token, "images"):
            with self.assertRaises(StateError):
                with self.state.reserve(self.token, "images"):
                    pass
            with self.state.reserve(self.token, "text"):
                with self.state.reserve(self.token, "text"):
                    with self.state.reserve(self.token, "text"):
                        with self.assertRaises(StateError):
                            with self.state.reserve(self.token, "text"):
                                pass
        self.assertEqual(self.state.quota(self.principal)["images"]["used"], 1)
        self.assertEqual(self.state.quota(self.principal)["text"]["used"], 3)

    def test_admission_no_charge_and_memory_budget(self):
        with self.state.admit(self.token, "images", 128 * 1024 * 1024):
            with self.assertRaises(StateError):
                with self.state.admit(self.token, "text", 1):
                    pass
        self.assertEqual(self.state.quota(self.principal)["images"]["used"], 0)
        with self.assertRaises(ValueError):
            with self.state.admit(self.token, "images", 1):
                raise ValueError("invalid body")
        with self.state.admit(self.token, "images", 1):
            pass
        self.assertEqual(self.state._admitted, 0)
        self.assertEqual(self.state._admitted_bytes, 0)

    def test_revalidate_revoked_session_before_reserving(self):
        with self.state.admit(self.token, "images", 1):
            self.state.disable(self.owner)
            with self.assertRaises(StateError) as caught:
                with self.state.reserve(self.token, "images"):
                    pass
        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(self.state.quota(self.principal)["images"]["used"], 0)

    def test_shanghai_midnight_resets_both_quotas(self):
        self.now = datetime(2026, 9, 18, 15, 59, 59, tzinfo=timezone.utc).timestamp()
        self.token, self.principal = self.state.login(self.code, "203.0.113.1")
        with self.state.reserve(self.token, "images", 2):
            pass
        self.assertEqual(self.state.quota(self.principal)["day"], "2026-09-18")
        self.now += 1
        self.assertEqual(self.state.quota(self.principal)["day"], "2026-09-19")
        self.assertEqual(self.state.quota(self.principal)["images"]["used"], 0)

    def test_quota_adjustment_and_validation(self):
        self.state.set_quotas(self.owner, 0, 3)
        with self.assertRaises(StateError):
            with self.state.reserve(self.token, "images"):
                pass
        for count in (True, 0, -1, 16, 1.5):
            with self.subTest(count=count), self.assertRaises(ValueError):
                with self.state.reserve(self.token, "images", count):
                    pass
        with self.assertRaises(ValueError):
            self.state.set_quotas(self.owner, -1, 1)


if __name__ == "__main__":
    unittest.main()
