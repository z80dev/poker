/**
 * AGENTPOKER Agent Proxy + Analytics — Cloudflare Worker
 *
 * The browser game (z80.wtf/poker) cannot hold an API key, so this Worker
 * proxies agent decisions to deepseek-v4-flash. The key lives here as a
 * Worker secret binding named ZEN_API_KEY.
 *
 * It also ingests game analytics into D1 (binding `poker_analytics`):
 *   POST /event  {event, session, data}  — client-side telemetry
 *   POST /       {prompt, system?, maxTokens?} — agent decision (existing)
 *   GET  /stats                          — aggregates for the stats page
 *
 * Request:  POST /  { "prompt": string, "system": string?, "maxTokens"?: number }
 * Response: 200   { "action": string, "raw": string, "model": string }
 *           4xx/5xx with { "error": string }
 *
 * The prompt instructs the model to answer `ACTION: <fold|check|call|bet N|raise N>`
 * exactly like the lemon_poker HeadsUpMatch runner, so the response is
 * forwarded as-is for the client-side parse_action().
 *
 * Robustness: deepseek-v4-flash with thinking disabled (see THINKING_DISABLED)
 * returns fast, non-empty answers; EMPTY_RETRIES remains as cheap insurance.
 */

const ZEN_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const MODEL = "deepseek-v4-flash";
const MAX_TOKENS = 2048;
const EMPTY_RETRIES = 2;
// thinking disabled: measured Aug 2026 on the zen endpoint — mean 10.1s -> 1.3s,
// reasoning_content 6030 -> 0, empties 0 (empties were reasoning-budget burn).
const THINKING_DISABLED = { type: "disabled" };

const CLIENT_EVENTS = new Set([
  "page_view",
  "match_start",
  "hand_end",
  "match_end",
  "fallback_used",
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Analytics ingest
    if (url.pathname === "/event" && request.method === "POST") {
      return handleEvent(request, env);
    }

    // Stats aggregates (public — aggregate numbers only, no PII)
    if (url.pathname === "/stats" && request.method === "GET") {
      return handleStats(env);
    }

    if (url.pathname === "/healthz") {
      return json({ ok: true, db: !!env.poker_analytics }, 200);
    }

    // Agent decision (legacy root POST)
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

    const t0 = Date.now();
    const attempts = EMPTY_RETRIES;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await callUpstream(env, messages, maxTokens);
      if (result.kind === "ok") {
        const content = result.content ?? "";
        if (content.trim()) {
          const latencyMs = Date.now() - t0;
          const resp = json({
            action: extractActionLine(content),
            raw: content,
            model: result.model ?? MODEL,
            attempts: attempt,
          });
          // Log the decision server-side (fire-and-forget; never delays the game).
          ctx.waitUntil(logDecision(env, {
            action: extractActionLine(content),
            latency_ms: latencyMs,
            attempts: attempt,
          }));
          return resp;
        }
        // Empty content — retry. Reasoning-budget burn is transient.
      } else {
        return json({ error: result.error }, result.status ?? 502);
      }
    }

    return json({ error: "upstream returned empty content repeatedly" }, 502);
  },
};

/* ------------------------------------------------------------- analytics */

