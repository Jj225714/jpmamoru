import base64
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
import commerce_policies as policies
from config import Config
from state import State, StateError


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = Config("https://example.test", "https://provider.test", "private", state_dir=self.temp.name)
        self.store = policies.CommercePolicies(self.config)
        data = io.BytesIO()
        Image.new("RGB", (2, 2), "white").save(data, format="PNG")
        self.data_url = "data:image/png;base64," + base64.b64encode(data.getvalue()).decode()
        asset = self.store.action({"action": "upload", "dataUrl": self.data_url}, "admin")["asset"]
        self.pack = dict(id="draft", name="rules", version=1, status="draft", sourceFileName="rules.xlsx", createdAt="2026-09-23", profiles=[], rules=[], templates=[], siteReferences=[], globalStandards=[],
                         references=[dict(id="ref", url=asset["url"], name="sample", source="rule-reference", sheet="sheet", anchor="A1", kind="reference")],
                         requirementPresets=[dict(id="scene", stage="scene", referenceIds=[], category="Mat", order=0, title="Scene", enabledByDefault=True, defaultCount=1, prompt="Show product", layout="single-hero", chineseCopy="", translationSeeds={}, requiredFacts=[], variantScope="per-sku", needsReview=True)],
                         categories=[dict(id="mat", name="Mat", active=True, order=0, aliases=[], rules=[], referenceIds=["ref"], requirementIds=["scene"])])

    def save(self, pack=None):
        return self.store.action({"action": "save", "revision": self.store.state()["revision"], "package": pack or self.pack}, "admin")

    def publish(self):
        return self.store.action({"action": "publish", "revision": self.store.state()["revision"]}, "admin")

    def test_permission_defaults_and_revoke_active_session(self):
        state = State(self.config)
        owner, code = state.create_code("admin")
        token, principal = state.login(code, "127.0.0.1")
        self.assertFalse(principal["rules_admin"])
        state.set_rules_admin(owner, True)
        self.assertTrue(state.authenticate(token)["rules_admin"])
        state.set_rules_admin(owner, False)
        self.assertFalse(state.authenticate(token)["rules_admin"])
        self.assertNotIn("draft", self.store.snapshot(False))

    def test_revision_and_immutable_publication_rollback(self):
        self.save()
        with self.assertRaises(StateError) as caught:
            self.store.action({"action": "save", "revision": 0, "package": self.pack}, "admin")
        self.assertEqual(caught.exception.status, 409)
        first = self.publish()
        old = self.store.catalog.read_bytes()
        second = self.store.action({"action": "rollback", "revision": first["revision"], "version": first["activeVersion"]}, "other")
        self.assertGreater(second["activeVersion"], first["activeVersion"])
        release = self.store.public / "releases" / first["history"][0]["revision"] / "catalog.json"
        self.assertEqual(release.read_bytes(), old)
        self.assertEqual(second["history"][-1]["rollbackOf"], first["activeVersion"])
        self.assertEqual(self.store.validate(second["draft"]), [])

    def test_recovery_after_commit_and_before_commit(self):
        self.save()
        original = policies.atomic
        def stopped(path, value, *args):
            if path == self.store.root / "state.json":
                raise OSError("power failure after pointer")
            return original(path, value, *args)
        with patch.object(policies, "atomic", side_effect=stopped):
            with self.assertRaises(OSError):
                self.publish()
        recovered = policies.CommercePolicies(self.config)
        self.assertEqual(len(recovered.state()["history"]), 1)
        self.assertIsNotNone(recovered.state()["activeVersion"])
        before = recovered.state()
        original_catalog = recovered.catalog.read_bytes()
        def before_pointer(path, value, *args):
            if path == recovered.catalog:
                raise OSError("failure before pointer")
            return original(path, value, *args)
        with patch.object(policies, "atomic", side_effect=before_pointer):
            with self.assertRaises(OSError):
                recovered.action({"action": "publish", "revision": before["revision"]}, "admin")
        recovered = policies.CommercePolicies(self.config)
        self.assertEqual(recovered.state(), before)
        self.assertEqual(recovered.catalog.read_bytes(), original_catalog)

    def test_validation_missing_assets_hierarchy_conflicts_and_deletion(self):
        parent = self.pack["categories"][0]
        parent["rules"] = [dict(id="people", text="No people", strength="required", stages=["scene"], key="people", value="none")]
        child = dict(parent, id="child", name="Child", parentId="mat", rules=[dict(parent["rules"][0], value="adult-full")])
        self.pack["categories"].append(child)
        self.assertTrue(any("冲突" in e for e in self.store.validate(self.pack)))
        child["rules"] = []
        self.save()
        self.publish()
        removed = copy.deepcopy(self.pack)
        removed["categories"].pop()
        self.assertTrue(any("不能删除" in e for e in self.store.validate(removed)))
        bad = copy.deepcopy(self.pack)
        bad["categories"][1]["parentId"] = "child"
        self.assertTrue(any("两级" in e for e in self.store.validate(bad)))
        bad = copy.deepcopy(self.pack)
        bad["requirementPresets"][0].update(stage="detail", visualKind="detail")
        self.assertTrue(any("素材用途" in e for e in self.store.validate(bad)))

    def test_upload_decode_and_private_boundary(self):
        for data in ("data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,iVBORw0KGgo="):
            with self.assertRaises(StateError):
                self.store.action({"action": "upload", "dataUrl": data}, "admin")
        for url in ("https://evil.test/image.png", "/public-rules/../secret", "/api/managed/commerce-policies/assets/../../state.json"):
            with self.assertRaises(ValueError):
                self.store.asset_path(url)
        self.pack["references"][0]["storageKey"] = "private-product-image"
        self.assertTrue(any("私有" in e for e in self.store.validate(self.pack)))

    def test_structural_semantic_validation_and_public_projection(self):
        mutations = [
            lambda p: p["requirementPresets"][0].update(defaultCount=99),
            lambda p: p["requirementPresets"][0].update(layout="invented"),
            lambda p: p["references"][0].update(kind="executable"),
            lambda p: p["categories"][0].update(order=1.5),
            lambda p: p["categories"][0].update(name="  "),
            lambda p: p.update(profiles=[{}]),
            lambda p: p["requirementPresets"][0].pop("title"),
            lambda p: p["categories"][0].update(rules=[dict(id="x", text="test", strength="required", key="people", value="adult-half", stages=["detail"])]),
        ]
        for mutate in mutations:
            candidate = copy.deepcopy(self.pack)
            mutate(candidate)
            with self.subTest(mutate=mutate):
                self.assertTrue(self.store.validate(candidate))
        self.pack["unrelatedWorkspaceData"] = "not public"
        self.pack["references"][0]["unrelatedSecret"] = "not public"
        self.save()
        self.publish()
        public = self.store.catalog.read_text(encoding="utf-8")
        self.assertNotIn("not public", public)

    def test_root_with_children_and_marketing_needs_sample(self):
        parent = self.pack["categories"][0]
        child = dict(copy.deepcopy(parent), id="child", name="Child", parentId="mat")
        self.pack["categories"].append(child)
        parent["referenceIds"] = []
        self.assertEqual(self.store.validate(self.pack), [])
        self.pack["requirementPresets"][0]["stage"] = "marketing"
        child["referenceIds"] = []
        self.assertTrue(any("示例" in error for error in self.store.validate(self.pack)))

    def test_catalog_existing_version_bootstrap(self):
        old = dict(self.pack, version=88, publishedAt="2026-09-23")
        policies.atomic(self.store.catalog, {"policyPacks": [old]})
        self.assertEqual(self.store.snapshot(True)["activeVersion"], 88)
        self.save()
        self.assertEqual(self.publish()["activeVersion"], 89)

    def test_rollback_ignores_broken_draft_and_retains_only_published_ids(self):
        self.save()
        first = self.publish()
        newer = copy.deepcopy(first["draft"])
        newer["categories"][0]["name"] = "Renamed"
        newer["categories"].append(dict(copy.deepcopy(newer["categories"][0]), id="new-published", name="Mat", aliases=["old-new"], creativeBrief={"people": "none"}))
        self.save(newer)
        self.publish()
        broken = copy.deepcopy(newer)
        broken["categories"] = [dict(broken["categories"][0], id="never-published", parentId="missing", rules=[{"invalid": True}])]
        self.save(broken)
        result = self.store.action({"action": "rollback", "revision": self.store.state()["revision"], "version": first["activeVersion"]}, "admin")
        cats = {c["id"]: c for c in result["draft"]["categories"]}
        self.assertEqual(set(cats), {"mat", "new-published"})
        self.assertEqual(cats["mat"]["name"], "Mat")
        placeholder = cats["new-published"]
        self.assertFalse(placeholder["active"])
        self.assertIn("new-published", placeholder["name"])
        self.assertEqual(placeholder["aliases"], [])
        self.assertEqual(placeholder["rules"], [])
        self.assertEqual(placeholder["requirementIds"], [])
        self.assertNotIn("creativeBrief", placeholder)
        self.assertNotIn("parentId", placeholder)

    def test_rollback_to_legacy_pack_without_categories(self):
        legacy = copy.deepcopy(self.pack)
        legacy.pop("categories")
        self.save(legacy)
        first = self.publish()
        self.save(self.pack)
        self.publish()
        self.save({"incomplete": True})
        result = self.store.action({"action": "rollback", "revision": self.store.state()["revision"], "version": first["activeVersion"]}, "admin")
        self.assertEqual([c["id"] for c in result["draft"]["categories"]], ["mat"])
        self.assertFalse(result["draft"]["categories"][0]["active"])


class PolicyHttpTests(unittest.TestCase):
    from test_server import ServerTests as Fixture
    setUp = Fixture.setUp
    tearDown = Fixture.tearDown
    request = Fixture.request

    def test_server_authorization_and_principal_binding(self):
        self.assertEqual(self.request("/commerce-policies", auth=False)[0], 401)
        self.assertEqual(self.request("/commerce-policies", "POST", {"action": "validate"})[0], 403)
        self.state.set_rules_admin(self.owner, True)
        self.assertEqual(self.request("/commerce-policies")[0], 200)
        status, _, payload = self.request("/commerce-policies", "POST", {"action": "validate"}, headers={"X-Managed-Principal": self.owner})
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(payload)["valid"])
        self.assertEqual(self.request("/commerce-policies", "POST", {"action": "validate"}, headers={"X-Managed-Principal": "wrong"})[0], 409)
        self.state.set_rules_admin(self.owner, False)
        self.assertEqual(self.request("/commerce-policies", "POST", {"action": "validate"})[0], 403)


if __name__ == "__main__":
    unittest.main()
