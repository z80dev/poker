/**
 * AGENTPOKER — UI and game loop.
 *
 * Seat 1 is the human ("YOU"), seat 2 is the agent ("DEEPSEEK"). The engine
 * (engine.js) owns all rules; this file only renders state and feeds actions
 * back in. Human actions arrive from on-screen buttons, agent actions from
 * the Worker proxy (agent.js) with a local legal fallback.
 */
(function () {
  "use strict";

  const { Card, Table, HandRank } = window.PokerEngine;
  const Agent = window.PokerAgent;

  /* ------------------------------------------------------------ analytics */

  const CLIENT_ID = (function () {
    let id = null;
    try {
      id = localStorage.getItem("ap_client_id");
    } catch (e) {}
    if (!id) {
      id =
        window.crypto && crypto.randomUUID
          ? crypto.randomUUID()
          : "c" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try {
        localStorage.setItem("ap_client_id", id);
      } catch (e) {}
    }
    return id;
  })();

  /** Fire-and-forget analytics event to the worker's D1-backed /event. */
  function track(event, data) {
    try {
      const body = { event, session: CLIENT_ID, data: data || {} };
      if (event === "page_view") {
        body.data.referrer = (document.referrer || "").slice(0, 200);
        body.data.width = window.innerWidth;
      }
      fetch(Agent.DEFAULT_ENDPOINT + "/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch (e) {}
  }

  // One page_view per load (fires at script eval; scripts sit at end of body).
  track("page_view");

  const HUMAN = 1;
  const AGENT = 2;
  const SEAT_NAMES = { 1: "YOU", 2: "DEEPSEEK" };

  /** "YOU FOLD" but "DEEPSEEK FOLDS" — second person takes no -S. */
  const verb = (seat, stem) => (seat === HUMAN ? stem : `${stem}S`);
  const DENOMS = [500, 100, 25, 5, 1];

  /* ---------------------------------------------------------------- state */

  const state = {
    table: null,
    config: { buyIn: 5000, smallBlind: 25, bigBlind: 50, hands: 0, speed: 1 },
    score: { hands: 0, won: 0, lost: 0, net: 0 },
    endView: null,
    resolveHuman: null,
    resolveNext: null,
    pendingSizer: null,
    pendingLegal: null,
    running: false,
    // Bumped on every startMatch. Async work captures the epoch it began in and
    // bails when it no longer matches, so a loop left over from an abandoned
    // match can never act on the new table.
    epoch: 0,
    sound: true,
  };

  /** True once the match this async step belongs to is over or superseded. */
  const stale = (epoch) => !state.running || state.epoch !== epoch;

  const el = (id) => document.getElementById(id);

  const dom = {
    screens: {
      config: el("screen-config"),
      table: el("screen-table"),
      over: el("screen-over"),
    },
    board: el("board"),
    pot: el("pot-value"),
    potChips: el("pot-chips"),
    street: el("street-label"),
    status: el("status-text"),
    log: el("log"),
    talk: el("talk"),
    controls: el("controls"),
    sizer: el("sizer"),
    sizeRange: el("size-range"),
    sizeInput: el("size-input"),
    nextRow: el("next-row"),
    marquee: el("marquee"),
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pause = (ms) => sleep(Math.round(ms * state.config.speed));

  /* ---------------------------------------------------------------- sound */

  const Sound = (function () {
    let ctx = null;

    function ensure() {
      if (!state.sound) return null;
      if (!ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        ctx = new Ctor();
      }
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }

    function tone(freq, duration, type, gainValue, delay) {
      const audio = ensure();
      if (!audio) return;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const start = audio.currentTime + (delay || 0);
      osc.type = type || "square";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(gainValue || 0.05, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(start);
      osc.stop(start + duration);
    }

    return {
      deal() {
        tone(880, 0.05, "square", 0.03);
      },
      chip() {
        tone(520, 0.07, "square", 0.04);
        tone(760, 0.05, "square", 0.03, 0.05);
      },
      check() {
        tone(320, 0.08, "triangle", 0.04);
      },
      fold() {
        tone(180, 0.16, "sawtooth", 0.035);
      },
      win() {
        [523, 659, 784, 1046].forEach((f, i) =>
          tone(f, 0.14, "square", 0.05, i * 0.09),
        );
      },
      lose() {
        [392, 330, 262].forEach((f, i) =>
          tone(f, 0.18, "sawtooth", 0.04, i * 0.11),
        );
      },
      beep() {
        tone(660, 0.05, "square", 0.03);
      },
    };
  })();

  /* ------------------------------------------------------------- utilities */

  function chipBreakdown(amount) {
    const out = [];
    let rest = Math.max(0, Math.floor(amount));
    for (const denom of DENOMS) {
      const count = Math.floor(rest / denom);
      if (count > 0) out.push({ denom, count });
      rest -= count * denom;
    }
    return out;
  }

  function renderChips(container, amount, maxColumns) {
    container.innerHTML = "";
    if (!amount || amount <= 0) return;
    const columns = chipBreakdown(amount).slice(0, maxColumns || 4);
    for (const { denom, count } of columns) {
      const col = document.createElement("div");
      col.className = "chip-col";
      const drawn = Math.min(count, 5);
      for (let i = 0; i < drawn; i++) {
        const chip = document.createElement("div");
        chip.className = `chip chip-${denom}`;
        col.appendChild(chip);
      }
      const label = document.createElement("div");
      label.className = "chip-count";
      label.textContent = `${denom}x${count}`;
      col.appendChild(label);
      container.appendChild(col);
    }
  }

  function cardElement(short, options) {
    const opts = options || {};
    const node = document.createElement("div");

    if (!short) {
      node.className = "card slot";
      return node;
    }
    if (opts.faceDown) {
      node.className = "card back";
      return node;
    }

    const parsed = Card.fromString(short);
    const card = parsed.card;
    const rank = Card.rankLabel(card);
    const suit = Card.suitSymbol(card);

    node.className = `card ${Card.isRed(card) ? "red" : "black"}${opts.highlight ? " winner" : ""}`;
    node.innerHTML =
      `<span class="corner tl">${rank}<br>${suit}</span>` +
      `<span class="pip-big">${suit}</span>` +
      `<span class="corner br">${rank}<br>${suit}</span>`;
    node.setAttribute("aria-label", `${rank} of ${card.suit}`);
    return node;
  }

  function log(text, cls) {
    const line = document.createElement("div");
    line.className = `log-line ${cls || ""}`;
    line.textContent = text;
    dom.log.appendChild(line);
    dom.log.scrollTop = dom.log.scrollHeight;
    while (dom.log.childNodes.length > 250)
      dom.log.removeChild(dom.log.firstChild);
  }

  function setStatus(text) {
    dom.status.textContent = text;
  }

  function showScreen(name) {
    for (const key of Object.keys(dom.screens)) {
      dom.screens[key].classList.toggle("hidden", key !== name);
    }
  }

  /* ------------------------------------------------------------- rendering */

  /** Builds a flat view model from either the live hand or the finished hand. */
  function buildView() {
    const table = state.table;

    if (!table) {
      const empty = {};
      for (const seat of [HUMAN, AGENT]) {
        empty[seat] = {
          stack: 0,
          committed: 0,
          folded: false,
          allIn: false,
          holeCards: [],
          reveal: false,
        };
      }
      return {
        board: [],
        pot: 0,
        street: "WAITING",
        actingSeat: null,
        buttonSeat: null,
        players: empty,
        highlight: {},
      };
    }

    if (table.hand) {
      const hand = table.hand;
      const players = {};
      for (const seat of [HUMAN, AGENT]) {
        const player = hand.players[seat];
        if (!player) {
          players[seat] = {
            stack: table.seats[seat] ? table.seats[seat].stack : 0,
            committed: 0,
            folded: true,
            allIn: false,
            holeCards: [],
            reveal: false,
          };
          continue;
        }
        players[seat] = {
          stack: player.stack,
          committed: player.committedRound,
          folded: player.folded,
          allIn: player.allIn,
          holeCards: player.holeCards.map(Card.toShortString),
          reveal: seat === HUMAN,
        };
      }
      return {
        board: hand.board.map(Card.toShortString),
        pot: hand.pot,
        street: hand.street.toUpperCase(),
        actingSeat: hand.actingSeat,
        buttonSeat: hand.buttonSeat,
        smallBlindSeat: hand.smallBlindSeat,
        bigBlindSeat: hand.bigBlindSeat,
        players,
        highlight: {},
      };
    }

    if (state.endView) return state.endView;

    const players = {};
    for (const seat of [HUMAN, AGENT]) {
      players[seat] = {
        stack: table.seats[seat] ? table.seats[seat].stack : 0,
        committed: 0,
        folded: false,
        allIn: false,
        holeCards: [],
        reveal: false,
      };
    }
    return {
      board: [],
      pot: 0,
      street: "WAITING",
      actingSeat: null,
      buttonSeat: table.buttonSeat,
      players,
      highlight: {},
    };
  }

  function render() {
    const view = buildView();

    // board
    dom.board.innerHTML = "";
    for (let i = 0; i < 5; i++) {
      const short = view.board[i];
      const highlight =
        short && view.highlight.board && view.highlight.board.includes(short);
      dom.board.appendChild(cardElement(short || null, { highlight }));
    }

    dom.pot.textContent = String(view.pot);
    renderChips(dom.potChips, view.pot, 3);
    dom.street.textContent = view.street;

    for (const seat of [HUMAN, AGENT]) {
      const player = view.players[seat];
      const seatNode = el(`seat-${seat}`);
      seatNode.classList.toggle("acting", view.actingSeat === seat);
      seatNode.classList.toggle("folded", player.folded);

      el(`stack-${seat}`).textContent = String(player.stack);
      renderChips(el(`pile-${seat}`), player.stack, 4);

      el(`button-${seat}`).classList.toggle("hidden", view.buttonSeat !== seat);

      let tag = "";
      if (player.folded) tag = "[FOLDED]";
      else if (player.allIn) tag = "[ALL-IN]";
      else if (view.smallBlindSeat === seat) tag = "[SB]";
      else if (view.bigBlindSeat === seat) tag = "[BB]";
      el(`tag-${seat}`).textContent = tag;

      // committed chips in front of the seat
      const betNode = el(`bet-${seat}`);
      betNode.innerHTML = "";
      if (player.committed > 0) {
        const amount = document.createElement("div");
        amount.textContent = String(player.committed);
        const pile = document.createElement("div");
        pile.className = "chip-pile";
        renderChips(pile, player.committed, 3);
        betNode.appendChild(amount);
        betNode.appendChild(pile);
      }

      // hole cards
      const holeNode = el(`hole-${seat}`);
      holeNode.innerHTML = "";
      const hole = player.holeCards;
      if (hole.length === 0) {
        holeNode.appendChild(cardElement(null));
        holeNode.appendChild(cardElement(null));
      } else {
        for (const short of hole) {
          const faceDown = !player.reveal;
          const highlight =
            !faceDown &&
            view.highlight[seat] &&
            view.highlight[seat].includes(short);
          holeNode.appendChild(cardElement(short, { faceDown, highlight }));
        }
      }
    }

    el("score-hand").textContent = String(state.score.hands);
    el("score-won").textContent = String(state.score.won);
    el("score-lost").textContent = String(state.score.lost);
    const net = el("score-net");
    net.textContent = (state.score.net > 0 ? "+" : "") + state.score.net;
    net.className = `score-val ${state.score.net > 0 ? "pos" : state.score.net < 0 ? "neg" : ""}`;
    el("score-blinds").textContent =
      `${state.config.smallBlind}/${state.config.bigBlind}`;
  }

  function showTalk(text) {
    if (!text) {
      dom.talk.classList.add("hidden");
      return;
    }
    dom.talk.textContent = `DEEPSEEK: "${text}"`;
    dom.talk.classList.remove("hidden");
  }

  /* --------------------------------------------------------- human control */

  const actionButtons = Array.from(
    document.querySelectorAll(".control-row [data-action]"),
  );

  function disableControls() {
    for (const button of actionButtons) {
      button.disabled = true;
      // Drop the priced label too: "CALL 2000" left sitting on a dark button
      // after the hand reads like a live offer at last hand's price.
      button.textContent = button.dataset.action.toUpperCase();
    }
    state.pendingLegal = null;
    hideSizer();
  }

  function hideSizer() {
    dom.sizer.classList.add("hidden");
    state.pendingSizer = null;
  }

  function labelFor(action, legal) {
    if (action === "call") {
      const player =
        legal.seat === HUMAN ? state.table.hand.players[HUMAN] : null;
      if (!player) return "CALL";
      const allIn = legal.to_call >= player.stack;
      return allIn ? `CALL ALL-IN ${player.stack}` : `CALL ${legal.to_call}`;
    }
    if (action === "raise") {
      const spec = legal.bet || legal.raise;
      if (!spec) return "RAISE";
      const verb = legal.bet ? "BET" : "RAISE";
      if (spec.all_in_only) return `ALL-IN ${spec.max}`;
      return verb;
    }
    return action.toUpperCase();
  }

  function enableControls(legal) {
    state.pendingLegal = legal;
    for (const button of actionButtons) {
      const action = button.dataset.action;
      const available =
        action === "raise"
          ? legal.options.includes("bet") || legal.options.includes("raise")
          : legal.options.includes(action);
      button.disabled = !available;
      // An unavailable button keeps its plain name: "CALL 0" reads like an
      // offer, and a stale amount on a dark button reads like a live one.
      button.textContent = available
        ? labelFor(action, legal)
        : action.toUpperCase();
    }
  }

  /** Resolves with a normalized action object once the human commits. */
  function awaitHumanAction(legal) {
    enableControls(legal);
    setStatus(
      legal.to_call > 0 ? `YOUR MOVE — ${legal.to_call} TO CALL` : "YOUR MOVE",
    );

    return new Promise((resolve) => {
      state.resolveHuman = (action) => {
        state.resolveHuman = null;
        disableControls();
        resolve(action);
      };
    });
  }

  function openSizer(legal) {
    const spec = legal.bet || legal.raise;
    if (!spec) return;

    if (spec.all_in_only || spec.min === spec.max) {
      submitHuman({ type: legal.bet ? "bet" : "raise", amount: spec.max });
      return;
    }

    // The sizer is cleared whenever a decision ends, so one that is still open
    // belongs to this decision: re-pressing RAISE must not snap a chosen
    // amount back to the minimum.
    if (state.pendingSizer) {
      dom.sizeInput.focus();
      return;
    }

    state.pendingSizer = { type: legal.bet ? "bet" : "raise", spec, legal };
    dom.sizeRange.min = String(spec.min);
    dom.sizeRange.max = String(spec.max);
    dom.sizeRange.step = "1";
    dom.sizeRange.value = String(spec.min);
    dom.sizeInput.min = String(spec.min);
    dom.sizeInput.max = String(spec.max);
    dom.sizeInput.value = String(spec.min);
    dom.sizer.classList.remove("hidden");
    setStatus(
      `SIZE YOUR ${state.pendingSizer.type.toUpperCase()}: ${spec.min} — ${spec.max}`,
    );
    Sound.beep();
  }

  function clampSize(value) {
    const spec = state.pendingSizer.spec;
    if (!Number.isFinite(value)) return spec.min;
    return Math.max(spec.min, Math.min(spec.max, Math.round(value)));
  }

  function setSize(value) {
    if (!state.pendingSizer) return;
    const amount = clampSize(value);
    dom.sizeRange.value = String(amount);
    dom.sizeInput.value = String(amount);
  }

  function submitHuman(action) {
    if (!state.resolveHuman) return;
    state.resolveHuman(action);
  }

  /* ------------------------------------------------------------- game loop */

  function newTable(config) {
    let table = Table.new("retro-poker", {
      maxSeats: 2,
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
    });
    table = Table.seatPlayer(table, HUMAN, "you", config.buyIn).table;
    table = Table.seatPlayer(table, AGENT, "deepseek", config.buyIn).table;
    return table;
  }

  async function startMatch(config) {
    // A second START while a match is live would run two loops over one table.
    if (state.running) return;

    state.config = config;
    state.table = newTable(config);
    state.score = { hands: 0, won: 0, lost: 0, net: 0 };
    state.endView = null;
    state.running = true;
    const epoch = (state.epoch += 1);

    track("match_start", {
      buyin: config.buyIn,
      blinds: `${config.smallBlind}/${config.bigBlind}`,
      hands: config.hands,
    });

    dom.log.innerHTML = "";
    showTalk("");
    showScreen("table");
    disableControls();
    render();

    log(
      `MATCH START — BUY-IN ${config.buyIn}, BLINDS ${config.smallBlind}/${config.bigBlind}`,
      "sys",
    );
    log(
      config.hands > 0
        ? `PLAYING ${config.hands} HANDS`
        : "PLAYING UNTIL SOMEONE BUSTS",
      "sys",
    );

    try {
      await runMatch(epoch);
    } finally {
      // Only the match that is still current may clear the flag; a superseded
      // loop unwinding late must not unlock a match that is already running.
      if (state.epoch === epoch) state.running = false;
    }
  }

  async function runMatch(epoch) {
    while (!stale(epoch)) {
      if (state.config.hands > 0 && state.score.hands >= state.config.hands) {
        return endMatch("HAND LIMIT REACHED");
      }
      if (state.table.seats[HUMAN].stack <= 0)
        return endMatch("YOU ARE BUSTED");
      if (state.table.seats[AGENT].stack <= 0)
        return endMatch("DEEPSEEK IS BUSTED");

      const started = Table.startHand(state.table, {});
      if (!started.ok)
        return endMatch(`CANNOT DEAL: ${started.error.toUpperCase()}`);

      state.table = started.table;
      state.endView = null;
      showTalk("");

      const hand = state.table.hand;
      log("", "");
      log(
        `--- HAND #${hand.id} --- BUTTON: ${SEAT_NAMES[hand.buttonSeat]}`,
        "sys",
      );
      log(
        `BLINDS POSTED: ${SEAT_NAMES[hand.smallBlindSeat]} ${state.config.smallBlind}, ` +
          `${SEAT_NAMES[hand.bigBlindSeat]} ${state.config.bigBlind}`,
        "sys",
      );
      log(
        `YOUR CARDS: ${hand.players[HUMAN].holeCards.map(Card.toShortString).join(" ")}`,
        "you",
      );

      Sound.deal();
      render();
      await pause(500);
      if (stale(epoch)) return;

      await playHand(epoch);
      if (stale(epoch)) return;

      await waitForNext(epoch);
      if (stale(epoch)) return;
    }
  }

  async function playHand(epoch) {
    const stacksBefore = {
      [HUMAN]: state.table.seats[HUMAN].stack,
      [AGENT]: state.table.seats[AGENT].stack,
    };
    let street = state.table.hand.street;

    while (!stale(epoch) && state.table.hand) {
      const legalResult = Table.legalActions(state.table);
      if (!legalResult.ok) break;
      const legal = legalResult.legal;

      render();

      let action;
      let decision = null;
      const stackBefore = state.table.hand.players[legal.seat].stack;

      if (legal.seat === HUMAN) {
        action = await awaitHumanAction(legal);
        if (stale(epoch)) return;
      } else {
        // Live thinking clock: the model can legitimately take 5-90s+, so
        // show elapsed seconds instead of a frozen status line.
        const thinkStart = Date.now();
        setStatus("DEEPSEEK IS THINKING... 0s");
        const thinkTimer = setInterval(() => {
          const secs = Math.round((Date.now() - thinkStart) / 1000);
          setStatus(`DEEPSEEK IS THINKING... ${secs}s`);
        }, 1000);
        const stopThinking = () => clearInterval(thinkTimer);
        await pause(350);
        if (stale(epoch)) {
          stopThinking();
          return;
        }
        decision = await Agent.decide(state.table, legal, {
          label: "DEEPSEEK",
        });
        stopThinking();
        // The worker can take seconds; the match may be long gone by now, and
        // `legal` would then describe a table that no longer exists.
        if (stale(epoch)) return;
        action = decision.action;
      }

      const streetNow = state.table.hand ? state.table.hand.street : "";
      const applied = Table.act(state.table, legal.seat, action);
      if (!applied.ok) {
        // Should not happen: both paths validate first. Fail safe rather than stall.
        log(
          `ENGINE REJECTED ${Table.formatAction(action)} (${applied.error})`,
          "bad",
        );
        const safe = Table.act(
          state.table,
          legal.seat,
          Agent.fallbackAction(legal),
        );
        if (!safe.ok) return endMatch("ENGINE ERROR");
        state.table = safe.table;
      } else {
        state.table = applied.table;

        if (legal.seat === HUMAN) {
          const norm = Table.normalizeAction(action);
          track("human_action", {
            action: norm.type,
            amount: norm.amount || 0,
            street: streetNow,
          });
        }

        // All-in detection mirrors the CALL ALL-IN cap logic in announceAction.
        const allInNow =
          action.type === "bet" || action.type === "raise"
            ? action.amount >= stackBefore
            : action.type === "call" && legal.to_call >= stackBefore;
        if (allInNow) {
          track("all_in", { seat: legal.seat, street: streetNow });
        }
      }

      announceAction(legal.seat, action, legal, decision, stackBefore);
      render();
      await pause(320);
      if (stale(epoch)) return;

      // Street transitions get a beat so the board reveal reads.
      if (state.table.hand && state.table.hand.street !== street) {
        street = state.table.hand.street;
        const board = state.table.hand.board.map(Card.toShortString).join(" ");
        log(`${street.toUpperCase()}: ${board}`, "sys");
        setStatus(`${street.toUpperCase()} — ${board}`);
        Sound.deal();
        render();
        await pause(650);
        if (stale(epoch)) return;
      }
    }

    if (stale(epoch)) return;
    await finishHand(stacksBefore);
  }

  function announceAction(seat, action, legal, decision, stackBefore) {
    const name = SEAT_NAMES[seat];
    const cls = seat === HUMAN ? "you" : "bot";
    const normalized = Table.normalizeAction(action);
    let text;

    switch (normalized.type) {
      case "fold":
        text = `${name} ${verb(seat, "FOLD")}`;
        Sound.fold();
        break;
      case "check":
        text = `${name} ${verb(seat, "CHECK")}`;
        Sound.check();
        break;
      case "call": {
        // A call larger than the remaining stack is capped at all-in.
        const paid = Math.min(legal.to_call, stackBefore);
        text =
          paid >= stackBefore
            ? `${name} ${verb(seat, "CALL")} ALL-IN ${paid}`
            : `${name} ${verb(seat, "CALL")} ${paid}`;
        Sound.chip();
        break;
      }
      case "bet":
        text = `${name} ${verb(seat, "BET")} ${normalized.amount}`;
        Sound.chip();
        break;
      default:
        text = `${name} ${verb(seat, "RAISE")} TO ${normalized.amount}`;
        Sound.chip();
        break;
    }

    if (decision && decision.source === "fallback") {
      text += " [SLOW MODEL — AUTO PLAY]";
      if (decision.error)
        log(`AGENT ERROR: ${String(decision.error).toUpperCase()}`, "bad");
      track("fallback_used", {
        error: String(decision.error || "").slice(0, 120),
      });
    }

    log(text, cls);
    setStatus(text);

    if (decision && decision.talk) showTalk(decision.talk);
    else if (seat === AGENT && !decision) showTalk("");
  }

  async function finishHand(stacksBefore) {
    const result = state.table.lastHandResult;
    if (!result) return;

    state.score.hands += 1;

    const humanDelta = state.table.seats[HUMAN].stack - stacksBefore[HUMAN];
    state.score.net += humanDelta;
    if (humanDelta > 0) state.score.won += 1;
    else if (humanDelta < 0) state.score.lost += 1;

    const potTotal = (result.pots || []).reduce((s, p) => s + p.amount, 0);
    const streetMap = { 0: "PREFLOP", 3: "FLOP", 4: "TURN", 5: "RIVER" };
    const street =
      result.endedBy === "showdown"
        ? "SHOWDOWN"
        : streetMap[(result.board || []).length] || "PREFLOP";
    track("hand_end", {
      winner: humanDelta > 0 ? "you" : humanDelta < 0 ? "agent" : "chop",
      pot: potTotal,
      hand: state.score.hands,
      street,
      big_pot: potTotal >= state.config.bigBlind * 20 ? 1 : 0,
    });

    // Freeze a view of the finished hand so the table keeps showing it.
    const showdown = result.showdown || {};
    const winners = result.winners || {};
    const players = {};
    for (const seat of [HUMAN, AGENT]) {
      const reveal = seat === HUMAN || result.endedBy === "showdown";
      players[seat] = {
        stack: state.table.seats[seat].stack,
        committed: 0,
        folded: false,
        allIn: false,
        holeCards: (result.holeCards && result.holeCards[seat]) || [],
        reveal,
      };
    }

    const highlight = {};
    const bestSeat = Object.keys(winners)
      .map(Number)
      .sort((a, b) => (winners[b] || 0) - (winners[a] || 0))[0];
    if (result.endedBy === "showdown" && bestSeat && showdown[bestSeat]) {
      highlight.board = showdown[bestSeat].bestFive;
      highlight[bestSeat] = showdown[bestSeat].bestFive;
    }

    state.endView = {
      board: result.board,
      pot: 0,
      street: result.endedBy === "showdown" ? "SHOWDOWN" : "HAND OVER",
      actingSeat: null,
      buttonSeat: state.table.buttonSeat,
      players,
      highlight,
    };

    if (result.endedBy === "showdown") {
      for (const seat of [HUMAN, AGENT]) {
        const entry = showdown[seat];
        if (!entry) continue;
        log(
          `${SEAT_NAMES[seat]} ${verb(seat, "SHOW")} ${entry.holeCards.join(" ")} — ${entry.label}`,
          seat === HUMAN ? "you" : "bot",
        );
      }
    }

    for (const seat of Object.keys(winners).map(Number)) {
      log(`${SEAT_NAMES[seat]} ${verb(seat, "WIN")} ${winners[seat]}`, "win");
    }

    if (result.pots.length > 1) {
      log(
        `SIDE POTS: ${result.pots.map((pot) => pot.amount).join(" + ")}`,
        "sys",
      );
    }

    const verdict =
      humanDelta > 0
        ? `YOU WIN +${humanDelta}`
        : humanDelta < 0
          ? `YOU LOSE ${humanDelta}`
          : "CHOPPED POT";
    setStatus(verdict);
    if (humanDelta > 0) Sound.win();
    else if (humanDelta < 0) Sound.lose();

    render();
    await pause(400);
  }

  function waitForNext(epoch) {
    const overLimit =
      state.config.hands > 0 && state.score.hands >= state.config.hands;
    const busted =
      state.table.seats[HUMAN].stack <= 0 ||
      state.table.seats[AGENT].stack <= 0;

    const next = el("btn-next");
    dom.nextRow.classList.remove("hidden");
    next.textContent = overLimit || busted ? "SEE RESULTS" : "NEXT HAND";

    return new Promise((resolve) => {
      const handler = () => {
        // A second click lands before the row finishes hiding; the resolver is
        // cleared on the first, so the extra click is a no-op.
        if (state.resolveNext !== finish) return;
        finish(true);
      };
      const finish = (clicked) => {
        state.resolveNext = null;
        next.removeEventListener("click", handler);
        dom.nextRow.classList.add("hidden");
        if (clicked && !stale(epoch)) Sound.beep();
        resolve();
      };

      // Quitting here used to leave this promise pending forever, stranding the
      // match loop and its click listener on a button the next match reuses.
      state.resolveNext = finish;
      next.addEventListener("click", handler);
    });
  }

  function endMatch(reason) {
    if (!state.running) return;
    state.running = false;
    disableControls();
    dom.nextRow.classList.add("hidden");

    // Release anything the loop is parked on so it unwinds instead of leaking.
    if (state.resolveHuman) state.resolveHuman({ type: "fold" });
    if (state.resolveNext) state.resolveNext(false);

    const human = state.table.seats[HUMAN].stack;
    const bot = state.table.seats[AGENT].stack;
    const title =
      human > bot
        ? "YOU WIN THE MATCH"
        : human < bot
          ? "DEEPSEEK WINS"
          : "DEAD HEAT";

    el("over-title").textContent = title;
    el("over-stats").textContent = [
      `REASON        ${reason}`,
      `HANDS PLAYED  ${state.score.hands}`,
      `HANDS WON     ${state.score.won}`,
      `HANDS LOST    ${state.score.lost}`,
      `NET CHIPS     ${state.score.net > 0 ? "+" : ""}${state.score.net}`,
      "",
      `YOUR STACK    ${human}`,
      `DEEPSEEK      ${bot}`,
    ].join("\n");

    track("match_end", {
      reason: String(reason || "").slice(0, 60),
      hands: state.score.hands,
      won: state.score.won,
      lost: state.score.lost,
      net: state.score.net,
      yourStack: human,
      agentStack: bot,
    });

    showScreen("over");
    if (human > bot) Sound.win();
    else Sound.lose();
  }

  /* ----------------------------------------------------------------- wiring */

  for (const button of actionButtons) {
    button.addEventListener("click", () => {
      if (button.disabled || !state.resolveHuman) return;
      const action = button.dataset.action;
      // Use the snapshot the controls were enabled from, so a click can only
      // ever commit the decision the button was actually offering.
      const legal = state.pendingLegal;
      if (!legal) return;

      if (action === "raise") {
        openSizer(legal);
        return;
      }
      hideSizer();
      submitHuman({ type: action });
    });
  }

  dom.sizeRange.addEventListener("input", () =>
    setSize(Number(dom.sizeRange.value)),
  );
  dom.sizeInput.addEventListener("input", () => {
    if (!state.pendingSizer) return;
    dom.sizeRange.value = String(clampSize(Number(dom.sizeInput.value)));
  });

  for (const button of document.querySelectorAll("[data-size]")) {
    button.addEventListener("click", () => {
      if (!state.pendingSizer || !state.table.hand) return;
      const { spec, legal } = state.pendingSizer;
      const pot = state.table.hand.pot;
      const mode = button.dataset.size;
      // Standard sizing: a pot-sized raise is call + (pot after the call).
      let target = spec.min;
      if (mode === "half") {
        target = legal.to_call + Math.round((pot + legal.to_call) / 2);
      } else if (mode === "pot") {
        target = legal.to_call + pot + legal.to_call;
      } else if (mode === "max") {
        target = spec.max;
      }
      setSize(target);
      Sound.beep();
    });
  }

  el("btn-confirm").addEventListener("click", () => {
    if (!state.pendingSizer || !state.resolveHuman) return;
    const amount = clampSize(Number(dom.sizeInput.value));
    const type = state.pendingSizer.type;
    hideSizer();
    submitHuman({ type, amount });
  });

  el("btn-cancel").addEventListener("click", () => {
    if (!state.pendingSizer || !state.resolveHuman) return;
    const legal = state.pendingSizer.legal;
    hideSizer();
    enableControls(legal);
    setStatus(
      legal.to_call > 0 ? `YOUR MOVE — ${legal.to_call} TO CALL` : "YOUR MOVE",
    );
  });

  el("btn-start").addEventListener("click", () => {
    if (state.running) return;
    const [smallBlind, bigBlind] = el("cfg-blinds")
      .value.split("/")
      .map(Number);
    Sound.beep();
    // The loop is fire-and-forget; surface a crash instead of losing it to an
    // unhandled rejection, and never leave the match flagged as running.
    startMatch({
      buyIn: Number(el("cfg-buyin").value),
      smallBlind,
      bigBlind,
      hands: Number(el("cfg-hands").value),
      speed: Number(el("cfg-speed").value),
    }).catch((err) => {
      state.running = false;
      log(`FATAL: ${String((err && err.message) || err).toUpperCase()}`, "bad");
      setStatus("MATCH ABORTED — RELOAD TO RETRY");
    });
  });

  el("btn-again").addEventListener("click", () => {
    showScreen("config");
  });

  el("btn-quit").addEventListener("click", () => {
    // endMatch is a no-op once the match is over and unwinds any pending await.
    endMatch("YOU QUIT");
  });

  // The log is a <details> so the collapse is pure CSS, but a phone wants it
  // shut on arrival — the felt needs that space more than the transcript does.
  (function setUpLog() {
    const panel = el("log-panel");
    // Same test as the CSS: any viewport that pins the table to 100dvh.
    const cramped =
      "(max-width: 640px), (max-height: 560px) and (orientation: landscape)";
    if (window.matchMedia(cramped).matches) panel.open = false;
    // A collapsed log can't be scrolled, so lines appended while it was shut
    // leave it parked at the top. Re-pin it to the newest line on open.
    panel.addEventListener("toggle", () => {
      if (panel.open) dom.log.scrollTop = dom.log.scrollHeight;
    });
  })();

  el("sound-toggle").addEventListener("click", () => {
    state.sound = !state.sound;
    const button = el("sound-toggle");
    button.textContent = state.sound ? "SND:ON" : "SND:OFF";
    button.setAttribute("aria-pressed", String(state.sound));
    if (state.sound) Sound.beep();
  });

  // Keyboard shortcuts: F fold, C check/call, R raise, Enter next/confirm.
  document.addEventListener("keydown", (event) => {
    // Leave browser and OS chords alone — Ctrl+R must reload, not open a sizer.
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "SELECT") {
      if (event.key === "Enter" && state.pendingSizer)
        el("btn-confirm").click();
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "enter" && !dom.nextRow.classList.contains("hidden")) {
      el("btn-next").click();
      return;
    }
    if (state.pendingSizer && key === "enter") {
      el("btn-confirm").click();
      return;
    }
    if (state.pendingSizer && key === "escape") {
      el("btn-cancel").click();
      return;
    }
    if (!state.resolveHuman) return;

    // "C" means check when possible, otherwise call.
    const wanted = { f: ["fold"], c: ["check", "call"], r: ["raise"] }[key];
    if (!wanted) return;
    for (const action of wanted) {
      const button = actionButtons.find(
        (node) => node.dataset.action === action,
      );
      if (button && !button.disabled) {
        button.click();
        return;
      }
    }
  });

  disableControls();
  render();
  setStatus("CONFIGURE YOUR MATCH");
})();