async function handleEvent(request, env) {
  const db = env.poker_analytics;
  if (!db) return json({ ok: false, error: "analytics disabled" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }

  const event = typeof body.event === "string" ? body.event : "";
  if (!CLIENT_EVENTS.has(event)) {
    return json({ error: `unknown event: ${event}` }, 400);
  }
  const session = typeof body.session === "string" && body.session.trim()
    ? body.session.slice(0, 64)
    : "anon";
  const payload = body.data && typeof body.data === "object"
    ? JSON.stringify(body.data).slice(0, 2000)
    : "{}";
  const ts = Date.now();
  const day = new Date(ts).toISOString().slice(0, 10);

  try {
    await db
      .prepare(
        "INSERT INTO events (ts, day, event, session, payload) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(ts, day, event, session, payload)
      .run();
    return json({ ok: true }, 200);
  } catch (err) {
    return json(
      { ok: false, error: String(err?.message ?? err).slice(0, 200) },
      500,
    );
  }
}

async function handleStats(env) {
  const db = env.poker_analytics;
  if (!db) return json({ error: "analytics disabled" }, 503);

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);

  try {
    const [byEvent, visitors, todayVisitors, handWinners, matchNet, agent, daily, recent] =
      await Promise.all([
        db.prepare("SELECT event, COUNT(*) AS n FROM events GROUP BY event").all(),
        db
          .prepare(
            "SELECT COUNT(DISTINCT session) AS v, COUNT(*) AS p FROM events WHERE event = 'page_view'",
          )
          .first(),
        db
          .prepare(
            "SELECT COUNT(DISTINCT session) AS v FROM events WHERE event = 'page_view' AND day = ?",
          )
          .bind(today)
          .first(),
        db
          .prepare(
            "SELECT json_extract(payload, '$.winner') AS w, COUNT(*) AS n FROM events WHERE event = 'hand_end' GROUP BY w",
          )
          .all(),
        db
          .prepare(
            "SELECT COALESCE(SUM(json_extract(payload, '$.net')), 0) AS net, COUNT(*) AS n FROM events WHERE event = 'match_end'",
          )
          .first(),
        db
          .prepare(
            "SELECT COUNT(*) AS n, COALESCE(AVG(json_extract(payload, '$.latency_ms')), 0) AS avg_ms, COALESCE(SUM(json_extract(payload, '$.attempts') > 1), 0) AS retried FROM events WHERE event = 'agent_decision'",
          )
          .first(),
        db
          .prepare(
            "SELECT day, SUM(CASE WHEN event = 'page_view' THEN 1 ELSE 0 END) AS pageviews, SUM(CASE WHEN event = 'hand_end' THEN 1 ELSE 0 END) AS hands FROM events WHERE day >= ? GROUP BY day ORDER BY day",
          )
          .bind(weekAgo)
          .all(),
        db
          .prepare(
            "SELECT ts, event, session, substr(payload, 1, 80) AS payload FROM events ORDER BY id DESC LIMIT 8",
          )
          .all(),
      ]);

    const totals = {};
    for (const row of byEvent.results || []) totals[row.event] = row.n;

    const winners = {};
    for (const row of handWinners.results || []) winners[row.w || "?"] = row.n;

    return json(
      {
        totals,
        visitors: visitors?.v || 0,
        pageviews: visitors?.p || 0,
        visitors_today: todayVisitors?.v || 0,
        hand_winners: winners,
        matches: matchNet?.n || 0,
        net_chips: Math.round(matchNet?.net || 0),
        agent: {
          decisions: agent?.n || 0,
          avg_latency_ms: Math.round(agent?.avg_ms || 0),
          retried: agent?.retried || 0,
        },
        daily: (daily.results || []).map((r) => ({
          day: r.day,
          pageviews: r.pageviews,
          hands: r.hands,
        })),
        recent: (recent.results || []).map((r) => ({
          ts: r.ts,
          event: r.event,
          session: String(r.session).slice(0, 8),
          payload: r.payload,
        })),
      },
      200,
    );
  } catch (err) {
    return json({ error: String(err?.message ?? err).slice(0, 200) }, 500);
  }
}

function logDecision(env, data) {
  if (!env.poker_analytics) return Promise.resolve();
  const ts = Date.now();
  const day = new Date(ts).toISOString().slice(0, 10);
  return env.poker_analytics
    .prepare(
      "INSERT INTO events (ts, day, event, session, payload) VALUES (?, ?, 'agent_decision', 'agent', ?)",
    )
    .bind(ts, day, JSON.stringify(data))
    .run()
    .catch(() => {});
}

/* ------------------------------------------------------------ upstream */

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
        thinking: THINKING_DISABLED,
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
