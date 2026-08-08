/**
 * Engine parity suite — ported from the lemon_poker ExUnit tests:
 *   test/lemon_poker/card_test.exs
 *   test/lemon_poker/deck_test.exs
 *   test/lemon_poker/hand_rank_test.exs
 *   test/lemon_poker/table_test.exs
 *   test/lemon_poker/heads_up_match_test.exs
 *
 * Run with: node --test test/
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { Card, Deck, HandRank, Table } = require("../engine.js");
const Agent = require("../agent.js");

/* ---------------------------------------------------------------- *
 * Helpers (port of LemonPoker.TestHelpers)
 * ---------------------------------------------------------------- */

function card(short) {
  const result = Card.fromString(short);
  assert.ok(result.ok, `bad card ${short}`);
  return result.card;
}

function cards(shorts) {
  return shorts.map(card);
}

function deckWithTop(shorts) {
  const top = cards(shorts);
  const topKeys = new Set(top.map(Card.toShortString));
  const rest = Deck.new().filter((c) => !topKeys.has(Card.toShortString(c)));
  return top.concat(rest);
}

function seatPlayers(table, specs) {
  return specs.reduce((acc, [seat, playerId, stack]) => {
    const result = Table.seatPlayer(acc, seat, playerId, stack);
    assert.ok(result.ok, `seat_player failed: ${result.error}`);
    return result.table;
  }, table);
}

function threePlayerTable(stacks) {
  const table = Table.new("table-1", {
    maxSeats: 6,
    smallBlind: 50,
    bigBlind: 100,
  });
  return seatPlayers(table, [
    [1, "p1", stacks[0]],
    [2, "p2", stacks[1]],
    [3, "p3", stacks[2]],
  ]);
}

function startHand(table, opts) {
  const result = Table.startHand(table, opts);
  assert.ok(result.ok, `start_hand failed: ${result.error}`);
  return result.table;
}

function act(table, seat, action) {
  const result = Table.act(table, seat, action);
  assert.ok(
    result.ok,
    `act(${seat}, ${JSON.stringify(action)}) failed: ${result.error}`,
  );
  return result.table;
}

function legal(table) {
  const result = Table.legalActions(table);
  assert.ok(result.ok, `legal_actions failed: ${result.error}`);
  return result.legal;
}

function toFlop(table) {
  let current = startHand(table, { seed: 42 });
  current = act(current, 1, "call");
  current = act(current, 2, "call");
  current = act(current, 3, "check");
  return current;
}

function checkRound(table, seats) {
  return seats.reduce((acc, seat) => act(acc, seat, "check"), table);
}

/* ---------------------------------------------------------------- *
 * Card
 * ---------------------------------------------------------------- */

test("card: builds full unique 52-card deck", () => {
  const deck = Card.fullDeck();
  assert.strictEqual(deck.length, 52);
  assert.strictEqual(new Set(deck.map(Card.toShortString)).size, 52);
});

test("card: parses and serializes short card notation", () => {
  const aceSpades = Card.fromString("As");
  assert.ok(aceSpades.ok);
  assert.strictEqual(aceSpades.card.rank, "ace");
  assert.strictEqual(aceSpades.card.suit, "spades");
  assert.strictEqual(Card.toShortString(aceSpades.card), "As");

  const tenDiamonds = Card.fromString("Td");
  assert.ok(tenDiamonds.ok);
  assert.strictEqual(Card.toShortString(tenDiamonds.card), "Td");
});

test("card: rejects invalid card strings", () => {
  assert.deepStrictEqual(Card.fromString("1s"), {
    ok: false,
    error: "invalid_card",
  });
  assert.deepStrictEqual(Card.fromString("AcX"), {
    ok: false,
    error: "invalid_card",
  });
  assert.deepStrictEqual(Card.fromString("ZZ"), {
    ok: false,
    error: "invalid_card",
  });
});

