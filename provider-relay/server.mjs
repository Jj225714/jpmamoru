/** Stateless BYOK relay. Diagnostics contain only request metadata, never credentials or bodies. */
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { pathToFileURL } from "node:url";
import { realpathSync, appendFile } from "node:fs";
import { randomUUID } from "node:crypto";
import { JsonJobStore, FalJobService, createFalJobHandler } from "./job-service.mjs";
import { GptJobs, createGptJobHandler } from "./gpt-jobs.mjs";
import { loadQueueKey } from './queue-crypto.mjs';
import { createVaultSessionAuthenticator, loadLegacyIntentGuard } from './job-auth.mjs';

export const PREFIX = "/api/providers";
const LIMIT = 48 * 1024 * 1024;
const DIAGNOSTICS_LOG = process.env.AOWEISI_DIAGNOSTICS_LOG || "/var/log/aoweisi/provider-relay.jsonl";
function diagnosticError(error) {
  if (error?.status === 413) return "request_too_large";
  if (error?.status === 429) return "relay_busy_or_provider_limited";
  if (error?.name === "AbortError") return "upstream_timeout";
  return "relay_or_upstream_failure";
}
function writeDiagnostic(event) {
  const line = JSON.stringify({ ts: new Date().toISOString(), service: "provider-relay", ...event }) + "\n";
  appendFile(DIAGNOSTICS_LOG, line, { mode: 0o640 }, () => {});
}
const models = {
  "flux-fill": "fal-ai/flux-pro/v1/fill",
  esrgan: "fal-ai/esrgan",
  "qwen-layered": "fal-ai/qwen-image-layered",
};
const rejection = (status, message) =>
  Object.assign(new Error(message), { status });
