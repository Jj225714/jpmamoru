"""Isolated real-policy browser test server. No production data or model traffic."""
import argparse
import base64
import datetime
import http.client
import http.server
import json
import mimetypes
from pathlib import Path
import ssl
import sys
import threading
from urllib.parse import unquote, urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "model-gateway"))
from config import Config
from server import GatewayServer
from state import State

parser = argparse.ArgumentParser()
parser.add_argument("--directory", required=True)
parser.add_argument("--port", type=int, default=8443)
args = parser.parse_args()
directory = Path(args.directory).resolve()
directory.mkdir(parents=True, exist_ok=True)
config = Config("https://localhost", "https://model-disabled.invalid", "test-only-unused", state_dir=str(directory))
state = State(config)
admin, code = state.create_code("本地测试管理员", image_limit=0, text_limit=0)
state.set_rules_admin(admin, True)
viewer, viewer_code = state.create_code("本地测试只读用户", image_limit=0, text_limit=0)

class NoModel:
    def request(self, *args, **kwargs):
        raise AssertionError("Models must never be called by this local test")

gateway = GatewayServer(config, state=state, upstream=NoModel(), address=("127.0.0.1", 0))
threading.Thread(target=gateway.serve_forever, daemon=True).start()
policies = gateway.commerce_policies
photo = ROOT / "web/public/commerce-categories/image4.jpg"
asset = policies.upload({"dataUrl": "data:image/jpeg;base64," + base64.b64encode(photo.read_bytes()).decode()})["asset"]
def recipe(id, stage, purpose=None):
    value = dict(id=id, category="local-mats", order=1, title="空间场景" if stage == "scene" else "背面展示", stage=stage, enabledByDefault=True, defaultCount=1, prompt="遵循所选类目要求，保持商品真实外观", layout="single-hero", chineseCopy="", translationSeeds={}, requiredFacts=[], referenceIds=[], variantScope="per-sku", needsReview=False, visualMode="generate", visualKind=stage)
    if purpose:
        value["detailPurpose"] = purpose
    return value
pack = dict(id="local-test", name="本地联调规则", version=0, status="draft", sourceFileName="网页配置测试", createdAt="2026-09-24T00:00:00Z", creativeLibraryVersion=1, profiles=[], rules=[], templates=[], siteReferences=[], globalStandards=[], references=[dict(id=asset["id"], name="厨房摆放示例", url=asset["url"], source="rule-reference", sheet="网页配置", anchor="local-kitchen", kind="example")], requirementPresets=[recipe("local-scene", "scene"), recipe("local-back", "detail", "back")], categories=[dict(id="local-mats", name="测试地垫类", aliases=[], active=True, order=0, rules=[], referenceIds=[], requirementIds=["local-scene", "local-back"]), dict(id="local-kitchen", parentId="local-mats", name="厨房测试地垫", aliases=[], active=True, order=0, rules=[dict(id="kitchen-position", text="地垫平铺在水槽前，保持真实比例", strength="required", stages=["scene", "usage-size"])], referenceIds=[asset["id"]], requirementIds=[])])
policies.action({"action": "save", "revision": 0, "package": pack}, admin)
policies.action({"action": "publish", "revision": 1}, admin)

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
now = datetime.datetime.now(datetime.timezone.utc)
cert = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=1)).not_valid_after(now + datetime.timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False).sign(key, hashes.SHA256())
(directory / "key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
(directory / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
origin = f"https://localhost:{args.port}"

class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.do_GET()

    def do_GET(self):
        path = urlsplit(self.path).path
        if self.headers.get("Host") != f"localhost:{args.port}" or (self.headers.get("Origin") and self.headers["Origin"] != origin):
            self.send_error(403)
            return
        if path.startswith("/api/managed/"):
            headers = {key: value for key, value in self.headers.items() if key.lower() not in ("connection", "host", "origin")}
            headers["Host"] = "localhost"
            if self.headers.get("Origin"):
                headers["Origin"] = "https://localhost"
            body = self.rfile.read(int(self.headers.get("Content-Length", "0"))) if self.command == "POST" else None
            connection = http.client.HTTPConnection("127.0.0.1", gateway.server_address[1], timeout=30)
            connection.request(self.command, self.path, body, headers)
            response = connection.getresponse()
            data = response.read()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ("content-length", "connection", "transfer-encoding"):
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            connection.close()
            return
        base = policies.public if path.startswith("/public-rules/") else ROOT / "web/dist"
        relative = path[len("/public-rules/"):] if path.startswith("/public-rules/") else path.lstrip("/")
        target = (base / unquote(relative)).resolve()
        if not target.is_relative_to(base.resolve()):
            self.send_error(403)
            return
        if not target.is_file():
            if path.startswith("/api/") or path.startswith("/public-rules/"):
                self.send_error(404)
                return
            target = ROOT / "web/dist/index.html"
        data = target.read_bytes()
        if target.name == "index.html":
            runtime = b'<script>window.__RUNTIME_CONFIG__={commerceCreativePolicyCatalogUrl:"/public-rules/catalog-creative-v1.json"};</script>'
            data = data.replace(b"<head>", b"<head>" + runtime)
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

httpd = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Proxy)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(directory / "cert.pem", directory / "key.pem")
httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
# Only the parent test reads this pipe; never print credentials in a test report.
print(json.dumps({"url": origin, "code": code, "viewerCode": viewer_code}), flush=True)
try:
    httpd.serve_forever()
finally:
    httpd.server_close()
    gateway.shutdown()
    gateway.server_close()