test("card: rank values run 2..14", () => {
  assert.strictEqual(Card.rankValue(card("2c")), 2);
  assert.strictEqual(Card.rankValue(card("Th")), 10);
  assert.strictEqual(Card.rankValue(card("Ad")), 14);
});

/* ---------------------------------------------------------------- *
 * Deck
 * ---------------------------------------------------------------- */

test("deck: deterministic shuffle returns same order for same seed", () => {
  const deckA = Deck.shuffle(Deck.new(), { seed: 1234 });
  const deckB = Deck.shuffle(Deck.new(), { seed: 1234 });
  const deckC = Deck.shuffle(Deck.new(), { seed: 5678 });

  const show = (deck) => deck.map(Card.toShortString).join(",");
  assert.strictEqual(show(deckA), show(deckB));
  assert.notStrictEqual(show(deckA), show(deckC));
  assert.strictEqual(deckA.length, 52);
  assert.ok(Deck.valid(deckA));
});

test("deck: deal returns top cards and remaining deck", () => {
  const deck = Deck.new();
  const result = Deck.deal(deck, 5);

  assert.ok(result.ok);
  assert.strictEqual(result.cards.length, 5);
  assert.strictEqual(result.rest.length, 47);
  assert.deepStrictEqual(result.cards.concat(result.rest), deck);
});

test("deck: deal fails when requesting more cards than remain", () => {
  assert.deepStrictEqual(Deck.deal([], 1), {
    ok: false,
    error: "not_enough_cards",
  });
});

test("deck: burn removes the top card", () => {
  const burned = Deck.burn(Deck.new());
  assert.ok(burned.ok);
  assert.strictEqual(Card.toShortString(burned.card), "2c");
  assert.strictEqual(burned.rest.length, 51);
});

/* ---------------------------------------------------------------- *
 * HandRank
 * ---------------------------------------------------------------- */

function evaluate(shorts) {
  const result = HandRank.evaluate(cards(shorts));
  assert.ok(result.ok, "evaluate failed");
  return result.rank;
}

test("hand rank: straight flush beats four of a kind", () => {
  const straightFlush = evaluate(["As", "Ks", "Qs", "Js", "Ts"]);
  const quads = evaluate(["Ac", "Ad", "Ah", "As", "2d"]);
  assert.strictEqual(HandRank.compare(straightFlush, quads), "gt");
  assert.strictEqual(HandRank.compare(quads, straightFlush), "lt");
});

test("hand rank: recognizes wheel straight", () => {
  const rank = evaluate(["As", "2d", "3h", "4c", "5s", "9h", "Kd"]);
  assert.strictEqual(rank.category, "straight");
  assert.deepStrictEqual(rank.tiebreaker, [5]);
});

test("hand rank: chooses the best five out of seven cards", () => {
  const rank = evaluate(["Ah", "Ad", "Ac", "Kd", "Ks", "2h", "3h"]);
  assert.strictEqual(rank.category, "full_house");
  assert.deepStrictEqual(rank.tiebreaker, [14, 13]);
});

test("hand rank: returns equal for tied hands", () => {
  const left = evaluate(["As", "Kd", "Qh", "Jh", "9s", "2c", "3d"]);
  const right = evaluate(["Ah", "Ks", "Qd", "Jc", "9h", "4s", "5c"]);
  assert.strictEqual(HandRank.compare(left, right), "eq");
});

