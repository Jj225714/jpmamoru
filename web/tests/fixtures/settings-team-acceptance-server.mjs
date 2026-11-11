// Real vault handler, real AES-GCM files; only identity-provider responses are synthetic.
import { createServer } from "node:https";
import { request } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createVaultHandler } from "../../../config-vault/server.mjs";
const directory = process.argv[2];
const port = Number(process.env.SETTINGS_TEST_PORT || 8443);
const origin = `https://localhost:${port}`;
const storeDir = join(directory, "vault");
await mkdir(storeDir, { recursive: true });
const adminUsersFile = join(directory, "admins.json");
await writeFile(adminUsersFile, JSON.stringify([1]));
const user = (id) => ({ id: Number(id), email: `${id}@settings.test`, status: "active" });
const auth = (id) => ({ access_token: `synthetic-token-${id}`, refresh_token: `synthetic-refresh-${id}`, expires_in: 86400, user: user(id) });
const fetchImpl = async (url, options = {}) => {
    let data;
    if (url.endsWith("/auth/login")) {
        const body = JSON.parse(options.body);
        const id = body.email?.split("@")[0];
        if (!["1", "2", "3"].includes(id) || body.password !== "synthetic-password") return new Response("{}", { status: 401 });
        data = auth(id);
    } else if (url.endsWith("/auth/me")) {
        const id = options.headers.authorization?.split("-").at(-1);
        if (!["1", "2", "3"].includes(id)) return new Response("{}", { status: 401 });
        data = user(id);
    } else if (url.endsWith("/auth/refresh")) data = auth(JSON.parse(options.body).refresh_token.split("-").at(-1));
    else throw Error("Unexpected identity-provider request");
    return Response.json({ data });
};
const handler = createVaultHandler({ origin, authBaseUrl: "https://identity.invalid", storeDir, key: randomBytes(32), fetchImpl, adminUsersFile, publicRulesDir: join(directory, "public-rules") });
const server = createServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, (req, res) => {
    if (req.url.startsWith("/__local-workspace-migration")) {
        res.writeHead(204);
        return res.end();
    }
    if (req.url.startsWith("/api/config-vault/")) {
        const started = Date.now();
        if (req.method !== "GET") res.on("finish", () => console.error(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`));
        return void handler(req, res);
    }
    if (req.url === "/config.js") {
        res.setHeader("Content-Type", "application/javascript");
        return res.end("window.__RUNTIME_CONFIG__={serverConfigEnabled:true};");
    }
    if (req.url.startsWith("/api/")) {
        res.writeHead(403);
        return res.end("Models and other backends are disabled in this fixture");
    }
    const upstream = request(
        { hostname: "127.0.0.1", port: Number(process.env.SETTINGS_TEST_VITE_PORT || 3000), path: req.url, method: req.method, headers: { ...req.headers, host: "localhost:3000", origin: "http://localhost:3000", "accept-encoding": "identity" } },
        (response) => {
            if (req.url.startsWith("/@vite/client")) {
                let script = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => (script += chunk));
                response.on("end", () => {
                    const stable = script.replace("transport.connect(createHMRHandler(handleMessage));", "/* HMR disabled only in isolated real-service test */");
                    const headers = { ...response.headers };
                    delete headers["content-length"];
                    res.writeHead(response.statusCode, headers);
                    res.end(stable);
                });
                return;
            }
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
        },
    );
    upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("Local Vite unavailable");
    });
    req.pipe(upstream);
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
console.log(JSON.stringify({ url: origin }));
process.on("SIGTERM", () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
});
