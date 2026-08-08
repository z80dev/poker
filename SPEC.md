# Retro Poker — Implementation Brief (Claude Opus)

You are implementing a complete, static, retro-styled heads-up no-limit
Texas Hold'em game in `/home/z80/dev/poker`. It must be fully client-side
(no build step, no framework, plain HTML/CSS/JS) because it deploys to
GitHub Pages at https://z80.wtf/poker.

## Ground-truth engine to port

The canonical engine lives in Elixir at `/home/z80/dev/lemon-poker/` and has
65 passing tests. Port it faithfully to JavaScript:

- `lib/lemon_poker/card.ex` → card representation (`Ah`, `Td`, rank values 2..14)
- `lib/lemon_poker/deck.ex` → 52-card deck, shuffle (seeded supported)
- `lib/lemon_poker/hand_rank.ex` → 5-7 card evaluation: straight flush, quads,
  full house, flush, straight (incl. wheel A-5), trips, two pair, pair, high
  card; proper tiebreakers + kickers; split pots on ties.
- `lib/lemon_poker/table.ex` → the full table state machine:
  - `new(id, small_blind, big_blind, max_seats)`; `seat_player(seat, id, stack)`
  - `start_hand(seed?)` → shuffle, deal 2 hole cards each, post blinds, button
  - `legal_actions()` → {options: [fold, check, call, bet, raise], to_call,
    bet:{min,max}, raise:{min,max}} with correct min-raise rules
  - `act(seat, action)` → fold/check/call/bet N/raise N (N = total committed
    for the street, not the increment), street advancement preflop→flop(3)→
    turn(1)→river(1), all-in handling, side pots, split-pot remainder by
    button order, showdown winner selection, uncontested pot awards.
  - Heads-up specifics: button posts small blind, other seat posts big blind;
    button advances each hand; blinds rotate; first to act preflop is the
    non-button seat, postflop it's the button seat.

Read the Elixir files and their tests carefully and port the _behavior_,
not just the names. Port the test suite too: `test/engine.test.js` with the
same scenarios as `test/lemon_poker/table_test.exs`, `hand_rank_test.exs`,
`card_test.exs`, `deck_test.exs`, `heads_up_match_test.exs`. Run them with
`node --test` (Node 25 is on PATH). All must pass.

## Agent opponent (deepseek-v4-flash)

The agent is reached via a Cloudflare Worker proxy:

- URL: `https://poker-agent.z80.workers.dev`
- POST JSON `{"prompt": "<state prompt>", "system": "<system prompt>"}`
- Response: `{"action": "<ACTION: ...>", "raw": "<full text>", "model": "..."}`
- CORS: wide open (Access-Control-Allow-Origin: *)

Build the prompt exactly like `HeadsUpMatch.build_prompt/3` does (see
`lib/lemon_poker/heads_up_match.ex`): describe street, pot, board, your hole
cards, your stack, opponent state, to_call, legal options with bet/raise
ranges, and require a one-line answer `ACTION: <fold|check|call|bet N|raise N>`.
Implement `parseAction(text)` mirroring `parse_action/1` (strip code fences,
find the ACTION: line, downcase, regex). On invalid/illegal/network-error
responses, fall back to a sensible legal action (check if available, else
call min, else fold) — never crash the game.

## Gameplay (human vs agent)

- Player is seat 1 ("YOU"), agent is seat 2 ("DEEPSEEK").
- Human acts via on-screen buttons; agent acts via the worker.
- Multiple chip values: denominations 1, 5, 25, 100, 500 with distinct
  retro colors; stacks shown as chip piles + amount; blinds e.g. 25/50,
  buy-in 5000. Offer a config screen (buy-in, blinds, hand count optional).
- Full hand flow: deal, betting rounds, board reveal, showdown with hand
  names, pot + side pots, winner announcement, stack updates, button
  rotation, next hand. Track a match score (hands won, $ won/lost).
- Nice-to-have: small retro "table talk" line from the agent (it can say
  one short line per street), sound effects via WebAudio (optional).

## Retro presentation (important — this is a _retro_ game)

- CRT/arcade terminal aesthetic: scanlines overlay, pixel font (use a
  Google-fonts pixel font like "Press Start 2P" or "VT323" via <link>,
  with monospace fallback), phosphor-green/amber glow, dark background,
  chunky borders, blinking cursor/status text.
- Cards drawn as DOM elements styled like classic cards (rounded, rank+suit
  pip), face-down backs with a retro pattern.
- All text uppercase-ish terminal style. Keep it cohesive and genuinely
  cool — this is the visible product.
- Layout must work in a browser at typical desktop sizes and at least be
  usable on a phone (simple flex/grid, no framework).

## Files to produce

```
/home/z80/dev/poker/
  index.html
  styles.css
  engine.js        (pure engine, no DOM)
  agent.js         (worker proxy client + parseAction + prompt builder)
  app.js           (UI + game loop + human input)
  test/engine.test.js  (node --test suite)
  README.md        (how to run locally: python3 -m http.server; deploy note)
  worker/index.js  (already exists — the Cloudflare Worker; leave it)
  worker/wrangler.toml
```

No external JS deps. Engine must be importable both from the browser
(`<script src="engine.js">` exposing a global) and from Node tests
(`module.exports`). Use the classic pattern:
`(function(global){ ... global.PokerEngine = ...; if (typeof module!=='undefined') module.exports = ... })(this)`.

## Hard requirements

1. `node --test test/` passes (engine port parity with the Elixir suite).
2. Rules correctness: min-raise sizing, all-in short raise does NOT reopen
   betting for the prior aggressor, side pots correct, split pots correct,
   wheel straight ranks as 5-high, kickers correct.
3. The game works end-to-end against the real worker when served over HTTP
   (you may not be able to call the worker from your sandbox — that's fine,
   wire it correctly and make the fallback path solid so the game is still
   fully playable if the network fails).
4. Everything static, no build step.

Write the files, run the tests until green, then report: what you built,
test results, any deviations from this brief.