test("hand rank: covers every category with correct ordering", () => {
  const ordered = [
    evaluate(["2c", "7d", "9h", "Jc", "Ks"]), // high card
    evaluate(["2c", "2d", "9h", "Jc", "Ks"]), // pair
    evaluate(["2c", "2d", "9h", "9c", "Ks"]), // two pair
    evaluate(["2c", "2d", "2h", "9c", "Ks"]), // trips
    evaluate(["5c", "6d", "7h", "8c", "9s"]), // straight
    evaluate(["2c", "5c", "9c", "Jc", "Kc"]), // flush
    evaluate(["2c", "2d", "2h", "9c", "9s"]), // full house
    evaluate(["2c", "2d", "2h", "2s", "9s"]), // quads
    evaluate(["5c", "6c", "7c", "8c", "9c"]), // straight flush
  ];

  const categories = ordered.map((rank) => rank.category);
  assert.deepStrictEqual(categories, [
    "high_card",
    "pair",
    "two_pair",
    "three_of_a_kind",
    "straight",
    "flush",
    "full_house",
    "four_of_a_kind",
    "straight_flush",
  ]);

  for (let i = 1; i < ordered.length; i++) {
    assert.strictEqual(
      HandRank.compare(ordered[i], ordered[i - 1]),
      "gt",
      `${categories[i]} should beat ${categories[i - 1]}`,
    );
  }
});

test("hand rank: kickers decide otherwise-equal hands", () => {
  const better = evaluate(["Ah", "Ad", "Kc", "Qd", "9s"]);
  const worse = evaluate(["Ac", "As", "Kh", "Qs", "8d"]);
  assert.strictEqual(HandRank.compare(better, worse), "gt");

  const highTwoPair = evaluate(["Ah", "Ad", "Kc", "Kd", "9s"]);
  const lowTwoPair = evaluate(["Ah", "Ad", "Qc", "Qd", "Js"]);
  assert.strictEqual(HandRank.compare(highTwoPair, lowTwoPair), "gt");
});

test("hand rank: wheel loses to six-high straight", () => {
  const wheel = evaluate(["Ah", "2d", "3c", "4d", "5s"]);
  const sixHigh = evaluate(["2h", "3d", "4c", "5d", "6s"]);
  assert.strictEqual(HandRank.compare(sixHigh, wheel), "gt");
});

test("hand rank: rejects invalid card counts", () => {
  assert.deepStrictEqual(HandRank.evaluate(cards(["Ah", "Kd", "Qh", "Jh"])), {
    ok: false,
    error: "invalid_card_count",
  });
  assert.deepStrictEqual(
    HandRank.evaluate(cards(["Ah", "Kd", "Qh", "Jh", "9s", "8s", "7s", "6s"])),
    { ok: false, error: "invalid_card_count" },
  );
});

/* ---------------------------------------------------------------- *
 * Table
 * ---------------------------------------------------------------- */

test("table: starts hand, posts blinds, and exposes legal preflop actions", () => {
  const table = startHand(threePlayerTable([1000, 1000, 1000]), { seed: 1 });
  const hand = table.hand;

  assert.strictEqual(hand.buttonSeat, 1);
  assert.strictEqual(hand.smallBlindSeat, 2);
  assert.strictEqual(hand.bigBlindSeat, 3);
  assert.strictEqual(hand.street, "preflop");
  assert.strictEqual(hand.pot, 150);
  assert.strictEqual(hand.toCall, 100);
  assert.strictEqual(hand.actingSeat, 1);

  assert.strictEqual(hand.players[2].stack, 950);
  assert.strictEqual(hand.players[3].stack, 900);

  for (const seat of [1, 2, 3]) {
    assert.strictEqual(hand.players[seat].holeCards.length, 2);
  }

  const options = legal(table);
  assert.strictEqual(options.seat, 1);
  assert.ok(options.options.includes("fold"));
  assert.ok(options.options.includes("call"));
  assert.ok(options.options.includes("raise"));
  assert.ok(!options.options.includes("check"));
});

test("table: rejects check while facing a bet", () => {
  const table = startHand(threePlayerTable([1000, 1000, 1000]), { seed: 1 });
  assert.deepStrictEqual(Table.act(table, 1, "check"), {
    ok: false,
    error: "invalid_action",
  });
});

test("table: rejects acting out of turn", () => {
  const table = startHand(threePlayerTable([1000, 1000, 1000]), { seed: 1 });
  assert.deepStrictEqual(Table.act(table, 2, "call"), {
    ok: false,
    error: "not_your_turn",
  });
});

