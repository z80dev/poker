# AGENTPOKER — Heads-Up vs DeepSeek

Retro CRT-styled heads-up no-limit Texas Hold'em. You vs **DEEPSEEK**, an
agent powered by `deepseek-v4-flash` reached through a Cloudflare Worker
proxy (the API key lives only in the Worker's secret bindings).

**Play it live:** https://z80.wtf/poker

## Features

- Full no-limit hold'em rules ported from the `lemon_poker` Elixir engine
  (65 ExUnit tests) into a dependency-free JS engine: blinds, betting
  rounds, min-raise sizing, all-in short-raise no-reopen rules, side pots,
  split-pot remainder by button order, wheel straights, kickers.
- Multiple chip denominations (500/100/25/5/1) rendered as chip piles.
- Heads-up blind/button rotation; big-blind option; all-in runout.
- Agent decisions streamed via `https://poker-agent.z80.workers.dev`
  (Cloudflare Worker → deepseek-v4-flash). If the network drops or the
  model answers illegally, the game falls back to a legal action — it never
  stalls.
- Retro CRT terminal aesthetic: scanlines, phosphor glow, pixel fonts,
  WebAudio blips (toggleable).
- Configurable buy-in, blinds, match length, and agent speed.

## Run locally

```bash
python3 -m http.server 8080
# open http://127.0.0.1:8080
```

## Test

```bash
node --test test/engine.test.js   # 47 tests, engine parity with the Elixir suite
```

## Deploy

Static site → GitHub Pages (this repo, `master` branch) → `z80.wtf/poker`.
Agent proxy → Cloudflare Worker `poker-agent` (see `worker/`), secret
binding `ZEN_API_KEY`.

## Layout

```
index.html      game shell (config screen, table, game-over)
styles.css      retro CRT styling
engine.js       pure poker engine (no DOM; browser global + Node export)
agent.js        worker proxy client + ACTION parsing + prompt building
app.js          UI, game loop, human input, scoreboard
test/           node --test parity suite
worker/         Cloudflare Worker agent proxy (deploy separately)
```
