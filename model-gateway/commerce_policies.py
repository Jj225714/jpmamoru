"""Private drafts and immutable public releases. One gateway process owns publication.

The catalog is the sole commit point. A durable intent allows recovery of the
private audit/draft state when a process stops immediately after that commit.
"""
import base64
import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import threading
from datetime import datetime, timezone

from state import StateError
from commerce_policy_validation import validate_semantics

ASSET = re.compile(r"([a-f0-9]{64})\.(png|jpg|webp|gif)$")
STAGES = {"scene", "detail", "usage-size", "detail-white"}
PURPOSES = {"front-texture", "back", "edge", "side", "accessory", "other"}
SCHEMA = json.loads(Path(__file__).with_name("commerce-policy-schema.json").read_text(encoding="utf-8"))


def read_shape(value, shape, label="规则包"):
    if isinstance(shape, str):
        valid = ((shape == "string" and isinstance(value, str)) or
                 (shape == "boolean" and type(value) is bool) or
                 (shape == "number" and type(value) in (int, float) and math.isfinite(value)))
        if not valid:
            raise ValueError(label + "字段类型无效")
        return value
    if isinstance(shape, list):
        if not isinstance(value, list) or len(value) > 10000:
            raise ValueError(label + "数组格式或数量无效")
        return [read_shape(item, shape[0], label) for item in value]
    if not isinstance(value, dict):
        raise ValueError(label + "对象格式无效")
    output = {}
    for field, child in shape.items():
        key = field.rstrip("?")
        if key not in value:
            if field.endswith("?"):
                continue
            raise ValueError(label + "." + key + "必填")
        output[key] = read_shape(value[key], child, label + "." + key)
    return output


def public_package(pack):
    # Server chooses these publication metadata fields, which drafts may omit.
    return read_shape(dict(pack, publishedAt=pack.get("publishedAt", "")), SCHEMA)


def fail(status, code, message):
    raise StateError(status, code, message)


