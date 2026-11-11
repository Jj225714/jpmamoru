"""Owner-scoped image editor jobs; credentials and provider URLs never reach clients."""
import base64
import hashlib
import http.client
import json
import os
import re
import secrets
import struct
import threading
import time
from urllib.parse import urlsplit

from state import StateError

MODELS = {"erase": "fal-ai/flux-pro/v1/fill", "expand": "fal-ai/flux-pro/v1/fill",
          "upscale": "fal-ai/esrgan", "layers": "fal-ai/qwen-image-layered"}
TERMINAL = {"succeeded", "failed", "canceled"}
MAX_REQUEST = 48 * 1024 * 1024


def fail(status, code, message):
    raise StateError(status, code, message)


def provider_json(host, path, headers, body=None, method=None):
    conn = http.client.HTTPSConnection(host, timeout=60)
    try:
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method or ("POST" if data is not None else "GET"), path, data, {**headers, "Content-Type": "application/json"})
        response = conn.getresponse()
        raw = response.read(8 * 1024 * 1024 + 1)
        if response.status not in (200, 201, 202) or len(raw) > 8 * 1024 * 1024:
            fail(502, "editor_provider", "专用模型请求失败，请检查服务配置、余额或稍后重试")
        return json.loads(raw)
    finally:
        conn.close()


