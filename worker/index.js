/**
 * Poker Agent Proxy — Cloudflare Worker
 *
 * The browser game (z80.wtf/poker) cannot hold an API key, so this Worker
 * proxies agent decisions to deepseek-v4-flash. The key lives here as a
 * Worker secret binding named ZEN_API_KEY.
 *
 * Request:  POST /  { "prompt": string, "system": string?, "maxTokens"?: number }
 * Response: 200   { "action": string, "raw": string, "model": string }
 *           4xx/5xx with { "error": string }
 *
 * The prompt instructs the model to answer `ACTION: <fold|check|call|bet N|raise N>`
 * exactly like the lemon_poker HeadsUpMatch runner, so the response is
 * forwarded as-is for the client-side parse_action().
 *
 * Robustness: deepseek-v4-flash is a reasoning model and occasionally returns
 * HTTP 200 with empty content (measured up to ~40% at max_tokens=800, ~10% at
 * 2048) when it spends the whole budget on reasoning_content. The worker
 * retries upstream on empty content (up to EMPTY_RETRIES times) so the game
 * client only sees a real failure when the model truly does not answer.
 */

const ZEN_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const MODEL = "deepseek-v4-flash";
const MAX_TOKENS = 2048;
const EMPTY_RETRIES = 2;
// thinking disabled: measured Aug 2026 on the zen endpoint — mean 10.1s -> 1.3s,
// reasoning_content 6030 -> 0, empties 0 (empties were reasoning-budget burn).
const THINKING_DISABLED = { type: "disabled" };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    if (!env.ZEN_API_KEY) {
      return json({ error: "server misconfigured: ZEN_API_KEY missing" }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }

    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) {
      return json({ error: "prompt is required" }, 400);
    }

    const system =
      typeof body.system === "string" && body.system.trim()
        ? body.system.trim()
        : "You are a poker agent. Be concise. Follow the response format exactly.";

    const maxTokens = Number.isInteger(body.maxTokens)
      ? Math.min(Math.max(body.maxTokens, 64), 4096)
      : MAX_TOKENS;

    const messages = [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ];

    const attempts = EMPTY_RETRIES;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await callUpstream(env, messages, maxTokens);
      if (result.kind === "ok") {
        const content = result.content ?? "";
        if (content.trim()) {
          return json({
            action: extractActionLine(content),
            raw: content,
            model: result.model ?? MODEL,
            attempts: attempt,
          });
        }
        // Empty content — retry. Reasoning-budget burn is transient.
      } else {
        return json({ error: result.error }, result.status ?? 502);
      }
    }

    return json({ error: "upstream returned empty content repeatedly" }, 502);
  },
};

async function callUpstream(env, messages, maxTokens) {
  try {
    const upstream = await fetch(ZEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.ZEN_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });

    const upstreamText = await upstream.text();
    if (!upstream.ok) {
      return {
        kind: "error",
        status: 502,
        error: `upstream ${upstream.status}: ${truncate(upstreamText, 300)}`,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(upstreamText);
    } catch {
      return { kind: "error", status: 502, error: "upstream returned invalid json" };
    }

    return {
      kind: "ok",
      content: parsed?.choices?.[0]?.message?.content ?? "",
      model: parsed?.model,
    };
  } catch (err) {
    return {
      kind: "error",
      status: 500,
      error: `worker error: ${String(err?.message ?? err)}`,
    };
  }
}

function extractActionLine(content) {
  if (typeof content !== "string") return "";
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const actionLine = lines.find((l) => /^action:/i.test(l)) ?? lines[0] ?? "";
  return actionLine.replace(/^action:\s*/i, "").trim();
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