test("table: preflop call/call/check advances to flop", () => {
  let table = startHand(threePlayerTable([1000, 1000, 1000]), { seed: 1 });
  table = act(table, 1, "call");
  table = act(table, 2, "call");
  table = act(table, 3, "check");

  const hand = table.hand;
  assert.strictEqual(hand.street, "flop");
  assert.strictEqual(hand.board.length, 3);
  assert.strictEqual(hand.toCall, 0);
  assert.strictEqual(hand.actingSeat, 2);
});

test("table: validates minimum bet and raise sizing on postflop streets", () => {
  let table = toFlop(threePlayerTable([1000, 1000, 1000]));

  let options = legal(table);
  assert.strictEqual(options.seat, 2);
  assert.deepStrictEqual(options.bet, {
    min: 100,
    max: 900,
    all_in_only: false,
  });

  assert.deepStrictEqual(Table.act(table, 2, { type: "bet", amount: 50 }), {
    ok: false,
    error: "invalid_amount",
  });

  table = act(table, 2, { type: "bet", amount: 120 });
  options = legal(table);

  assert.strictEqual(options.seat, 3);
  assert.strictEqual(options.to_call, 120);
  assert.deepStrictEqual(options.raise, {
    min: 240,
    max: 900,
    all_in_only: false,
  });
});

test("table: short all-in raise is allowed but does not reopen raising for prior aggressor", () => {
  let table = toFlop(threePlayerTable([1000, 1000, 250]));

  table = act(table, 2, { type: "bet", amount: 100 });

  const legalFor3 = legal(table);
  assert.strictEqual(legalFor3.seat, 3);
  assert.deepStrictEqual(legalFor3.raise, {
    min: 150,
    max: 150,
    all_in_only: true,
  });

  table = act(table, 3, { type: "raise", amount: 150 });
  table = act(table, 1, "call");

  const legalFor2 = legal(table);
  assert.strictEqual(legalFor2.seat, 2);
  assert.ok(legalFor2.options.includes("call"));
  assert.ok(!legalFor2.options.includes("raise"));
});

test("table: a full raise reopens betting for the prior aggressor", () => {
  let table = toFlop(threePlayerTable([1000, 1000, 1000]));

  table = act(table, 2, { type: "bet", amount: 100 });
  table = act(table, 3, { type: "raise", amount: 300 });
  table = act(table, 1, "fold");

  const legalFor2 = legal(table);
  assert.strictEqual(legalFor2.seat, 2);
  assert.ok(legalFor2.options.includes("raise"));
  assert.deepStrictEqual(legalFor2.raise, {
    min: 500,
    max: 900,
    all_in_only: false,
  });
});

test("table: awards pot immediately when everyone folds to a raise", () => {
  let table = startHand(threePlayerTable([1000, 1000, 1000]), { seed: 1 });
  table = act(table, 1, { type: "raise", amount: 300 });
  table = act(table, 2, "fold");
  table = act(table, 3, "fold");

  assert.strictEqual(table.hand, null);
  assert.strictEqual(table.seats[1].stack, 1150);
  assert.strictEqual(table.seats[2].stack, 950);
  assert.strictEqual(table.seats[3].stack, 900);
  assert.strictEqual(table.lastHandResult.endedBy, "fold");
  assert.deepStrictEqual(table.lastHandResult.winners, { 1: 450 });
});

