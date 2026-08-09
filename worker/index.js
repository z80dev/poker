/**
 * AGENTPOKER Agent Proxy + Analytics — Cloudflare Worker
 *
 * The browser game (z80.wtf/poker) cannot hold an API key, so this Worker
 * proxies agent decisions to deepseek-v4-flash. The key lives here as a
 * Worker secret binding named ZEN_API_KEY.
 *
 * Security posture (hardened Aug 2026 — the endpoint is publicly reachable,
 * so the decision path is NOT a general-purpose LLM proxy):
 *   - Origin gate: POST / and POST /event require Origin: https://z80.wtf
 *     (blocks every cross-site browser call; browsers cannot spoof Origin)
 *   - Per-IP rate limits backed by D1 (decisions: 10/min, 500/day;
 *     events: 60/min, 5000/day)
 *   - System prompt is server-side only (client-supplied `system` ignored)
 *   - Prompt must match the poker request shape (contains "ACTION:") and is
 *     length-capped (4000 chars); maxTokens capped at 2048
 *   - Schema self-heals: events + rl tables created via the D1 binding on
 *     first use (no API-token DDL needed)
 *
 * Endpoints:
 *   POST /event  {event, session, data}  — client-side telemetry
 *   POST /       {prompt}                — agent decision (system ignored)
 *   GET  /stats                          — aggregates for the stats page
 *   GET  /healthz                        — liveness
 */

const ZEN_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const MODEL = "deepseek-v4-flash";
const MAX_TOKENS = 2048;
const EMPTY_RETRIES = 2;
// thinking disabled: measured Aug 2026 on the zen endpoint — mean 10.1s -> 1.3s,
// reasoning_content 6030 -> 0, empties 0 (empties were reasoning-budget burn).
const THINKING_DISABLED = { type: "disabled" };

const ALLOWED_ORIGIN = "https://z80.wtf";
const MAX_PROMPT_CHARS = 4000;
const CLIENT_MAX_TOKENS = 2048;
// Server-side persona: the client's system prompt is IGNORED so the proxy
// cannot be repurposed as a general chat lane (matches agent.js SYSTEM_PROMPT).
const SYSTEM_PROMPT = [
  "You are DEEPSEEK, a sharp, aggressive heads-up poker agent in a retro arcade cabinet.",
  "Play well: value bet strong hands, bluff sometimes, fold trash to pressure.",
  "You may write ONE short line of trash talk (max 60 chars) before your action.",
  "Your final line must be exactly: ACTION: <fold|check|call|bet N|raise N>",
  "Be concise. Follow the response format exactly.",
].join(" ");
// Every legit game prompt contains the ACTION: response-format directive.
const PROMPT_GATE = /action\s*:/i;

// Per-IP rate limits (D1-backed). 15/min fits legit turbo play (~8-12 agent
// decisions/min worst case); 500/day caps scripted abuse (a script would burn
// its whole daily allowance in ~34 min of hammering).
const DEC_MIN_PER_IP = 15;
const DEC_DAY_PER_IP = 500;
const EV_MIN_PER_IP = 60;
const EV_DAY_PER_IP = 5000;

const CLIENT_EVENTS = new Set([
  "page_view",
  "match_start",
  "hand_end",
  "match_end",
  "fallback_used",
  "human_action",
  "all_in",
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
};

/* --------------------------------------------------- schema (self-healing) */

let schemaPromise = null;

function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = db
      .batch([
        db.prepare(
          "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, event TEXT NOT NULL, session TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')",
        ),
        db.prepare(
          "CREATE INDEX IF NOT EXISTS idx_events_day ON events(day)",
        ),
        db.prepare(
          "CREATE INDEX IF NOT EXISTS idx_events_event ON events(event)",
        ),
        db.prepare(
          "CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
        ),
      ])
      .then(() => true)
      .catch((err) => {
        schemaPromise = null;
        throw err;
      });
  }
  return schemaPromise;
}

/* ------------------------------------------------------------- rate limit */

async function bump(db, key, now) {
  await db
    .prepare(
      "INSERT INTO rl (k, n, ts) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1, ts = excluded.ts",
    )
    .bind(key, now)
    .run();
  const row = await db.prepare("SELECT n FROM rl WHERE k = ?").bind(key).first();
  return row ? row.n : 1;
}

/** Returns 200 if allowed, 429 if over a per-IP limit. */
async function rateLimit(db, ip, scope) {
  const now = Date.now();
  const minKey = `${scope}:m:${ip}:${new Date(now).toISOString().slice(0, 16)}`;
  const dayKey = `${scope}:d:${ip}:${new Date(now).toISOString().slice(0, 10)}`;
  const minLimit = scope === "dec" ? DEC_MIN_PER_IP : EV_MIN_PER_IP;
  const dayLimit = scope === "dec" ? DEC_DAY_PER_IP : EV_DAY_PER_IP;

  const m = await bump(db, minKey, now);
  if (m > minLimit) return 429;
  const d = await bump(db, dayKey, now);
  if (d > dayLimit) return 429;

  // Opportunistic prune of stale rows (~2% of requests).
  if (Math.random() < 0.02) {
    db.prepare("DELETE FROM rl WHERE ts < ?")
      .bind(now - 48 * 3600 * 1000)
      .run()
      .catch(() => {});
  }
  return 200;
}