def atomic(path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name("." + path.name + "." + secrets.token_hex(8))
    try:
        with tmp.open("xb") as stream:
            if os.name == "posix":
                os.fchmod(stream.fileno(), mode)
            stream.write(value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False, allow_nan=False).encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        if os.name == "posix":
            fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        if tmp.exists():
            tmp.unlink()


class CommercePolicies:
    def __init__(self, config):
        self.root = Path(config.state_dir) / "commerce-policies"
        self.public = Path(config.commerce_public_dir) if config.commerce_public_dir else self.root / "public-rules"
        self.catalog = self.public / config.commerce_catalog_name
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.recover()
        if not (self.root / "state.json").exists() and self.catalog.exists():
            catalog = self.read(self.catalog)
            if catalog.get("policyPacks") and re.fullmatch(r"[A-Za-z0-9_-]+", catalog.get("revision", "")):
                state = self.state()
                entry = {"version": state["activeVersion"], "revision": catalog["revision"], "publishedAt": catalog.get("publishedAt", ""), "actor": "imported-existing-catalog"}
                atomic(self.root / "versions" / (catalog["revision"] + ".json"), catalog)
                state["history"] = [entry]
                atomic(self.root / "state.json", state)

    @staticmethod
    def read(path, default=None):
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default

    def state(self):
        stored = self.read(self.root / "state.json")
        if stored is not None:
            return stored
        catalog = self.read(self.catalog, {})
        packs = catalog.get("policyPacks", [])
        latest = max(packs, key=lambda p: p.get("version", 0)) if packs else None
        return {"revision": 0, "draft": latest, "history": [], "activeVersion": latest.get("version") if latest else None}

    def recover(self):
        intent = self.read(self.root / "intent.json")
        if not intent:
            return
        catalog = self.read(self.catalog, {})
        if catalog.get("revision") == intent["release"]:
            atomic(self.root / "state.json", intent["state"])
        (self.root / "intent.json").unlink()

    def snapshot(self, admin):
        with self.lock:
            self.recover()
            value = self.state()
            if not admin:
                return {"canManage": False, "activeVersion": value["activeVersion"]}
            return dict(value, canManage=True)

    def historical_catalog(self, entry):
        return self.read(self.public / "releases" / entry["revision"] / "catalog.json",
                         self.read(self.root / "versions" / (entry["revision"] + ".json"), {}))

    @staticmethod
    def check_revision(body, state):
        if type(body.get("revision")) is not int or body["revision"] != state["revision"]:
            fail(409, "revision_conflict", "规则已被其他管理员修改，请重新载入。")

    def asset_path(self, url):
        if not isinstance(url, str):
            raise ValueError("参考图地址无效")
        prefix = "/api/managed/commerce-policies/assets/"
        if url.startswith(prefix) and ASSET.fullmatch(url[len(prefix):]):
            return self.root / "assets" / url[len(prefix):]
        match = re.fullmatch(r"/public-rules/releases/([A-Za-z0-9_-]+)/images/([a-f0-9]{64}\.(?:png|jpg|webp|gif))", url)
        if match:
            return self.public / "releases" / match[1] / "images" / match[2]
        raise ValueError("参考图必须是已上传或已发布的规则图片")

    def upload(self, body):
        try:
            from PIL import Image
            value = body.get("dataUrl", "")
            if not isinstance(value, str) or len(value) > 28 * 1024 * 1024:
                raise ValueError()
            match = re.fullmatch(r"data:image/(png|jpeg|webp|gif);base64,(.+)", value, re.S)
            if not match:
                raise ValueError()
            data = base64.b64decode(match[2], validate=True)
            with Image.open(io.BytesIO(data)) as image:
                fmt = image.format
                if fmt not in ("PNG", "JPEG", "WEBP", "GIF") or image.width * image.height > 40_000_000:
                    raise ValueError()
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
            ext, mime = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"), "WEBP": ("webp", "image/webp"), "GIF": ("gif", "image/gif")}[fmt]
        except ImportError:
            fail(503, "image_decoder_unavailable", "服务端需安装 Pillow 才能校验上传图片。")
        except Exception:
            fail(400, "invalid_image", "请上传可解码的 PNG、JPEG、WebP 或 GIF 图片（最多20MB、4000万像素）。")
        if len(data) > 20 * 1024 * 1024:
            fail(413, "image_too_large", "图片超过20MB。")
        digest = hashlib.sha256(data).hexdigest()
        name = digest + "." + ext
        path = self.root / "assets" / name
        if not path.exists():
            atomic(path, data)
        return {"asset": {"id": digest, "sha256": digest, "url": "/api/managed/commerce-policies/assets/" + name, "mimeType": mime}}

    def validate(self, pack):
        errors = []
        if not isinstance(pack, dict):
            return ["规则包格式无效"]
        try:
            sanitized = public_package(pack)
        except ValueError as exc:
            return [str(exc)]
        errors.extend(validate_semantics(sanitized))
        required = ("id", "name", "version", "sourceFileName", "createdAt", "profiles", "rules", "templates", "references", "requirementPresets", "siteReferences", "globalStandards")
        if any(key not in pack for key in required):
            errors.append("规则包缺少必要字段")
        for group in ("profiles", "rules", "templates", "siteReferences", "globalStandards"):
            if not isinstance(pack.get(group), list):
                errors.append(group + "列表无效")
        if type(pack.get("version")) is not int or pack.get("version", -1) < 0:
            errors.append("版本号无效")
        # Public packages never contain product photos, local storage pointers or credentials.
        def private(value):
            if isinstance(value, dict):
                return any(key in {"storageKey", "apiKey", "token", "sourceImages", "detailImages", "sourceImageIds", "primaryImageId"} or private(item) for key, item in value.items())
            return isinstance(value, list) and any(private(item) for item in value)
        if private(pack):
            errors.append("公共规则不能包含商品素材、私有存储或认证字段")
        refs, presets, cats = {}, {}, {}
        for key, target in (("references", refs), ("requirementPresets", presets), ("categories", cats)):
            items = pack.get(key, [])
            if not isinstance(items, list) or len(items) > 2000:
                errors.append(key + "列表无效")
                continue
            for item in items:
                if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] or item["id"] in target:
                    errors.append(key + " ID无效或重复")
                else:
                    target[item["id"]] = item
        for ref in refs.values():
            try:
                path = self.asset_path(ref.get("url"))
                if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != path.stem:
                    raise ValueError("参考图片缺失或摘要不符")
            except ValueError as exc:
                errors.append(str(exc))
        aliases = {}
        for cat in cats.values():
            parent = cats.get(cat.get("parentId"))
            if cat.get("parentId") and (not parent or parent.get("parentId") or parent is cat):
                errors.append(cat["id"] + "：只支持有效的两级类目")
                continue
            if not cat.get("name", "").strip() or type(cat.get("active")) is not bool or type(cat.get("order")) is not int or not 0 <= cat["order"] <= 9999:
                errors.append(cat["id"] + "：名称或启用状态无效")
            for alias in [cat["name"]] + cat["aliases"]:
                normalized = alias.strip().lower()
                if not normalized or (normalized in aliases and aliases[normalized] != cat["id"]):
                    errors.append(cat["id"] + "：名称或别名存在歧义")
                aliases[normalized] = cat["id"]
            if cat.get("active") and parent and not parent.get("active"):
                errors.append(cat["id"] + "：父类已停用")
            own = cat.get("rules", [])
            inherited = parent.get("rules", []) if parent else []
            if not isinstance(own, list) or not all(isinstance(rule, dict) for rule in own):
                errors.append(cat["id"] + "：规则列表无效")
                continue
            own_ids = [r.get("id") for r in own]
            if len(own_ids) != len(set(own_ids)):
                errors.append(cat["id"] + "：规则ID重复")
            structured = {}
            for rule in inherited + own:
                if not rule.get("id") or not rule.get("text", "").strip() or rule.get("strength") not in ("required", "guide") or not isinstance(rule.get("stages"), list) or not rule["stages"] or not set(rule["stages"]) <= STAGES:
                    errors.append(cat["id"] + "：规则格式无效")
                    continue
                if rule.get("key") not in (None, "people", "scene") or (rule.get("key") == "people" and rule.get("value") not in ("none", "adult-partial", "adult-half", "adult-full")) or (rule.get("key") == "scene" and not rule.get("value", "").strip()):
                    errors.append(cat["id"] + "：结构化规则取值无效")
                if rule.get("key") == "people" and rule.get("value") != "none" and set(rule["stages"]) & {"detail", "detail-white"}:
                    errors.append(cat["id"] + "：细节阶段不能要求人物")
                if rule.get("strength") == "required" and rule.get("key"):
                    for stage in rule["stages"]:
                        key = (rule["key"], stage)
                        if key in structured and structured[key] != rule.get("value"):
                            errors.append(cat["id"] + "：结构化硬性条件冲突")
                        structured[key] = rule.get("value")
            for rule in inherited:
                if rule.get("strength") == "required":
                    override = next((r for r in own if r.get("id") == rule.get("id")), None)
                    if override and override != rule:
                        errors.append(cat["id"] + "：不可覆盖父类硬性规则，请增加新规则")
            reference_ids = cat.get("referenceIds") or (parent or {}).get("referenceIds", [])
            requirement_ids = cat.get("requirementIds") or (parent or {}).get("requirementIds", [])
            if any(r not in refs for r in reference_ids) or any(r not in presets for r in requirement_ids):
                errors.append(cat["id"] + "：示例或方案引用不存在")
            if cat.get("active") and not any(c.get("active") and c.get("parentId") == cat["id"] for c in cats.values()):
                if not requirement_ids:
                    errors.append(cat["id"] + "：启用类目必须有生成方案")
                for rid in requirement_ids:
                    preset = presets.get(rid, {})
                    kind = preset.get("visualKind", preset.get("stage", "scene"))
                    if kind == "marketing":
                        kind = "scene"
                    if kind in ("detail", "detail-white") and preset.get("detailPurpose") not in PURPOSES:
                        errors.append(cat["id"] + "：细节方案必须指定素材用途")
                    if kind in ("scene", "usage-size") and not reference_ids:
                        errors.append(cat["id"] + "：场景方案必须绑定示例图")
        for preset in presets.values():
            if any(r not in refs for r in preset.get("referenceIds", [])):
                errors.append("方案示例引用不存在")
        existing = set()
        for history in self.state()["history"]:
            catalog = self.historical_catalog(history)
            for old in catalog.get("policyPacks", []):
                existing.update(c["id"] for c in old.get("categories", []))
        if existing - set(cats):
            errors.append("已发布类目不能删除，请将其停用")
        return list(dict.fromkeys(errors))

    def action(self, body, actor):
        if not isinstance(body, dict):
            fail(400, "invalid_request", "请求格式无效")
        with self.lock:
            self.recover()
            state = self.state()
            action = body.get("action")
            if action == "upload":
                return self.upload(body)
            if action == "validate":
                try:
                    errors = self.validate(body.get("package", state["draft"]))
                except (TypeError, KeyError, ValueError):
                    errors = ["规则包结构无效"]
                return {"valid": not errors, "errors": errors}
            self.check_revision(body, state)
            if action == "save":
                pack = body.get("package")
                if not isinstance(pack, dict):
                    fail(400, "invalid_package", "草稿须为规则包对象")
                state.update(draft=pack, revision=state["revision"] + 1)
                atomic(self.root / "state.json", state)
                return dict(state, canManage=True)
            if action not in ("publish", "rollback"):
                fail(400, "invalid_action", "不支持的规则操作")
            pack = copy.deepcopy(state["draft"])
            if action == "rollback":
                selected = next((h for h in state["history"] if h["version"] == body.get("version")), None)
                if not selected:
                    fail(404, "version_not_found", "历史版本不存在")
                pack = self.historical_catalog(selected)["policyPacks"][0]
                # Only committed releases can contribute historical identities.
                # Drafts are intentionally allowed to be incomplete or invalid.
                known = {c["id"] for c in pack.get("categories", [])}
                names = {name.strip().lower() for c in pack.get("categories", []) for name in [c["name"]] + c.get("aliases", [])}
                committed = {}
                for entry in state["history"]:
                    for previous in self.historical_catalog(entry).get("policyPacks", []):
                        committed.update({c["id"]: c for c in previous.get("categories", [])})
                for previous in self.read(self.catalog, {}).get("policyPacks", []):
                    committed.update({c["id"]: c for c in previous.get("categories", [])})
                for cat in committed.values():
                    if cat["id"] not in known:
                        label = f"历史停用：{cat['name']}（{cat['id']}）"
                        name, suffix = label, 1
                        while name.strip().lower() in names:
                            suffix += 1
                            name = f"{label} [{suffix}]"
                        names.add(name.strip().lower())
                        known.add(cat["id"])
                        pack.setdefault("categories", []).append({
                            "id": cat["id"], "name": name, "aliases": [], "active": False,
                            "order": cat.get("order", 0), "rules": [], "requirementIds": [], "referenceIds": [],
                        })
            try:
                errors = self.validate(pack)
            except (TypeError, ValueError, KeyError):
                errors = ["规则包结构无效"]
            if errors:
                fail(422, "invalid_policy", "；".join(errors))
            pack = public_package(pack)
            version = max([pack.get("version", 0), state.get("activeVersion") or 0] + [p.get("version", 0) for p in self.read(self.catalog, {}).get("policyPacks", [])] + [h["version"] for h in state["history"]]) + 1
            stamp = datetime.now(timezone.utc).isoformat()
            suffix = hashlib.sha256(json.dumps(pack, sort_keys=True, ensure_ascii=False).encode() + stamp.encode()).hexdigest()[:12]
            release = f"aoweisi-category-v{version}-{suffix}"
            dest = self.public / "releases" / release
            for ref in pack["references"]:
                path = self.asset_path(ref["url"])
                atomic(dest / "images" / path.name, path.read_bytes(), 0o644)
                ref["url"] = f"/public-rules/releases/{release}/images/{path.name}"
            pack.update(id="server-" + release, version=version, status="published", publishedAt=stamp)
            catalog = {"schemaVersion": 1, "revision": release, "publishedAt": stamp, "policyPacks": [pack]}
            atomic(dest / "catalog.json", catalog, 0o644)
            if os.name == "posix":
                # Public release content must be readable by the static web server.
                for directory in (self.public, self.public / "releases", dest, dest / "images"):
                    if directory.exists():
                        directory.chmod(0o755)
                for path in dest.rglob("*"):
                    if path.is_file():
                        path.chmod(0o644)
            entry = {"version": version, "revision": release, "publishedAt": stamp, "actor": actor}
            if action == "rollback":
                entry["rollbackOf"] = body["version"]
            state.update(revision=state["revision"] + 1, draft=pack, activeVersion=version, history=state["history"] + [entry])
            atomic(self.root / "intent.json", {"release": release, "state": state})
            atomic(self.catalog, catalog, 0o644)
            if os.name == "posix":
                self.catalog.chmod(0o644)
            self.recover()
            return dict(state, canManage=True)