test("table: splits pot on tied showdown", () => {
  const deck = deckWithTop([
    "Ah",
    "As",
    "Kd",
    "Qd",
    "9c",
    "2c",
    "3d",
    "4h",
    "Jh",
    "5s",
    "Qs",
    "6c",
  ]);

  const base = seatPlayers(
    Table.new("heads-up", { maxSeats: 2, smallBlind: 50, bigBlind: 100 }),
    [
      [1, "p1", 1000],
      [2, "p2", 1000],
    ],
  );

  let table = startHand(base, { deck });
  table = act(table, 1, "call");
  table = act(table, 2, "check");
  table = checkRound(table, [2, 1]);
  table = checkRound(table, [2, 1]);
  table = checkRound(table, [2, 1]);

  assert.strictEqual(table.hand, null);
  assert.strictEqual(table.lastHandResult.endedBy, "showdown");
  assert.deepStrictEqual(table.lastHandResult.winners, { 1: 100, 2: 100 });
  assert.strictEqual(table.seats[1].stack, 1000);
  assert.strictEqual(table.seats[2].stack, 1000);
});

test("table: handles side pots and busts players correctly", () => {
  const deck = deckWithTop([
    "7c",
    "Kc",
    "As",
    "7d",
    "Qc",
    "Ad",
    "3h",
    "7h",
    "2s",
    "2d",
    "4h",
    "9c",
    "5h",
    "Jc",
  ]);

  let table = startHand(threePlayerTable([500, 300, 500]), { deck });
  table = act(table, 1, { type: "raise", amount: 500 });
  table = act(table, 2, "call");
  table = act(table, 3, "call");

  assert.strictEqual(table.hand, null);
  assert.strictEqual(table.lastHandResult.endedBy, "showdown");
  assert.deepStrictEqual(table.lastHandResult.winners, { 1: 400, 2: 900 });
  assert.deepStrictEqual(
    table.lastHandResult.pots.map((pot) => pot.amount).sort((a, b) => a - b),
    [400, 900],
  );

  assert.strictEqual(table.seats[1].stack, 400);
  assert.strictEqual(table.seats[2].stack, 900);
  assert.strictEqual(table.seats[3].stack, 0);
  assert.strictEqual(table.seats[3].status, "busted");
});

test("table: button advances each hand and skips busted seats", () => {
  const deck = deckWithTop([
    "7c",
    "Kc",
    "As",
    "7d",
    "Qc",
    "Ad",
    "3h",
    "7h",
    "2s",
    "2d",
    "4h",
    "9c",
    "5h",
    "Jc",
  ]);

  let table = startHand(threePlayerTable([500, 300, 500]), { deck });
  assert.strictEqual(table.hand.buttonSeat, 1);
  table = act(table, 1, { type: "raise", amount: 500 });
  table = act(table, 2, "call");
  table = act(table, 3, "call");

  assert.strictEqual(table.seats[3].status, "busted");

  table = startHand(table, { seed: 10 });
  assert.strictEqual(table.hand.buttonSeat, 2);
  assert.strictEqual(table.hand.smallBlindSeat, 2);
  assert.strictEqual(table.hand.bigBlindSeat, 1);
});

test("table: heads-up button posts the small blind and acts first preflop", () => {
  const base = seatPlayers(
    Table.new("hu", { maxSeats: 2, smallBlind: 25, bigBlind: 50 }),
    [
      [1, "you", 5000],
      [2, "bot", 5000],
    ],
  );

  const table = startHand(base, { seed: 7 });
  assert.strictEqual(table.hand.buttonSeat, 1);
  assert.strictEqual(table.hand.smallBlindSeat, 1);
  assert.strictEqual(table.hand.bigBlindSeat, 2);
  assert.strictEqual(table.hand.actingSeat, 1);
  assert.strictEqual(table.hand.players[1].stack, 4975);
  assert.strictEqual(table.hand.players[2].stack, 4950);
  assert.strictEqual(table.hand.pot, 75);
});

test("table: heads-up non-button acts first postflop", () => {
  const base = seatPlayers(
    Table.new("hu", { maxSeats: 2, smallBlind: 25, bigBlind: 50 }),
    [
      [1, "you", 5000],
      [2, "bot", 5000],
    ],
  );

  let table = startHand(base, { seed: 7 });
  table = act(table, 1, "call");
  table = act(table, 2, "check");

  assert.strictEqual(table.hand.street, "flop");
  assert.strictEqual(table.hand.actingSeat, 2);
});