const fail = (status, message) => {
  throw rejection(status, message);
};
const publicAddress = (address) => {
  const value = address.toLowerCase();
  if (value.includes(":")) return !/^(::|fc|fd|fe[89ab]|ff)/.test(value);
  const [a, b] = value.split(".").map(Number);
  return (
    a > 0 &&
    a < 224 &&
    a !== 10 &&
    a !== 127 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) &&
    !(a === 100 && b >= 64 && b <= 127)
  );
};
function originAllowed(req, origin) {
  if (
    req.headers["sec-fetch-site"] &&
    !["same-origin", "none"].includes(req.headers["sec-fetch-site"])
  )
    return false;
  if (origin) {
    return (
      req.headers.host === new URL(origin).host &&
      (req.headers.origin === origin ||
        (req.method === "GET" &&
          !req.headers.origin &&
          req.headers["sec-fetch-site"] === "same-origin"))
    );
  }
  // Vite runs only on the local machine; never trust an arbitrary Host in production.
  try {
    const host = new URL("http://" + req.headers.host);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname))
      return false;
    if (req.headers.origin)
      return new URL(req.headers.origin).host === host.host;
    return (
      req.method === "GET" ||
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress,
      )
    );
  } catch {
    return false;
  }
}
export function routeFor(req, origin) {
  if (!originAllowed(req, origin)) fail(403, "请求来源不允许");
  const path = req.url || "";
  if (path.startsWith(PREFIX + "/media?")) {
    if (req.method !== "GET") fail(405, "不支持的方法");
    const query = new URL(path, "http://localhost").searchParams;
    if ([...query.keys()].length !== 1 || !query.has("url"))
      fail(400, "无效媒体地址");
    let url;
    try {
      url = new URL(query.get("url"));
    } catch {
      fail(400, "无效媒体地址");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !/^(?:[a-z0-9-]+\.)*fal\.media$/i.test(url.hostname)
    )
      fail(403, "仅允许 fal 图片地址");
    return {
      host: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: {},
      media: true,
    };
  }
  if (
    !/^Bearer [A-Za-z0-9._~+/:=-]{1,512}$/.test(req.headers.authorization || "")
  )
    fail(401, "请在渠道中填写有效 API Key");
  const key = req.headers.authorization.slice(7);
  if (path === PREFIX + "/azure/read" && req.method === "POST") {
    const resource = req.headers["x-azure-resource"];
    if (typeof resource !== "string" || !/^[a-z0-9-]{1,63}$/i.test(resource))
      fail(400, "无效 Azure 资源名称");
    return {
      host: resource.toLowerCase() + ".cognitiveservices.azure.com",
      path: "/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read",
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/octet-stream",
      },
      azure: true,
    };
  }
  const submit = path.match(
    /^\/api\/providers\/fal\/submit\/(flux-fill|esrgan|qwen-layered)$/,
  );
  if (submit && req.method === "POST")
    return {
      host: "queue.fal.run",
      path: "/" + models[submit[1]],
      method: "POST",
      headers: {
        Authorization: "Key " + key,
        "Content-Type": "application/json",
      },
      model: submit[1],
    };
  const job = path.match(
    /^\/api\/providers\/fal\/requests\/(flux-fill|esrgan|qwen-layered)\/([A-Za-z0-9_-]{1,100})\/(status|result|cancel)$/,
  );
  if (job && req.method === (job[3] === "cancel" ? "POST" : "GET")) {
    const base = models[job[1]].split("/").slice(0, 2).join("/");
    return {
      host: "queue.fal.run",
      path: `/${base}/requests/${job[2]}${job[3] === "result" ? "" : "/" + job[3]}`,
      method: job[3] === "cancel" ? "PUT" : "GET",
      headers: { Authorization: "Key " + key },
    };
  }
  fail(404, "接口不存在");
}
function pngDimensions(value) {
  if (
    typeof value !== "string" ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value) ||
    value.length > LIMIT
  )
    fail(400, "仅支持 PNG 图片");
  const bytes = Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(12, 16).toString() !== "IHDR"
  )
    fail(400, "无效 PNG 图片");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || Math.max(width, height) > 4096)
    fail(400, "图片最长边不得超过 4096 像素");
  return { width, height, bytes };
}
export function providerBody(route, raw) {
  if (!route.model && !route.azure) return undefined;
  let input;
  try {
    input = JSON.parse(raw.toString());
  } catch {
    fail(400, "无效请求");
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "无效请求");
  const allowed = route.azure
    ? ["image_url"]
    : route.model === "flux-fill"
      ? ["image_url", "mask_url", "prompt"]
      : route.model === "esrgan"
        ? ["image_url", "scale"]
        : ["image_url"];
  if (Object.keys(input).some((k) => !allowed.includes(k)))
    fail(400, "不支持的请求参数");
  const image = pngDimensions(input.image_url);
  if (route.azure) return image.bytes;
  if (route.model === "flux-fill") {
    const mask = pngDimensions(input.mask_url);
    if (
      mask.width !== image.width ||
      mask.height !== image.height ||
      typeof input.prompt !== "string" ||
      input.prompt.length > 2000
    )
      fail(400, "蒙版尺寸或提示词无效");
    return Buffer.from(
      JSON.stringify({ ...input, output_format: "png", num_images: 1 }),
    );
  }
  if (route.model === "esrgan") {
    if (
      ![2, 4].includes(input.scale) ||
      Math.max(image.width, image.height) * input.scale > 4096
    )
      fail(400, "高清输出最长边不得超过 4096 像素");
    return Buffer.from(
      JSON.stringify({
        ...input,
        model: "RealESRGAN_x4plus",
        output_format: "png",
      }),
    );
  }
  return Buffer.from(
    JSON.stringify({
      image_url: input.image_url,
      num_layers: 4,
      enable_safety_checker: true,
      output_format: "png",
    }),
  );
}
async function readBody(req) {
  if (req.headers["transfer-encoding"] || req.headers["content-encoding"])
    fail(400, "不支持的传输格式");
  const length = Number(req.headers["content-length"] || 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > LIMIT)
    fail(413, "图片请求过大");
  if (length && !req.headers["content-type"]?.startsWith("application/json"))
    fail(400, "仅支持 JSON 请求");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) fail(413, "图片请求过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function forward(route, body, signal) {
  const addresses = await lookup(route.host, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    fail(403, "服务地址不可访问");
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: route.host,
        path: route.path,
        method: route.method,
        headers: {
          ...route.headers,
          ...(body ? { "Content-Length": body.length } : {}),
        },
        signal,
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > (route.media ? 32 * 1024 * 1024 : 8 * 1024 * 1024)) {
            request.destroy(rejection(413, "模型响应过大"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode || 502,
            type: response.headers["content-type"] || "application/json",
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}
export function createProviderHandler({ origin, transport = forward, jobHandler, gptJobHandler } = {}) {
  let active = 0,
    activeBytes = 0;
  return async (req, res, next) => {
    if (!req.url?.startsWith(PREFIX + "/")) return next?.();
    if (gptJobHandler && await gptJobHandler(req, res)) return;
    if (jobHandler && await jobHandler(req, res)) return;
    const requestId = randomUUID();
    res.setHeader("X-Diagnostics-Request-Id", requestId);
    const startedAt = Date.now();
    let routeName = "unknown";
    let upstreamStatus;
    let diagnosticWritten = false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const reply = (status, message) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message } }));
    };
    let admitted = false,
      size = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 65_000);
    const closed = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", closed);
    try {
      const route = routeFor(req, origin);
      routeName = route.media ? "media" : route.host === "queue.fal.run" ? "fal" : "azure";
      res.setHeader("X-Diagnostics-Request-Id", requestId);
      size = Number(req.headers["content-length"] || 0);
      if (!Number.isSafeInteger(size) || size < 0 || size > LIMIT)
        fail(413, "图片请求过大");
      if (active >= 8 || activeBytes + size > 128 * 1024 * 1024)
        fail(429, "处理请求繁忙，请稍后重试");
      active++;
      activeBytes += size;
      admitted = true;
      req.setTimeout(30_000, () => req.destroy());
      const body =
        req.method === "POST"
          ? providerBody(route, await readBody(req))
          : undefined;
      const result = await transport(route, body, controller.signal);
      upstreamStatus = result.status;
      if (result.status < 200 || result.status >= 300) {
        const status = [401, 403, 429].includes(result.status)
          ? result.status
          : 502;
        fail(
          status,
          status === 401 || status === 403
            ? "服务商拒绝请求，请检查渠道密钥与权限"
            : status === 429
              ? "服务商额度或并发限制，请稍后重试"
              : "专用服务请求失败，请检查渠道配置",
        );
      }
      if (route.media && !/^image\/(png|jpeg|webp)(?:;|$)/.test(result.type))
        fail(502, "服务未返回有效图片");
      writeDiagnostic({
        requestId,
        route: routeName,
        status: 200,
        upstreamStatus,
        outcome: "completed",
        durationMs: Date.now() - startedAt,
        requestBytes: size || null,
      });
      diagnosticWritten = true;
      if (res.destroyed) return;
      res.writeHead(200, {
        "Content-Type": route.media ? result.type : "application/json",
      });
      res.end(result.body);
    } catch (error) {
      writeDiagnostic({
        requestId,
        route: routeName,
        status: error.status || (upstreamStatus >= 400 ? 502 : 500),
        upstreamStatus: upstreamStatus || null,
        outcome: "failed",
        error: diagnosticError(error),
        durationMs: Date.now() - startedAt,
        requestBytes: size || null,
      });
      diagnosticWritten = true;
      reply(
        error.status || 502,
        error.status ? error.message : "图片服务连接失败或超时，请检查渠道配置",
      );
    } finally {
      if (!diagnosticWritten && !res.destroyed) {
        writeDiagnostic({
          requestId,
          route: routeName,
          status: res.statusCode || 200,
          upstreamStatus: null,
          outcome: "completed",
          durationMs: Date.now() - startedAt,
          requestBytes: size || null,
        });
      }
      clearTimeout(timer);
      res.off("close", closed);
      if (admitted) {
        active--;
        activeBytes -= size;
      }
    }
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const origin = process.argv[process.argv.indexOf("--origin") + 1];
  if (!process.argv.includes("--origin") || !/^https?:\/\//.test(origin))
    throw new Error("Provide --origin with the public site origin");
  let jobHandler;
  let gptJobHandler;
  const jobPath = process.env.AOWEISI_JOB_STORE;
  // No bearer-only fallback: a shared provider key is not an application identity.
  const authenticate = jobPath ? createVaultSessionAuthenticator({ sessionUrl: process.env.JOB_AUTH_SESSION_URL, cookieName: process.env.JOB_AUTH_COOKIE_NAME, origin }) : undefined;
  if (jobPath) {
    const store = new JsonJobStore(`${jobPath}.account-v1`);
    const legacyGuard = await loadLegacyIntentGuard(jobPath, 'fal');
    const provider = {
      async call(model, action, credential, payload) {
        const suffix = action === "submit" ? `/submit/${model}` : `/requests/${model}/${payload}/${action}`;
        const req = { url: PREFIX + "/fal" + suffix, method: action === "cancel" ? "POST" : action === "status" || action === "result" ? "GET" : "POST", headers: { host: new URL(origin).host, origin, authorization: "Bearer " + credential }, socket: { remoteAddress: "127.0.0.1" } };
        const route = routeFor(req, origin);
        const body = action === "submit" ? providerBody(route, Buffer.from(JSON.stringify(payload))) : undefined;
        const response = await forward(route, body, AbortSignal.timeout(65_000));
        if (response.status < 200 || response.status >= 300) throw Object.assign(new Error("provider request failed"), { status: response.status });
        return JSON.parse(response.body.toString("utf8"));
      },
      submit: (model, payload, credential) => provider.call(model, "submit", credential, payload),
      status: (model, id, credential) => provider.call(model, "status", credential, id),
      result: (model, id, credential) => provider.call(model, "result", credential, id),
      cancel: (model, id, credential) => provider.call(model, "cancel", credential, id),
    };
    const falService = new FalJobService({ store, provider, requireAccountOwnership: true, legacyGuard,
      queueKey: loadQueueKey(process.env.FAL_JOB_QUEUE_KEY_FILE),
      maxActive: Number(process.env.FAL_JOB_MAX_ACTIVE || 2), modelLimits: JSON.parse(process.env.FAL_JOB_MODEL_LIMITS || '{}') });
    await falService.init();
    jobHandler = createFalJobHandler({ service: falService, origin, authenticate });
  }
  const gptPath = jobPath ? `${jobPath}.gpt` : undefined;
  if (gptPath) {
    const legacyGuard = await loadLegacyIntentGuard(gptPath, 'gpt');
    const gptService = new GptJobs({ path: `${gptPath}.account-v1`, requireAccountOwnership: true, legacyGuard,
      queueKey: loadQueueKey(process.env.GPT_JOB_QUEUE_KEY_FILE),
      maxActive: Number(process.env.GPT_JOB_MAX_ACTIVE || 2), modelLimits: JSON.parse(process.env.GPT_JOB_MODEL_LIMITS || '{}') });
    await gptService.init();
    gptJobHandler = createGptJobHandler({ service: gptService, origin, authenticate });
  }
  const handler = createProviderHandler({ origin, jobHandler, gptJobHandler });
  http
    .createServer((req, res) =>
      handler(req, res, () => {
        res.writeHead(404).end();
      }),
    )
    .listen(3181, "127.0.0.1");
}

