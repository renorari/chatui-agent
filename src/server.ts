import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SiteConfig } from "./browser.ts";
import { Engine, log } from "./engine.ts";
import { openBackend } from "./page.ts";
import { handleOpenAI } from "./openai.ts";
import { countTokens, handleAnthropic } from "./anthropic.ts";
import { readBody, sendJson } from "./http.ts";

const root = resolve(import.meta.dirname, "..");
const env = process.env;
const SITE = env.SITE ?? "chatgpt";
const PORT = Number(env.PORT ?? 8787);
const MODEL_ID = `chatui-${SITE}`;

const sites = JSON.parse(readFileSync(env.SITES_FILE ?? resolve(root, "sites.json"), "utf8")) as Record<string, SiteConfig>;
const site = sites[SITE];
if (!site) throw new Error(`unknown SITE "${SITE}". available: ${Object.keys(sites).join(", ")}`);

const backend = await openBackend({
  kind: (env.BROWSER ?? "playwright") as "playwright" | "chrome" | "safari",
  profileDir: env.PROFILE_DIR ?? resolve(root, "profile"),
  cdpUrl: env.CDP_URL,
});
const engine = await Engine.create(
  backend,
  site,
  {
    stableMs: Number(env.STABLE_MS ?? 1500),
    timeoutMs: Number(env.TIMEOUT_MS ?? 10 * 60_000),
  },
  Number(env.MAX_TABS ?? 2),
);

const modelInfo = { id: MODEL_ID, object: "model", created: 0, owned_by: "chatui-agent", type: "model", display_name: MODEL_ID };

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const path = (req.url ?? "/").split("?")[0].replace(/^\/v1(?=\/)/, "");

  try {
    // OpenAI-compatible (also what Xcode's "Locally Hosted" provider speaks)
    if (req.method === "GET" && path === "/models") return sendJson(res, 200, { object: "list", data: [modelInfo] });
    if (req.method === "POST" && path === "/chat/completions") return await handleOpenAI(engine, await readBody(req), res, MODEL_ID);

    // Anthropic Messages API
    if (req.method === "POST" && path === "/messages") return await handleAnthropic(engine, await readBody(req), res, MODEL_ID);
    if (req.method === "POST" && path === "/messages/count_tokens") return countTokens(await readBody(req), res);

    // Minimal Ollama API so clients that only speak Ollama (e.g. Copilot's Ollama provider) can connect.
    if (path === "/api/version") return sendJson(res, 200, { version: "0.6.0" });
    if (path === "/api/tags") {
      return sendJson(res, 200, { models: [{ name: MODEL_ID, model: MODEL_ID, modified_at: new Date(0).toISOString(), size: 0, digest: "", details: { family: "chatui" } }] });
    }
    if (path === "/api/show") {
      return sendJson(res, 200, {
        model_info: { "general.architecture": "chatui", "chatui.context_length": 128000 },
        capabilities: ["completion", "tools"],
        details: { family: "chatui" },
      });
    }
    if (path === "/health") return sendJson(res, 200, { ok: true, site: SITE, tabs: engine.tabCount });

    sendJson(res, 404, { error: { message: `not found: ${req.method} ${path}` } });
  } catch (err) {
    log(`error: ${(err as Error).stack ?? err}`);
    if (res.headersSent) {
      res.end(`data: ${JSON.stringify({ type: "error", error: { type: "api_error", message: String(err) } })}\n\n`);
    } else {
      sendJson(res, 500, { type: "error", error: { type: "api_error", message: String(err) } });
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log(`chatui-agent: ${SITE} → http://127.0.0.1:${PORT}  (model: ${MODEL_ID})`);
});

// Exit right away; waiting for the browser to close gracefully can hang.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
