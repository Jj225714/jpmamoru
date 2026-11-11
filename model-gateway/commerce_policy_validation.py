"""Semantic counterpart of web policy-editor validation for public publication."""
import re

LOCALES = "en-US th-TH vi-VN ms-MY fil-PH id-ID".split()
OPTIONS = {
    "severity": "BLOCK WARN GUIDE", "platforms": "shopee tiktok", "phase": "prompt preflight post-render", "checker": "metadata text vision manual",
    "stage": "scene detail usage-size detail-white marketing", "assetStages": "main-white scene detail usage-size detail-white marketing-preview marketing",
    "visualMode": "generate white-layout", "visualKind": "scene detail usage-size detail-white", "generationStrategy": "single paired-before-after",
    "recipeRole": "hero detail usage selling-point secondary-scene interaction lighting before-after", "slot": "scene detail usage-size marketing",
    "layout": "single-hero feature-grid before-after competitor-comparison size-comparison color-options multi-scene layer-structure lighting-comparison installation-methods installation-steps faq custom-reference",
    "variantScope": "per-sku per-color per-size per-site custom", "kind": "reference example", "detailPurpose": "front-texture back edge side accessory other",
    "people": "none adult-partial adult-half adult-full", "lighting": "natural-window soft-studio warm-indoor side-light", "framing": "auto close medium wide",
    "source": "upload url zip generated rule-reference",
}


def validate_semantics(pack):
    errors = []
    def required(value, label):
        if not value.strip():
            errors.append(label + "不能为空")
    def choice(key, value):
        if value not in (LOCALES if key in ("locale", "locales") else OPTIONS[key].split()):
            errors.append(key + "取值无效")
    def integer(value, minimum, maximum, label):
        if type(value) is not int or not minimum <= value <= maximum:
            errors.append(label + "整数范围无效")
    def brief(value):
        for key in ("people", "lighting", "framing"):
            if key in value:
                choice(key, value[key])
        for key in ("scene", "audience"):
            if len(value.get(key, "")) > 2000:
                errors.append(key + "超过2000字")
    required(pack["name"], "名称")
    if pack.get("creativeLibraryVersion", 1) != 1:
        errors.append("推荐方案版本无效")
    refs = {r["id"] for r in pack["references"]}
    for group in ("rules", "templates", "references", "requirementPresets", "siteReferences"):
        ids = [r["id"] for r in pack[group]]
        if len(ids) != len(set(ids)) or any(not v.strip() for v in ids):
            errors.append(group + " ID重复或为空")
    countries = set()
    for profile in pack["profiles"]:
        required(profile["countryName"], "国家名称")
        if not re.fullmatch("[A-Z]{2}", profile["countryCode"]) or profile["countryCode"] in countries:
            errors.append("国家代码无效或重复")
        countries.add(profile["countryCode"])
        choice("locale", profile["locale"])
    for rule in pack["rules"]:
        for key in ("title", "description"):
            required(rule[key], key)
        integer(rule["priority"], 0, 100, "优先级")
        for key in ("severity", "phase", "checker"):
            choice(key, rule[key])
        for key in ("platforms", "locales", "assetStages"):
            for value in rule[key]:
                choice(key, value)
        if any(not re.fullmatch("[A-Z]{2}", code) for code in rule["countries"]):
            errors.append("国家过滤无效")
    for item in pack["templates"] + pack["requirementPresets"]:
        for key in ("title", "category", "prompt" if "prompt" in item else "requirement"):
            required(item[key], key)
        integer(item["order"], 0, 9999, "排序")
        if not set(item["referenceIds"]) <= refs:
            errors.append("示例引用不存在")
        for locale in item["translationSeeds"]:
            choice("locale", locale)
        for key in ("stage", "layout", "variantScope", "visualMode", "visualKind", "recipeRole", "generationStrategy", "detailPurpose", "slot"):
            if key in item:
                choice(key, item[key])
        brief(item.get("creativeBrief", {}))
        if "defaultCount" in item:
            integer(item["defaultCount"], 0, 4, "图片数量")
        paired = item.get("generationStrategy") == "paired-before-after"
        if paired and (item.get("stage") != "marketing" or item.get("layout") != "before-after" or item.get("visualMode") == "white-layout"):
            errors.append("前后对比方案配置无效")
        if (paired or item.get("recipeRole") == "detail") and item.get("creativeBrief", {}).get("people", "none") != "none":
            errors.append("细节和前后对比不能加入人物")
    for item in pack["references"]:
        required(item["name"], "参考名称")
        choice("kind", item["kind"])
        choice("source", item["source"])
    for item in pack["siteReferences"]:
        required(item["product"], "站点商品")
        if "locale" in item:
            choice("locale", item["locale"])
        if not set(item["referenceIds"]) <= refs:
            errors.append("站点示例引用不存在")
        if item.get("url"):
            # The public catalog itself permits only same-origin public paths.
            if not re.fullmatch(r"/public-rules/[A-Za-z0-9_./-]+", item["url"]) or ".." in item["url"]:
                errors.append("站点地址须为/public-rules/下的公开地址")
    for text in pack["globalStandards"]:
        required(text, "全局要求")
    opacity = pack.get("watermarkOpacityRange", [0.03, 0.3])
    if len(opacity) != 2 or not 0.03 <= opacity[0] <= opacity[1] <= 0.3:
        errors.append("水印范围无效")
        opacity = [0.03, 0.3]
    for cat in pack.get("categories", []):
        brief(cat.get("creativeBrief", {}))
    defaults = pack.get("generationDefaults", {})
    brief(defaults.get("creativeBrief", {}))
    for value in defaults.get("assetCounts", {}).values():
        integer(value, 0, 4, "默认数量")
    for key, choices in (("siteImageMode", ("shared", "per-site")), ("delivery", ("flattenedOnly", "editableCanvas"))):
        if key in defaults and defaults[key] not in choices:
            errors.append(key + "无效")
    output = defaults.get("outputSpec")
    if output and (output["size"] not in (800, 1024, 1254, 1600) or output["dpi"] not in (96, 120, 150) or output["format"] not in ("png", "jpeg") or output["colorSpace"] != "sRGB" or not 256 * 1024 <= output["maxBytes"] <= 20 * 1024 * 1024):
        errors.append("输出规格无效")
    overlays = defaults.get("overlay")
    if overlays:
        logo, watermark = overlays["logo"], overlays["watermark"]
        if logo["placement"] not in ("off", "top-left", "top-right", "bottom-left", "bottom-right") or watermark["mode"] not in ("off", "single", "tile") or watermark["position"] not in ("top-left", "top-center", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom-center", "bottom-right") or not opacity[0] <= watermark["opacity"] <= opacity[1]:
            errors.append("水印或Logo设置无效")
        for overlay in (logo, watermark):
            if overlay["applyTo"] not in ("marketing", "all", "custom") or (overlay["applyTo"] == "custom" and not overlay["customStages"]):
                errors.append("覆盖范围无效")
            for stage in overlay["customStages"]:
                choice("assetStages", stage)
    return errors
