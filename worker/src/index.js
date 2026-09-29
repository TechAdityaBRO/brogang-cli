// Cloudflare Worker that powers the Bro Gang AI CLI free endpoint.
//
// Deploy this to brogang.techaditya.workers.dev and the CLI's default
// provider works with no API key, no account, and no setup.
//
//   npm i -g wrangler
//   wrangler deploy --config worker/wrangler.toml
//
// The endpoint speaks the OpenAI chat completions shape, so it also serves
// any other OpenAI-compatible client.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight for browser clients (the BRO GANG site chat box).
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    // GET /v1/models — lets clients list models without a key.
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json({
        object: "list",
        data: [{ id: MODEL(env), object: "model", owned_by: "brogang" }],
      });
    }

    // POST /v1/chat/completions — the main event.
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      return handleChat(request, env);
    }

    // A friendly landing for anyone who hits the root in a browser.
    if (url.pathname === "/" || url.pathname === "/v1") {
      return json({
        name: "Bro Gang AI",
        version: "0.1.0",
        free: true,
        endpoint: "/v1/chat/completions",
        docs: "https://github.com/TechAdityaBRO/brogang-cli",
        built_by: "BRO GANG · East 2022",
      });
    }

    return json({ error: `not found: ${url.pathname}` }, 404);
  },
};

const MODEL = (env) => env.BG_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

async function handleChat(request, env) {
  if (!env.AI) {
    return json({ error: { message: "Workers AI binding missing" } }, 500);
  }

  // Rate limiting: a single counter per client, kept in memory. Free tier
  // means cheap, not unlimited — a light guard keeps it running for everyone.
  const client = request.headers.get("cf-connecting-ip") || "unknown";
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

  // The CLI sends tools; Workers AI supports tool definitions, so forward them.
  const body = {
    model: payload.model && String(payload.model).startsWith("@cf/")
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

  // Workers AI returns { result: { content } } for chat; normalise it into
  // the OpenAI shape the CLI expects, including tool calls.
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

// normalizeContent pulls text out of whichever shape Workers AI returned.
function normalizeContent(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.content === "string") return result.content;
  if (typeof result.response === "string") return result.response;
  if (typeof result.text === "string") return result.text;

  // Some models reply with a list of content blocks.
  if (Array.isArray(result.content)) {
    return result.content
      .map((block) => (typeof block === "string" ? block : block.text || ""))
      .join("");
  }
  return "";
}

// extractToolCalls converts Workers AI tool output into OpenAI tool calls.
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

// checkRate allows 20 requests per minute per client using the Cloudflare
// cache as a lightweight counter, so no KV is required for the free tier.
async function checkRate(env, client) {
  const limit = 20;
  const windowMs = 60_000;
  const key = `bg_rl:${client}:${Math.floor(Date.now() / windowMs)}`;
  const now = Date.now();

  const cached = await env.CACHE?.match(key);
  if (cached) {
    const count = parseInt(await cached.text(), 10) || 0;
    if (count >= limit) return { ok: false, count };
    await env.CACHE.put(key, String(count + 1), { expirationTtl: 120 });
    return { ok: true, count: count + 1 };
  }

  await env.CACHE?.put(key, "1", { expirationTtl: 120 });
  return { ok: true, count: 1, now };
}

// countTokens is a cheap approximation for usage reporting.
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