test("table: blinds rotate between hands heads-up", () => {
  const base = seatPlayers(
    Table.new("hu", { maxSeats: 2, smallBlind: 25, bigBlind: 50 }),
    [
      [1, "you", 5000],
      [2, "bot", 5000],
    ],
  );

  let table = startHand(base, { seed: 3 });
  table = act(table, 1, "fold");
  assert.strictEqual(table.hand, null);

  table = startHand(table, { seed: 4 });
  assert.strictEqual(table.hand.buttonSeat, 2);
  assert.strictEqual(table.hand.smallBlindSeat, 2);
  assert.strictEqual(table.hand.bigBlindSeat, 1);
  assert.strictEqual(table.hand.actingSeat, 2);
});

test("table: big blind may check or raise when action folds around preflop", () => {
  const base = seatPlayers(
    Table.new("hu", { maxSeats: 2, smallBlind: 25, bigBlind: 50 }),
    [
      [1, "you", 5000],
      [2, "bot", 5000],
    ],
  );

  let table = startHand(base, { seed: 11 });
  table = act(table, 1, "call");

  const options = legal(table);
  assert.strictEqual(options.seat, 2);
  assert.strictEqual(options.to_call, 0);
  assert.ok(options.options.includes("check"));
  assert.ok(options.options.includes("raise"));
  assert.deepStrictEqual(options.raise, {
    min: 100,
    max: 5000,
    all_in_only: false,
  });
});

test("table: all-in short stack builds a side pot and the extra returns to the caller", () => {
  // Seat 2 can only cover 300 of seat 1's 500; the excess forms a second pot
  // that only seats 1 and 3 contest.
  const deck = deckWithTop([
    "7c",
    "Kc",
    "As",
    "7d",
    "Qc",
    "Ad",
    "3h",
    "7h",
    "2s",
    "2d",
    "4h",
    "9c",
    "5h",
    "Jc",
  ]);

  let table = startHand(threePlayerTable([500, 300, 500]), { deck });
  table = act(table, 1, { type: "raise", amount: 500 });
  table = act(table, 2, "call");
  table = act(table, 3, "call");

  const pots = table.lastHandResult.pots;
  assert.strictEqual(pots.length, 2);

  const mainPot = pots.find((pot) => pot.amount === 900);
  const sidePot = pots.find((pot) => pot.amount === 400);
  assert.deepStrictEqual(mainPot.eligibleSeats, [1, 2, 3]);
  assert.deepStrictEqual(sidePot.eligibleSeats, [1, 3]);
});

test("table: rejects seating errors", () => {
  const table = Table.new("t", { maxSeats: 2, smallBlind: 25, bigBlind: 50 });
  assert.deepStrictEqual(Table.seatPlayer(table, 5, "x", 100), {
    ok: false,
    error: "invalid_seat",
  });
  assert.deepStrictEqual(Table.seatPlayer(table, 1, "x", 0), {
    ok: false,
    error: "invalid_player",
  });

  const seated = seatPlayers(table, [[1, "x", 100]]);
  assert.deepStrictEqual(Table.seatPlayer(seated, 1, "y", 100), {
    ok: false,
    error: "seat_occupied",
  });
  assert.deepStrictEqual(Table.seatPlayer(seated, 2, "x", 100), {
    ok: false,
    error: "player_already_seated",
  });
});

test("table: refuses to start without two funded players", () => {
  const table = seatPlayers(
    Table.new("t", { maxSeats: 2, smallBlind: 25, bigBlind: 50 }),
    [[1, "x", 100]],
  );
  assert.deepStrictEqual(Table.startHand(table, {}), {
    ok: false,
    error: "not_enough_players",
  });
});

test("table: refuses to start a hand while one is in progress", () => {
  const table = startHand(threePlayerTable([1000, 1000, 1000]), { seed: 1 });
  assert.deepStrictEqual(Table.startHand(table, {}), {
    ok: false,
    error: "hand_in_progress",
  });
});

