/**
 * PokerAgent — client for the deepseek-v4-flash opponent.
 *
 * The model is reached through a Cloudflare Worker proxy (see worker/index.js)
 * that holds the API key:
 *
 *   POST https://poker-agent.z80.workers.dev
 *   body     { "prompt": string, "system": string }
 *   response { "action": string, "raw": string, "model": string }
 *
 * Prompt construction mirrors LemonPoker.HeadsUpMatch.build_prompt/3 and
 * parsing mirrors parse_action/1. Any failure — network, malformed answer,
 * illegal action — degrades to a legal fallback so the game never stalls.
 */
(function (global) {
  "use strict";

  const Engine =
    global.PokerEngine ||
    (typeof require !== "undefined" ? require("./engine.js") : null);

  const DEFAULT_ENDPOINT = "https://poker-agent.z80.workers.dev";
  // Live answers land in 2-5s, so 12s is generous headroom while giving a hung
  // request up sooner. Upstream returns empty content on roughly one call in
  // six; that failure is instant, so a third cheap attempt takes the odds of a
  // visible [OFFLINE FALLBACK] from ~3% to ~0.5% per decision without
  // stretching the worst case (3x12s) past the old one (2x20s).
  const DEFAULT_TIMEOUT_MS = 12000;
  const DEFAULT_ATTEMPTS = 3;

  const SYSTEM_PROMPT = [
    "You are DEEPSEEK, a sharp, aggressive heads-up poker agent in a retro arcade cabinet.",
    "Play well: value bet strong hands, bluff sometimes, fold trash to pressure.",
    "You may write ONE short line of trash talk (max 60 chars) before your action.",
    "Your final line must be exactly: ACTION: <fold|check|call|bet N|raise N>",
    "Be concise. Follow the response format exactly.",
  ].join(" ");

  /* ------------------------------------------------------------------ *
   * Prompt building (port of HeadsUpMatch.build_prompt/3)
   * ------------------------------------------------------------------ */

  function formatCards(shortStrings) {
    if (!shortStrings || shortStrings.length === 0) return "(none)";
    return shortStrings.join(" ");
  }

  function playerState(player) {
    if (player.folded) return "folded";
    if (player.allIn) return "all-in";
    return "active";
  }

  function formatPlayerStates(players) {
    return Object.keys(players)
      .map(Number)
      .sort((a, b) => a - b)
      .map((seat) => {
        const player = players[seat];
        return (
          `seat ${seat}: stack=${player.stack}, committed=${player.committedRound}, ` +
          `state=${playerState(player)}`
        );
      })
      .join(" | ");
  }

  function formatOptions(legal) {
    let text = legal.options.join(", ");
    if (legal.bet) text += ` | bet_range=${legal.bet.min}-${legal.bet.max}`;
    if (legal.raise)
      text += ` | raise_range=${legal.raise.min}-${legal.raise.max}`;
    return text;
  }

  function buildPrompt(table, legal, label) {
    const hand = table.hand;
    const actor = hand.players[legal.seat];
    const seatLabel = label || `agent-${legal.seat}`;

    return [
      "You are playing heads-up no-limit Texas Hold'em.",
      `You are seat ${legal.seat} (${seatLabel}).`,
      "",
      "Respond with exactly one line:",
      "ACTION: <fold|check|call|bet N|raise N>",
      "",
      "Betting amount rule:",
      "- For bet/raise, N is the total committed amount for this street (not the increment).",
      "- Only choose legal actions shown below.",
      "",
      "State:",
      `- hand_id: ${hand.id}`,
      `- street: ${hand.street}`,
      `- pot: ${hand.pot}`,
      `- board: ${formatCards(hand.board.map(Engine.Card.toShortString))}`,
      `- your_hole_cards: ${formatCards(actor.holeCards.map(Engine.Card.toShortString))}`,
      `- your_stack: ${actor.stack}`,
      `- players: ${formatPlayerStates(hand.players)}`,
      `- to_call: ${legal.to_call}`,
      `- legal_options: ${formatOptions(legal)}`,
      "",
    ].join("\n");
  }

  /* ------------------------------------------------------------------ *
   * Answer parsing (port of HeadsUpMatch.parse_action/1)
   * ------------------------------------------------------------------ */

  function stripCodeFences(text) {
    return text
      .trim()
      .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
      .replace(/\s*```$/, "");
  }

  function pickActionLine(text) {
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

    const actionLine =
      lines.find((line) => line.toLowerCase().startsWith("action:")) ||
      lines[0] ||
      "";

    return actionLine.replace(/^action:/i, "").trim();
  }

  /**
   * Parses a model answer into an action object.
   * Returns { ok: true, action } or { ok: false, error: "invalid_format" }.
   */
  function parseAction(answer) {
    if (typeof answer !== "string")
      return { ok: false, error: "invalid_format" };

    const normalized = pickActionLine(stripCodeFences(answer))
      .toLowerCase()
      .trim();

    if (/^fold\b/.test(normalized))
      return { ok: true, action: { type: "fold" } };
    if (/^check\b/.test(normalized))
      return { ok: true, action: { type: "check" } };
    if (/^call\b/.test(normalized))
      return { ok: true, action: { type: "call" } };

    const bet = normalized.match(/^bet\b[^0-9]*([0-9]+)/);
    if (bet)
      return {
        ok: true,
        action: { type: "bet", amount: parseInt(bet[1], 10) },
      };

    const raise = normalized.match(/^raise\b[^0-9]*([0-9]+)/);
    if (raise)
      return {
        ok: true,
        action: { type: "raise", amount: parseInt(raise[1], 10) },
      };

    return { ok: false, error: "invalid_format" };
  }

  /** Extracts one short table-talk line: the first line that is not the action. */
  function parseTableTalk(raw) {
    if (typeof raw !== "string") return "";
    const line = stripCodeFences(raw)
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .find(
        (entry) =>
          !/^action:/i.test(entry) &&
          !/^(fold|check|call|bet|raise)\b/i.test(entry),
      );
    if (!line) return "";
    const cleaned = line.replace(/^[>*\-\s"']+|["']+$/g, "").trim();
    return cleaned.length > 70 ? `${cleaned.slice(0, 67)}...` : cleaned;
  }

  /* ------------------------------------------------------------------ *
   * Fallback (port of HeadsUpMatch.fallback_action/1)
   * ------------------------------------------------------------------ */

  function fallbackAction(legal) {
    const has = (option) => legal.options.indexOf(option) !== -1;
    if (has("check")) return { type: "check" };
    if (has("call")) return { type: "call" };
    if (has("fold")) return { type: "fold" };
    if (has("bet") && legal.bet) return { type: "bet", amount: legal.bet.min };
    if (has("raise") && legal.raise)
      return { type: "raise", amount: legal.raise.min };
    return { type: "fold" };
  }

  /* ------------------------------------------------------------------ *
   * Network
   * ------------------------------------------------------------------ */

  async function callWorker(endpoint, prompt, system, timeoutMs) {
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, system }),
        signal: controller ? controller.signal : undefined,
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.error) {
        const message =
          payload && payload.error ? payload.error : `http ${response.status}`;
        return { ok: false, error: message };
      }
      return { ok: true, payload };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Decides the agent's action for the current table state.
   * Always resolves with a legal action:
   *   { action, source: "agent" | "fallback", talk, raw, error? }
   */
  async function decide(table, legal, opts) {
    const options = opts || {};
    const endpoint = options.endpoint || DEFAULT_ENDPOINT;
    const attempts = options.attempts || DEFAULT_ATTEMPTS;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const system = options.system || SYSTEM_PROMPT;
    const prompt = buildPrompt(table, legal, options.label || "DEEPSEEK");

    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await callWorker(endpoint, prompt, system, timeoutMs);
      if (!result.ok) {
        lastError = result.error;
        continue;
      }

      const raw = result.payload.raw || result.payload.action || "";
      const parsed = parseAction(result.payload.action || raw);
      if (!parsed.ok) {
        lastError = "unparseable answer";
        continue;
      }
      if (!Engine.Table.isLegalAction(parsed.action, legal)) {
        lastError = `illegal action: ${Engine.Table.formatAction(parsed.action)}`;
        continue;
      }

      return {
        action: parsed.action,
        source: "agent",
        talk: parseTableTalk(raw),
        raw,
        model: result.payload.model,
      };
    }

    return {
      action: fallbackAction(legal),
      source: "fallback",
      talk: "",
      raw: "",
      error: lastError,
    };
  }

  const PokerAgent = {
    DEFAULT_ENDPOINT,
    SYSTEM_PROMPT,
    buildPrompt,
    parseAction,
    parseTableTalk,
    fallbackAction,
    decide,
  };

  global.PokerAgent = PokerAgent;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PokerAgent;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
