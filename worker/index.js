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
 */

const ZEN_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const MODEL = "deepseek-v4-flash";
const MAX_TOKENS = 800;

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
      ? Math.min(Math.max(body.maxTokens, 64), 2048)
      : MAX_TOKENS;

    const messages = [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ];

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
        return json(
          {
            error: `upstream ${upstream.status}: ${truncate(upstreamText, 300)}`,
          },
          502,
        );
      }

      let parsed;
      try {
        parsed = JSON.parse(upstreamText);
      } catch {
        return json({ error: "upstream returned invalid json" }, 502);
      }

      const content = parsed?.choices?.[0]?.message?.content ?? "";

      return json({
        action: extractActionLine(content),
        raw: content,
        model: parsed?.model ?? MODEL,
      });
    } catch (err) {
      return json(
        { error: `worker error: ${String(err?.message ?? err)}` },
        500,
      );
    }
  },
};

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
