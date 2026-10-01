// Bro Gang AI — Cloudflare Pages advanced-mode Worker.
//
// This file sits at the repo root so it works no matter whether the build
// output directory is "/" or "worker/public". When _worker.js is present in
// the build output, Pages routes every request through it:
//
//   /            -> static landing page
//   /v1/*        -> OpenAI-compatible API the CLI calls
//   anything else -> 404 (source files are never served)
//
// Required dashboard binding (Settings -> Functions -> Bindings -> Add):
//   type: Workers AI      variable name: AI
// Optional variable:
//   BG_MODEL = @cf/meta/llama-3.3-70b-instruct-fp8-fast

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // The API lives under /v1.
    if (path === "/v1" || path.startsWith("/v1/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: cors() });
      }
      if (request.method === "GET" && path === "/v1/models") {
        return json({
          object: "list",
          data: [{ id: MODEL(env), object: "model", owned_by: "brogang" }],
        });
      }
      if (request.method === "POST" && path === "/v1/chat/completions") {
        return handleChat(request, env);
      }
      if (path === "/v1") {
        return json({
          name: "Bro Gang AI",
          version: "0.1.0",
          free: true,
          endpoint: "/v1/chat/completions",
          docs: "https://github.com/TechAdityaBRO/brogang-cli",
          built_by: "BRO GANG · East 2022",
        });
      }
      return json({ error: `not found: ${path}` }, 404);
    }

    // Static assets win; only a path that has no file falls back to the
    // landing page. The previous version rewrote every non-root URL to
    // /index.html, so /downloads/brogang-windows-amd64.zip returned HTML and
    // the WinGet manifest's InstallerUrl could never be downloaded.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: `not found: ${path}` }, 404);
    }

    // The release archives are staged here by CI, but a deployment produced
    // from a push that predates the release has no copy on disk. Fall back to
    // the GitHub release so a manifest published weeks ago keeps installing -
    // winget verifies the SHA-256 of the bytes either way.
    if (path.startsWith("/downloads/")) {
      const onDisk = await env.ASSETS.fetch(request);
      if (onDisk.status !== 404) return onDisk;
      const proxied = await fetchReleaseAsset(path.slice("/downloads/".length));
      if (proxied) return proxied;
      // Never answer an archive request with the SPA shell: an explicit 502
      // beats a hash mismatch that looks like a corrupted download.
      return new Response("release archive unavailable", {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), request));
  },
};

const DOWNLOAD_NAME = /^brogang-(linux|darwin|windows)-(amd64|arm64)\.(tar\.gz|zip)$/;
const DOWNLOAD_ALIASES = new Set(["SHA256SUMS.txt"]);

async function fetchReleaseAsset(name) {
  if (!DOWNLOAD_ALIASES.has(name) && !DOWNLOAD_NAME.test(name)) return null;
  let upstream;
  try {
    upstream = await fetch(
      `https://github.com/TechAdityaBRO/brogang-cli/releases/latest/download/${encodeURIComponent(name)}`,
      { redirect: "follow" },
    );
  } catch {
    return null;
  }
  if (!upstream.ok || !upstream.body) return null;
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(name),
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function contentTypeFor(name) {
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".tar.gz")) return "application/gzip";
  if (name.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

const MODEL = (env) =>
  env.BG_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

async function handleChat(request, env) {
  if (!env.AI) {
    return json(
      {
        error: {
          message:
            "Workers AI binding is missing. In the Pages dashboard go to " +
            "Settings -> Functions -> Bindings -> Add -> Workers AI, " +
            'and set the variable name to "AI".',
        },
      },
      500,
    );
  }

  const client =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown";
  const rl = await checkRate(env, client);
  if (!rl.ok) {
    return json(
      { error: { message: "Rate limit reached, try again in a minute." } },
      429,
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: { message: "Request body must be JSON." } }, 400);
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (messages.length === 0) {
    return json({ error: { message: "messages[] is required." } }, 400);
  }

  const body = {
    model:
      payload.model && String(payload.model).startsWith("@cf/")
        ? payload.model
        : MODEL(env),
    messages,
    max_tokens: clamp(payload.max_tokens || 2048, 64, 8192),
    temperature: clamp(payload.temperature ?? 0.7, 0, 2),
    stream: false,
  };
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    body.tools = payload.tools.slice(0, 16);
    body.tool_choice = "auto";
  }

  let result;
  try {
    result = await env.AI.run(body.model, body);
  } catch (err) {
    return json({ error: { message: `Model error: ${err.message}` } }, 502);
  }

  const content = normalizeContent(result);
  const toolCalls = extractToolCalls(result);

  const message = { role: "assistant", content };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return json({
    id: `bg-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: countTokens(messages),
      completion_tokens: countTokens([{ content }]),
      total_tokens: countTokens(messages) + countTokens([{ content }]),
    },
  });
}

function normalizeContent(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.content === "string") return result.content;
  if (typeof result.response === "string") return result.response;
  if (typeof result.text === "string") return result.text;
  if (Array.isArray(result.content)) {
    return result.content
      .map((block) => (typeof block === "string" ? block : block.text || ""))
      .join("");
  }
  return "";
}

function extractToolCalls(result) {
  const out = [];
  const found = result?.tool_calls || result?.tools || [];
  if (!Array.isArray(found)) return out;

  for (const call of found) {
    const fn = call.function || call;
    if (!fn || !fn.name) continue;
    out.push({
      id: call.id || `call_${out.length}`,
      type: "function",
      function: {
        name: fn.name,
        arguments:
          typeof fn.arguments === "string"
            ? fn.arguments
            : JSON.stringify(fn.arguments || {}),
      },
    });
  }
  return out;
}

// 20 requests per minute per client, kept in the Cloudflare cache so no KV
// namespace is needed. Without a cache binding the limit is skipped.
async function checkRate(env, client) {
  const limit = 20;
  const windowMs = 60_000;
  const key = `bg_rl:${client}:${Math.floor(Date.now() / windowMs)}`;

  if (!env.CACHE) return { ok: true, skipped: true };

  const cached = await env.CACHE.match(key);
  if (cached) {
    const count = parseInt(await cached.text(), 10) || 0;
    if (count >= limit) return { ok: false, count };
    await env.CACHE.put(key, String(count + 1), { expirationTtl: 120 });
    return { ok: true, count: count + 1 };
  }

  await env.CACHE.put(key, "1", { expirationTtl: 120 });
  return { ok: true, count: 1 };
}

function countTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
  }
  return Math.max(1, Math.round(chars / 4));
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || lo));

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
});

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
