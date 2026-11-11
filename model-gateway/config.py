"""Private configuration. No secrets in command-line arguments or public status."""

import json
import os
import re
import stat
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_CONFIG = "/etc/aoweisi-model-gateway/config.json"


@dataclass(frozen=True)
class Config:
    origin: str
    upstream_base_url: str
    api_key: str = field(repr=False)
    version: int = 1
    state_dir: str = "/var/lib/aoweisi-model-gateway"
    commerce_public_dir: str = ""
    commerce_catalog_name: str = "catalog-creative-v1.json"
    image_models: tuple = ("gpt-image-2",)
    text_models: tuple = ("gpt-5.5",)
    default_image_model: str = "gpt-image-2"
    default_text_model: str = "gpt-5.5"
    image_daily_limit: int = 20
    text_daily_limit: int = 200
    global_image_daily_limit: int = 200
    global_text_daily_limit: int = 2000

    def __post_init__(self):
        if type(self.version) is not int or self.version != 1:
            raise ValueError("Unsupported configuration version")
        for value, origin in ((self.origin, True), (self.upstream_base_url, False)):
            if not isinstance(value, str) or any(ord(c) < 33 for c in value):
                raise ValueError("Invalid HTTPS endpoint")
            p = urlsplit(value)
            if (p.scheme != "https" or not p.hostname or p.username or p.password
                    or p.query or p.fragment or p.port not in (None, 443)):
                raise ValueError("Invalid HTTPS endpoint")
            if origin and (p.path or value != "https://" + p.netloc):
                raise ValueError("Origin must be an exact HTTPS origin without a path")
            if not origin and p.path not in ("", "/v1"):
                raise ValueError("Upstream base must be an HTTPS origin optionally ending in /v1")
        if (not isinstance(self.api_key, str) or not self.api_key
                or len(self.api_key) > 4096 or not self.api_key.isascii()
                or any(ord(c) < 33 or ord(c) > 126 for c in self.api_key)):
            raise ValueError("Invalid provider credential")
        if not isinstance(self.state_dir, str) or not Path(self.state_dir).is_absolute():
            raise ValueError("State directory must be absolute")
        if self.commerce_public_dir and not Path(self.commerce_public_dir).is_absolute():
            raise ValueError("Commerce public directory must be absolute")
        if not re.fullmatch(r"[A-Za-z0-9_-]+\.json", self.commerce_catalog_name):
            raise ValueError("Invalid commerce catalog name")
        for key in ("image_models", "text_models"):
            values = getattr(self, key)
            if (not isinstance(values, (list, tuple)) or not values
                    or any(not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", v) for v in values)
                    or len(set(values)) != len(values)):
                raise ValueError("Invalid model allowlist")
            object.__setattr__(self, key, tuple(values))
        if (set(self.image_models) & set(self.text_models)
                or self.default_image_model not in self.image_models
                or self.default_text_model not in self.text_models):
            raise ValueError("Invalid default models")
        for key in ("image_daily_limit", "text_daily_limit", "global_image_daily_limit", "global_text_daily_limit"):
            if type(getattr(self, key)) is not int or not 0 <= getattr(self, key) <= 1000000:
                raise ValueError("Invalid quota limit")

    def public_models(self):
        return ([{"name": m, "capability": "image"} for m in self.image_models]
                + [{"name": m, "capability": "text"} for m in self.text_models])


def load_config(path=DEFAULT_CONFIG):
    p = Path(path)
    # Root may grant the dedicated service group read access (0640).
    if os.name == "posix" and stat.S_IMODE(p.stat().st_mode) & 0o137:
        raise ValueError("Configuration must be private (0600 or 0640)")
    with p.open(encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict):
        raise ValueError("Invalid configuration")
    return Config(**value)


def private_write(path, content):
    """Publish a complete private file without ever overwriting an existing file."""
    destination = Path(path).absolute()
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".gateway-", dir=destination.parent)
    try:
        if os.name == "posix":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        # link is atomic and fails if destination exists, unlike replace.
        os.link(temp, destination)
    finally:
        os.unlink(temp)


def save_config(config, path=DEFAULT_CONFIG):
    private_write(path, json.dumps(asdict(config), ensure_ascii=False, indent=2) + "\n")