test("table: rejects an invalid explicit deck", () => {
  const table = threePlayerTable([1000, 1000, 1000]);
  assert.deepStrictEqual(
    Table.startHand(table, { deck: [card("As"), card("As")] }),
    { ok: false, error: "invalid_deck" },
  );
});

test("table: all-in preflop runs the board out to five cards", () => {
  const base = seatPlayers(
    Table.new("hu", { maxSeats: 2, smallBlind: 25, bigBlind: 50 }),
    [
      [1, "you", 1000],
      [2, "bot", 1000],
    ],
  );

  let table = startHand(base, { seed: 21 });
  table = act(table, 1, { type: "raise", amount: 1000 });
  table = act(table, 2, "call");

  assert.strictEqual(table.hand, null);
  assert.strictEqual(table.lastHandResult.board.length, 5);
  assert.strictEqual(table.lastHandResult.endedBy, "showdown");

  const total = Object.values(table.lastHandResult.winners).reduce(
    (a, b) => a + b,
    0,
  );
  assert.strictEqual(total, 2000);
  assert.strictEqual(table.seats[1].stack + table.seats[2].stack, 2000);
});

test("table: chip conservation holds across a long seeded match", () => {
  let table = seatPlayers(
    Table.new("hu", { maxSeats: 2, smallBlind: 25, bigBlind: 50 }),
    [
      [1, "you", 5000],
      [2, "bot", 5000],
    ],
  );

  for (let hand = 0; hand < 60; hand++) {
    const started = Table.startHand(table, { seed: 1000 + hand });
    if (!started.ok) break;
    table = started.table;

    let guard = 0;
    while (table.hand && guard++ < 200) {
      const options = legal(table);
      // Deterministic pseudo-strategy: mix calls, checks and raises.
      const pick = (hand * 7 + guard * 13) % 10;
      let action;
      if (pick < 5 && options.options.includes("check")) action = "check";
      else if (pick < 7 && options.options.includes("call")) action = "call";
      else if (pick === 8 && options.raise) {
        action = { type: "raise", amount: options.raise.min };
      } else if (pick === 9 && options.bet) {
        action = { type: "bet", amount: options.bet.min };
      } else if (options.options.includes("check")) action = "check";
      else if (options.options.includes("call")) action = "call";
      else action = "fold";

      table = act(table, options.seat, action);
    }

    assert.strictEqual(table.hand, null, "hand should complete");
    assert.strictEqual(
      table.seats[1].stack + table.seats[2].stack,
      10000,
      `chips leaked on hand ${hand}`,
    );
  }
});

/* ---------------------------------------------------------------- *
 * Agent (port of heads_up_match_test.exs)
 * ---------------------------------------------------------------- */

test("agent: parses canonical action format", () => {
  assert.deepStrictEqual(Agent.parseAction("ACTION: call").action, {
    type: "call",
  });
  assert.deepStrictEqual(Agent.parseAction("action: check").action, {
    type: "check",
  });
  assert.deepStrictEqual(Agent.parseAction("ACTION: fold").action, {
    type: "fold",
  });
  assert.deepStrictEqual(Agent.parseAction("ACTION: bet 120").action, {
    type: "bet",
    amount: 120,
  });
  assert.deepStrictEqual(Agent.parseAction("ACTION: raise 350").action, {
    type: "raise",
    amount: 350,
  });
});

test("agent: parses action line from fenced output", () => {
  const answer = "```text\nACTION: raise 240\n```\n";
  assert.deepStrictEqual(Agent.parseAction(answer).action, {
    type: "raise",
    amount: 240,
  });
});

test("agent: parses an action line preceded by table talk", () => {
  const answer = "Nice try, meatbag.\nACTION: bet 200";
  const parsed = Agent.parseAction(answer);
  assert.deepStrictEqual(parsed.action, { type: "bet", amount: 200 });
  assert.strictEqual(Agent.parseTableTalk(answer), "Nice try, meatbag.");
});