/* ------------------------------------------------------------------ fetch */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/event" && request.method === "POST") {
      return handleEvent(request, env);
    }

    if (url.pathname === "/stats" && request.method === "GET") {
      return handleStats(env);
    }

    if (url.pathname === "/healthz") {
      return json({ ok: true, db: !!env.poker_analytics }, 200);
    }

    // ---- agent decision (gated) ----
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    if (!env.ZEN_API_KEY) {
      return json({ error: "server misconfigured: ZEN_API_KEY missing" }, 500);
    }
    if (!originAllowed(request)) {
      return json({ error: "origin not allowed" }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }

    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return json({ error: "prompt is required" }, 400);
    if (prompt.length > MAX_PROMPT_CHARS) {
      return json({ error: "prompt too long" }, 400);
    }
    if (!PROMPT_GATE.test(prompt)) {
      return json({ error: "invalid prompt shape" }, 400);
    }

    const maxTokens = Number.isInteger(body.maxTokens)
      ? Math.min(Math.max(body.maxTokens, 64), CLIENT_MAX_TOKENS)
      : MAX_TOKENS;

    // Rate limit AFTER shape validation (cheap rejects don't burn quota).
    if (env.poker_analytics) {
      try {
        await ensureSchema(env.poker_analytics);
        const rl = await rateLimit(
          env.poker_analytics,
          clientIp(request),
          "dec",
        );
        if (rl === 429) {
          return json({ error: "rate limited" }, 429);
        }
      } catch (e) {
        // Rate limiting is a guard, not a gate: DB hiccups must not kill the game.
        console.error("rl error", String(e));
      }
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];

    const t0 = Date.now();
    for (let attempt = 1; attempt <= EMPTY_RETRIES; attempt++) {
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
          if (env.poker_analytics) {
            ctx.waitUntil(
              logDecision(env, {
                action: extractActionLine(content),
                latency_ms: latencyMs,
                attempts: attempt,
              }),
            );
          }
          return resp;
        }
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
  if (!originAllowed(request)) {
    return json({ error: "origin not allowed" }, 403);
  }

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
  const session =
    typeof body.session === "string" && body.session.trim()
      ? body.session.slice(0, 64)
      : "anon";
  const payload =
    body.data && typeof body.data === "object"
      ? JSON.stringify(body.data).slice(0, 2000)
      : "{}";
  const ts = Date.now();
  const day = new Date(ts).toISOString().slice(0, 10);

  try {
    await ensureSchema(db);
    const rl = await rateLimit(db, clientIp(request), "ev");
    if (rl === 429) return json({ error: "rate limited" }, 429);

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
    await ensureSchema(db);

    const [byEvent, visitors, todayVisitors, handWinners, matchNet, agent, play, humanActs, agentActs, daily, recent] =
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
            "SELECT COUNT(*) AS hands, COALESCE(SUM(json_extract(payload, '$.street') = 'SHOWDOWN'), 0) AS showdowns, COALESCE(AVG(json_extract(payload, '$.pot')), 0) AS avg_pot, COALESCE(MAX(json_extract(payload, '$.pot')), 0) AS max_pot, COALESCE(SUM(json_extract(payload, '$.big_pot') = 1), 0) AS big_pots FROM events WHERE event = 'hand_end'",
          )
          .first(),
        db
          .prepare(
            "SELECT json_extract(payload, '$.action') AS a, COUNT(*) AS n FROM events WHERE event = 'human_action' GROUP BY a",
          )
          .all(),
        db
          .prepare(
            "SELECT json_extract(payload, '$.action') AS a, COUNT(*) AS n FROM events WHERE event = 'agent_decision' GROUP BY a",
          )
          .all(),
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

    const toDist = (rows) => {
      const out = {};
      for (const row of rows || []) out[row.a || "?"] = row.n;
      return out;
    };

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
        play: {
          hands: play?.hands || 0,
          showdown_rate: play?.hands
            ? Math.round(((play.showdowns || 0) / play.hands) * 100)
            : 0,
          avg_pot: Math.round(play?.avg_pot || 0),
          max_pot: Math.round(play?.max_pot || 0),
          big_pots: play?.big_pots || 0,
          all_ins: totals.all_in || 0,
        },
        actions: {
          human: toDist(humanActs.results),
          agent: toDist(agentActs.results),
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

/* ------------------------------------------------------------- helpers */

function originAllowed(request) {
  return request.headers.get("Origin") === ALLOWED_ORIGIN;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

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
