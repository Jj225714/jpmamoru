import contextlib
import getpass
import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cli
from config import Config, load_config, save_config
from state import State


class CliTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root / "private" / "config.json"
        self.key = "secret-test-provider-key"

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = cli.main(["--config", str(self.path), *args])
        return result, out.getvalue(), err.getvalue()

    def initialize(self):
        with patch("getpass.getpass", return_value=self.key) as prompt:
            result = self.run_cli("init", "--origin", "https://canvas.example", "--upstream-base-url", "https://bm.example/v1",
                                  "--state-dir", str(self.root / "state"))
        prompt.assert_called_once()
        self.assertEqual(result[0], 0)
        self.assertNotIn(self.key, result[1] + result[2])
        return load_config(self.path)

    def test_init_private_config_no_secret_repr_no_overwrite(self):
        config = self.initialize()
        self.assertEqual(config.api_key, self.key)
        self.assertNotIn(self.key, repr(config))
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        original = self.path.read_bytes()
        with patch("getpass.getpass", return_value="replacement-secret"):
            result = self.run_cli("init", "--origin", "https://canvas.example", "--upstream-base-url", "https://bm.example/v1")
        self.assertEqual(result[0], 1)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertNotIn("replacement-secret", result[1] + result[2])

    def test_code_delivery_listing_quotas_and_disable(self):
        config = self.initialize()
        codes, ids = [], []
        for number in range(1, 4):
            target = self.root / f"user{number}.json"
            result = self.run_cli("create-code", "--name", f"用户{number:02}", "--output-file", str(target))
            self.assertEqual(result[0], 0)
            delivery = json.loads(target.read_text(encoding="utf-8"))
            ids.append(delivery["id"])
            codes.append(delivery["code"])
            self.assertNotIn(delivery["code"], result[1] + result[2])
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assertEqual(len(set(codes)), 3)
        result = self.run_cli("list-codes")
        for code in codes:
            self.assertNotIn(code, result[1])
        self.assertNotIn("hash", result[1])
        self.assertEqual(len(json.loads(result[1])), 3)
        self.assertEqual(self.run_cli("set-quota", "--id", ids[0], "--image-limit", "7", "--text-limit", "9")[0], 0)
        self.assertEqual(json.loads(self.run_cli("list-codes")[1])[0]["image_limit"], 7)
        state = State(config)
        token, _ = state.login(codes[0], "192.0.2.1")
        self.assertEqual(self.run_cli("disable-code", "--id", ids[0])[0], 0)
        self.assertIsNone(state.authenticate(token))

    def test_failed_delivery_disables_unrecoverable_code(self):
        self.initialize()
        target = self.root / "existing.json"
        target.write_text("preserve", encoding="utf-8")
        result = self.run_cli("create-code", "--name", "用户01", "--output-file", str(target))
        self.assertEqual(result[0], 1)
        self.assertEqual(target.read_text(), "preserve")
        self.assertEqual(json.loads(self.run_cli("list-codes")[1])[0]["enabled"], 0)

    def test_stdout_code_once_and_list_never_reveals(self):
        self.initialize()
        result = self.run_cli("create-code", "--name", "用户01")
        delivery = json.loads(result[1])
        self.assertEqual(result[1].count(delivery["code"]), 1)
        self.assertNotIn(delivery["code"], self.run_cli("list-codes")[1])

    def test_rules_permission_grant_revoke(self):
        self.initialize()
        delivery = json.loads(self.run_cli("create-code", "--name", "rules-admin")[1])
        owner = delivery["id"]
        self.assertEqual(json.loads(self.run_cli("list-codes")[1])[0]["rules_admin"], 0)
        self.assertEqual(self.run_cli("set-rules-admin", "--id", owner, "--enabled", "true")[0], 0)
        self.assertEqual(json.loads(self.run_cli("list-codes")[1])[0]["rules_admin"], 1)
        self.assertEqual(self.run_cli("set-rules-admin", "--id", owner, "--enabled", "false")[0], 0)
        self.assertEqual(json.loads(self.run_cli("list-codes")[1])[0]["rules_admin"], 0)

    def test_getpass_echo_fallback_is_rejected(self):
        with patch("getpass.getpass", side_effect=getpass.GetPassWarning("do not echo")):
            result = self.run_cli("init", "--origin", "https://canvas.example", "--upstream-base-url", "https://bm.example")
        self.assertEqual(result[0], 1)
        self.assertFalse(self.path.exists())

    def test_configuration_rejects_unsafe_endpoint_and_limits(self):
        for url in ("http://bm.example", "https://user:pass@bm.example", "https://bm.example/v1?url=evil",
                    "https://bm.example/v1/evil", "https://bm.example/#key", "https://bm.example:444"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                Config("https://canvas.example", url, self.key)
        for origin in ("https://canvas.example/", "https://canvas.example/path", "http://canvas.example"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                Config(origin, "https://bm.example", self.key)
        with self.assertRaises(ValueError):
            Config("https://canvas.example", "https://bm.example", "bad\nkey")

    @unittest.skipUnless(os.name == "posix", "Unix permissions")
    def test_root_service_group_mode_allowed_world_access_rejected(self):
        self.initialize()
        self.path.chmod(0o640)
        load_config(self.path)
        for mode in (0o644, 0o660, 0o700, 0o666):
            self.path.chmod(mode)
            with self.assertRaises(ValueError):
                load_config(self.path)


if __name__ == "__main__":
    unittest.main()