test("agent: returns error for invalid format", () => {
  assert.deepStrictEqual(Agent.parseAction("I think calling is best."), {
    ok: false,
    error: "invalid_format",
  });
  assert.deepStrictEqual(Agent.parseAction(null), {
    ok: false,
    error: "invalid_format",
  });
});

test("agent: fallback picks the safest legal action", () => {
  assert.deepStrictEqual(
    Agent.fallbackAction({
      options: ["fold", "check", "bet"],
      bet: { min: 50, max: 500 },
    }),
    { type: "check" },
  );
  assert.deepStrictEqual(
    Agent.fallbackAction({
      options: ["fold", "call", "raise"],
      raise: { min: 100, max: 500 },
    }),
    { type: "call" },
  );
  assert.deepStrictEqual(Agent.fallbackAction({ options: ["fold"] }), {
    type: "fold",
  });
});

test("agent: prompt contains the full decision state", () => {
  const base = seatPlayers(
    Table.new("hu", { maxSeats: 2, smallBlind: 25, bigBlind: 50 }),
    [
      [1, "you", 5000],
      [2, "bot", 5000],
    ],
  );
  const table = startHand(base, { seed: 5 });
  const options = legal(table);
  const prompt = Agent.buildPrompt(table, options, "DEEPSEEK");

  assert.match(prompt, /ACTION: <fold\|check\|call\|bet N\|raise N>/);
  assert.match(prompt, /- street: preflop/);
  assert.match(prompt, /- pot: 75/);
  assert.match(prompt, /- board: \(none\)/);
  assert.match(prompt, /- your_hole_cards: [2-9TJQKA][cdhs] [2-9TJQKA][cdhs]/);
  assert.match(prompt, /- to_call: 25/);
  assert.match(
    prompt,
    /- legal_options: fold, call, raise \| raise_range=100-5000/,
  );
});

test("agent: decide falls back to a legal action when the worker is unreachable", async () => {
  const base = seatPlayers(
    Table.new("hu", { maxSeats: 2, smallBlind: 25, bigBlind: 50 }),
    [
      [1, "you", 5000],
      [2, "bot", 5000],
    ],
  );
  const table = startHand(base, { seed: 5 });
  const options = legal(table);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const decision = await Agent.decide(table, options, {
      attempts: 1,
      timeoutMs: 50,
    });
    assert.strictEqual(decision.source, "fallback");
    assert.ok(Table.isLegalAction(decision.action, options));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent: decide uses the worker answer when it is legal", async () => {
  const base = seatPlayers(
    Table.new("hu", { maxSeats: 2, smallBlind: 25, bigBlind: 50 }),
    [
      [1, "you", 5000],
      [2, "bot", 5000],
    ],
  );
  const table = startHand(base, { seed: 5 });
  const options = legal(table);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      action: "raise 150",
      raw: "You're bluffing.\nACTION: raise 150",
      model: "deepseek-v4-flash",
    }),
  });
  try {
    const decision = await Agent.decide(table, options, { attempts: 1 });
    assert.strictEqual(decision.source, "agent");
    assert.deepStrictEqual(decision.action, { type: "raise", amount: 150 });
    assert.strictEqual(decision.talk, "You're bluffing.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent: decide rejects an illegal worker answer and falls back", async () => {
  const base = seatPlayers(
    Table.new("hu", { maxSeats: 2, smallBlind: 25, bigBlind: 50 }),
    [
      [1, "you", 5000],
      [2, "bot", 5000],
    ],
  );
  const table = startHand(base, { seed: 5 });
  const options = legal(table);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ action: "raise 999999", raw: "ACTION: raise 999999" }),
  });
  try {
    const decision = await Agent.decide(table, options, { attempts: 1 });
    assert.strictEqual(decision.source, "fallback");
    assert.ok(Table.isLegalAction(decision.action, options));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