class EditorJobs:
    def __init__(self, state, media, provider=provider_json):
        self.state, self.media, self.provider = state, media, provider
        self.lock = threading.RLock()
        self.jobs = {}
        self.fal = os.environ.get("FAL_KEY", "")
        self.azure_key = os.environ.get("AZURE_VISION_KEY", "")
        self.azure_host = urlsplit(os.environ.get("AZURE_VISION_ENDPOINT", ""))

    def capabilities(self):
        azure = bool(self.azure_key and self.azure_host.scheme == "https" and
                     re.fullmatch(r"[a-zA-Z0-9-]+\.cognitiveservices\.azure\.com", self.azure_host.netloc))
        return {"operations": {op: {"enabled": bool(azure if op == "ocr" else self.fal),
                "message": "" if (azure if op == "ocr" else self.fal) else
                ("请管理员配置 AZURE_VISION_ENDPOINT 和 AZURE_VISION_KEY" if op == "ocr" else "请管理员配置 FAL_KEY")}
                for op in (*MODELS, "ocr")}}

    def validate(self, data, validate_image):
        allowed = {"operation", "documentId", "revision", "idempotencyKey", "image", "mask", "scale", "width", "height", "prompt"}
        if not isinstance(data, dict) or set(data) - allowed:
            fail(400, "invalid_editor_request", "无效的编辑请求")
        for key in ("documentId", "idempotencyKey"):
            if not isinstance(data.get(key), str) or not re.fullmatch(r"[\w-]{1,100}", data[key]):
                fail(400, "invalid_editor_request", "无效的编辑标识")
        if type(data.get("revision")) is not int or not 0 <= data["revision"] <= 10000000:
            fail(400, "invalid_editor_request", "无效的文档版本")
        op = data.get("operation")
        if op not in (*MODELS, "ocr"):
            fail(400, "invalid_editor_request", "不支持此图片操作")
        capability = self.capabilities()["operations"][op]
        if not capability["enabled"]:
            fail(503, "editor_not_configured", capability["message"])
        for key in ("width", "height"):
            if type(data.get(key)) is not int or not 1 <= data[key] <= 4096:
                fail(400, "invalid_editor_size", "处理图片最长边不能超过 4096 像素")
        if data["width"] * data["height"] > 16777216:
            fail(400, "invalid_editor_size", "图片尺寸超过限制")
        for key in (("image", "mask") if op in ("erase", "expand") else ("image",)):
            validate_image(data.get(key))
            # Browser sends canonical PNGs; do not trust claimed dimensions for paid operations.
            value = data[key]
            raw = base64.b64decode(value.split(",", 1)[1], validate=True)
            if (not raw.startswith(b"\x89PNG\r\n\x1a\n") or len(raw) < 24 or raw[12:16] != b"IHDR"
                    or struct.unpack(">II", raw[16:24]) != (data["width"], data["height"])):
                fail(400, "invalid_editor_size", "图片与蒙版的实际尺寸必须和请求一致，请重新上传")
        if op == "upscale" and (type(data.get("scale")) is not int or data["scale"] not in (2, 4) or max(data["width"], data["height"]) * data["scale"] > 4096):
            fail(400, "invalid_editor_size", "请选择 2 倍或 4 倍，输出最长边不得超过 4096 像素")
        if "prompt" in data and (not isinstance(data["prompt"], str) or len(data["prompt"]) > 2000):
            fail(400, "invalid_editor_request", "提示词过长")

    @staticmethod
    def public(job):
        return {k: v for k, v in job.items() if k in ("id", "documentId", "revision", "status", "result", "error")}

    def submit(self, owner, token, data, validate_image):
        self.validate(data, validate_image)
        fingerprint = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
        with self.lock:
            # Keep only small terminal metadata; never retain submitted images in job records.
            now = time.time()
            self.jobs = {k: j for k, j in self.jobs.items() if j["status"] not in TERMINAL or now - j["created"] < 86400}
            for job in self.jobs.values():
                if job["owner"] == owner and job["key"] == data["idempotencyKey"]:
                    if job["fingerprint"] != fingerprint:
                        fail(409, "editor_conflict", "重复请求的内容不一致")
                    return self.public(job)
            if len(self.jobs) >= 1000 or sum(j["status"] not in TERMINAL for j in self.jobs.values()) >= 4:
                fail(429, "editor_busy", "图片处理任务繁忙，请稍后重试")
            if any(j["owner"] == owner and j["status"] not in TERMINAL for j in self.jobs.values()):
                fail(429, "editor_busy", "已有图片处理任务正在运行")
            job = dict(id=secrets.token_urlsafe(18), owner=owner, key=data["idempotencyKey"], fingerprint=fingerprint,
                       documentId=data["documentId"], revision=data["revision"], status="queued", created=now, cancel=threading.Event())
            self.jobs[job["id"]] = job
            threading.Thread(target=self.work, args=(job, token, data), daemon=True).start()
            return self.public(job)

    def get(self, owner, job_id, cancel=False):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job or job["owner"] != owner:
                fail(404, "editor_not_found", "任务不存在或已过期")
            if cancel and job["status"] not in TERMINAL:
                job["cancel"].set()
                # Keep the running slot until the worker acknowledges cancellation.
            return self.public(job)

    def work(self, job, token, data):
        try:
            if job["cancel"].is_set():
                return
            kind = "text" if data["operation"] == "ocr" else "images"
            with self.state.reserve(token, kind, 1):
                with self.lock:
                    job["status"] = "running"
                result = self.ocr(data) if data["operation"] == "ocr" else self.fal_run(job, data)
                with self.lock:
                    if not job["cancel"].is_set():
                        job.update(status="succeeded", result=result)
        except StateError as exc:
            with self.lock:
                job.update(status="failed", error=exc.message)
        except Exception:
            with self.lock:
                job.update(status="failed", error="图片处理失败，请检查服务配置或重试")
        finally:
            with self.lock:
                if job["cancel"].is_set():
                    job.update(status="canceled")
                    job.pop("result", None)

    def fal_run(self, job, data):
        model = MODELS[data["operation"]]
        headers = {"Authorization": "Key " + self.fal}
        payload = {"image_url": data["image"], "output_format": "png"}
        if data["operation"] in ("erase", "expand"):
            payload.update(mask_url=data["mask"], prompt=data.get("prompt") or "Remove the marked object and seamlessly reconstruct the background. No text, no new objects.")
        elif data["operation"] == "upscale":
            payload.update(scale=data["scale"], model="RealESRGAN_x4plus")
        else:
            payload.update(num_layers=4, enable_safety_checker=True)
        submitted = self.provider("queue.fal.run", "/" + model, headers, payload)
        request_id = submitted.get("request_id", "")
        if not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", request_id):
            fail(502, "editor_provider", "模型返回了无效的任务编号")
        # fal queue request routes use the base model ID, not the subpath.
        base = "/" + "/".join(model.split("/")[:2]) + "/requests/" + request_id
        deadline = time.monotonic() + 540
        while time.monotonic() < deadline:
            if job["cancel"].wait(1):
                try:
                    self.provider("queue.fal.run", base + "/cancel", headers, method="PUT")
                except Exception:
                    pass
                return {}
            status = self.provider("queue.fal.run", base + "/status", headers)
            if status.get("status") == "COMPLETED":
                result = self.provider("queue.fal.run", base, headers)
                images = result.get("images") or ([result["image"]] if result.get("image") else [])
                if not isinstance(images, list) or not 1 <= len(images) <= 16:
                    fail(502, "editor_provider", "模型未返回有效图片")
                output = []
                for image in images:
                    media_token = self.media.register(image["url"], job["owner"])
                    output.append({"url": "/api/managed/media/" + media_token})
                return {"images": output}
            if status.get("status") not in ("IN_QUEUE", "IN_PROGRESS"):
                fail(502, "editor_provider", "模型处理失败")
        try:
            self.provider("queue.fal.run", base + "/cancel", headers, method="PUT")
        finally:
            fail(504, "editor_timeout", "图片处理超时，请稍后重试")

    def ocr(self, data):
        # Azure Read accepts binary images. Only the configured Azure host receives the key.
        raw = base64.b64decode(data["image"].split(",", 1)[1], validate=True)
        conn = http.client.HTTPSConnection(self.azure_host.netloc, timeout=60)
        try:
            conn.request("POST", "/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read", raw,
                         {"Ocp-Apim-Subscription-Key": self.azure_key, "Content-Type": "application/octet-stream"})
            response = conn.getresponse()
            raw_result = response.read(8 * 1024 * 1024 + 1)
            if response.status != 200 or len(raw_result) > 8 * 1024 * 1024:
                fail(502, "editor_ocr", "文字识别失败，请检查 Azure 服务配置")
            result = json.loads(raw_result)
            lines = []
            for block in result.get("readResult", {}).get("blocks", []):
                for line in block.get("lines", []):
                    words = line.get("words", [])
                    lines.append({"text": line["text"], "polygon": line["boundingPolygon"],
                                  "confidence": min((w.get("confidence", 0) for w in words), default=0)})
            return {"lines": lines[:200]}
        finally:
            conn.close()
