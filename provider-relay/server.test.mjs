import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProviderHandler, routeFor, providerBody } from "./server.mjs";

const origin = "https://app.example";
const req = (url, method = "POST", headers = {}) => ({
  url,
  method,
  headers: {
    host: "app.example",
    origin,
    authorization: "Bearer user-key",
    ...headers,
  },
  socket: { remoteAddress: "127.0.0.1" },
});
function image(width = 64, height = 32) {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return "data:image/png;base64," + bytes.toString("base64");
}
test("only explicit fal routes and Azure resources receive caller credentials", () => {
  const fal = routeFor(req("/api/providers/fal/submit/flux-fill"), origin);
  assert.equal(fal.host, "queue.fal.run");
  assert.equal(fal.headers.Authorization, "Key user-key");
  const azure = routeFor(
    req("/api/providers/azure/read", "POST", {
      "x-azure-resource": "my-resource",
    }),
    origin,
  );
  assert.equal(azure.host, "my-resource.cognitiveservices.azure.com");
  assert.equal(azure.headers["Ocp-Apim-Subscription-Key"], "user-key");
  assert.throws(() =>
    routeFor(
      req("/api/providers/azure/read", "POST", {
        "x-azure-resource": "localhost/path",
      }),
      origin,
    ),
  );
});
test("foreign origins, missing keys, redirects and arbitrary model paths are rejected", () => {
  for (const input of [
    req("/api/providers/fal/submit/flux-fill", "POST", {
      origin: "https://evil.example",
    }),
    req("/api/providers/fal/submit/flux-fill", "POST", { authorization: "" }),
    req("/api/providers/fal/submit/../../arbitrary"),
    req("/api/providers/fal/submit/flux-fill?url=https://evil.example"),
    req("/api/providers/fal/requests/flux-fill/%2e%2e/result", "GET"),
  ])
    assert.throws(() => routeFor(input, origin));
});
test("media relay accepts only official HTTPS images and strips all credentials", () => {
  const media = routeFor(
    req(
      "/api/providers/media?url=" +
        encodeURIComponent("https://v3.fal.media/files/a.png?token=opaque"),
      "GET",
    ),
    origin,
  );
  assert.deepEqual(media.headers, {});
  assert.equal(media.path, "/files/a.png?token=opaque");
  for (const url of [
    "http://fal.media/a",
    "https://fal.media.evil.example/a",
    "https://127.0.0.1/a",
    "https://key@fal.media/a",
    "https://fal.media:8443/a",
  ])
    assert.throws(() =>
      routeFor(
        req("/api/providers/media?url=" + encodeURIComponent(url), "GET"),
        origin,
      ),
    );
});
test("model payloads validate real dimensions and do not accept callbacks or arbitrary options", () => {
  const route = routeFor(req("/api/providers/fal/submit/flux-fill"), origin);
  const raw = (body) => Buffer.from(JSON.stringify(body));
  const valid = {
    image_url: image(),
    mask_url: image(),
    prompt: "Remove text",
  };
  assert.equal(
    JSON.parse(providerBody(route, raw(valid))).mask_url,
    valid.mask_url,
  );
  assert.throws(() =>
    providerBody(route, raw({ ...valid, mask_url: image(1, 1) })),
  );
  assert.throws(() =>
    providerBody(route, raw({ ...valid, webhook: "https://evil.example" })),
  );
  const upscale = routeFor(req("/api/providers/fal/submit/esrgan"), origin);
  assert.throws(() =>
    providerBody(upscale, raw({ image_url: image(2048, 1024), scale: 4 })),
  );
  assert.equal(
    JSON.parse(providerBody(upscale, raw({ image_url: image(), scale: 2 })))
      .model,
    "RealESRGAN_x4plus",
  );
});
test("HTTP relay has no shared key or cookie and sanitizes provider failure bodies", async () => {
  const seen = [];
  let status = 200;
  const handler = createProviderHandler({
    origin,
    transport: async (route, body) => {
      seen.push({ route, body });
      return {
        status,
        type: "application/json",
        body: Buffer.from(
          status === 200 ? '{"request_id":"job-1"}' : "private-provider-secret",
        ),
      };
    },
  });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const request = (key) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ image_url: image() });
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/providers/fal/submit/qwen-layered",
          method: "POST",
          headers: {
            Host: "app.example",
            Origin: origin,
            Authorization: "Bearer " + key,
            Cookie: "old-code=private",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (data) => chunks.push(data));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              text: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  try {
    assert.equal((await request("first-key")).status, 200);
    status = 403;
    const rejected = await request("second-key");
    assert.equal(seen[0].route.headers.Authorization, "Key first-key");
    assert.equal(seen[1].route.headers.Authorization, "Key second-key");
    assert.equal(seen[0].route.headers.Cookie, undefined);
    assert.equal(rejected.status, 403);
    assert.ok(!rejected.text.includes("private-provider-secret"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
