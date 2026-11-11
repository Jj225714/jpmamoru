import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const digest = (value) => createHash("sha256").update(value).digest();

export function createSetupHandler(config, saveReceipt, alreadyCompleted = false) {
    let completed = alreadyCompleted;
    const expected = digest(config.token);
    return async (req, res) => {
        const reply = (status, body) => {
            res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            res.end(body ? JSON.stringify(body) : undefined);
        };
        if (!["/api/channel-setup/claim", "/api/channel-setup/complete"].includes(req.url)) return reply(404);
        if (req.method !== "POST") return reply(405);
        if (req.headers.host !== new URL(config.origin).host || req.headers.origin !== config.origin || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) return reply(403);
        const token = (req.headers.authorization || "").replace(/^Bearer /, "");
        if (!timingSafeEqual(expected, digest(token))) return reply(401);
        if (Date.now() >= config.expiresAt) return reply(410);
        if (completed) return reply(req.url.endsWith("/complete") ? 204 : 410);
        try {
            let body = "";
            for await (const chunk of req) {
                body += chunk.toString();
                if (Buffer.byteLength(body) > 2048) return reply(413);
            }
            if (req.url.endsWith("/claim")) return reply(200, config.channelFile);
            const receipt = JSON.parse(body);
            if (receipt.saved !== true || receipt.imageModel !== "gpt-image-2" || receipt.textModel !== "gpt-5.5" || receipt.keyHash !== digest(config.channelFile.channel.apiKey).toString("hex")) return reply(400);
            saveReceipt({ completedAt: new Date().toISOString(), imageModel: receipt.imageModel, textModel: receipt.textModel, saved: true });
            completed = true;
            return reply(204);
        } catch {
            return reply(400);
        }
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const receiptPath = process.argv[3];
    const handler = createSetupHandler(config, (receipt) => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 }), existsSync(receiptPath));
    const server = http.createServer(handler);
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.listen(3182, "127.0.0.1");
    // Expiry is enforced per request and also closes the temporary service.
    setTimeout(() => server.close(), Math.max(1, config.expiresAt - Date.now())).unref();
}
