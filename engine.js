/**
 * PokerEngine — a faithful JavaScript port of the Elixir `lemon_poker` engine.
 *
 * Ported modules:
 *   LemonPoker.Card     -> Card
 *   LemonPoker.Deck     -> Deck
 *   LemonPoker.HandRank -> HandRank
 *   LemonPoker.Table    -> Table
 *
 * The engine is pure state: every function receives and returns immutable-ish
 * plain objects. No DOM, no globals beyond the single export.
 *
 * Result convention: functions that can fail return
 *   { ok: true,  ...payload }   or   { ok: false, error: "reason" }
 * mirroring Elixir's {:ok, value} | {:error, reason}.
 */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Card
   * ------------------------------------------------------------------ */

  const RANKS = [
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "jack",
    "queen",
    "king",
    "ace",
  ];
  const SUITS = ["clubs", "diamonds", "hearts", "spades"];

  const RANK_VALUES = RANKS.reduce((acc, rank, index) => {
    acc[rank] = index + 2;
    return acc;
  }, {});

  const RANK_CHARS = {
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
    9: "nine",
    T: "ten",
    J: "jack",
    Q: "queen",
    K: "king",
    A: "ace",
  };
  const SUIT_CHARS = { c: "clubs", d: "diamonds", h: "hearts", s: "spades" };

  const REVERSE_RANK_CHARS = Object.keys(RANK_CHARS).reduce((acc, char) => {
    acc[RANK_CHARS[char]] = char;
    return acc;
  }, {});
  const REVERSE_SUIT_CHARS = Object.keys(SUIT_CHARS).reduce((acc, char) => {
    acc[SUIT_CHARS[char]] = char;
    return acc;
  }, {});

  const SUIT_SYMBOLS = { clubs: "♣", diamonds: "♦", hearts: "♥", spades: "♠" };

  const Card = {
    RANKS,
    SUITS,

    new(rank, suit) {
      if (RANKS.indexOf(rank) === -1 || SUITS.indexOf(suit) === -1) {
        return { ok: false, error: "invalid_card" };
      }
      return { ok: true, card: { rank, suit } };
    },

    /** Full 52-card deck in rank/suit canonical order (suits outer, ranks inner). */
    fullDeck() {
      const deck = [];
      for (const suit of SUITS) {
        for (const rank of RANKS) deck.push({ rank, suit });
      }
      return deck;
    },

    /** Numeric rank value 2..14. */
    rankValue(card) {
      return RANK_VALUES[card.rank];
    },

    /** Parses short notation like "As" or "Td". */
    fromString(text) {
      if (typeof text !== "string" || text.length !== 2) {
        return { ok: false, error: "invalid_card" };
      }
      const rank = RANK_CHARS[text[0].toUpperCase()];
      const suit = SUIT_CHARS[text[1].toLowerCase()];
      if (!rank || !suit) return { ok: false, error: "invalid_card" };
      return { ok: true, card: { rank, suit } };
    },

    /** Serializes a card to short notation like "As". */
    toShortString(card) {
      return REVERSE_RANK_CHARS[card.rank] + REVERSE_SUIT_CHARS[card.suit];
    },

    /** Display helpers for the UI layer. */
    rankLabel(card) {
      return REVERSE_RANK_CHARS[card.rank];
    },

    suitSymbol(card) {
      return SUIT_SYMBOLS[card.suit];
    },

    isRed(card) {
      return card.suit === "hearts" || card.suit === "diamonds";
    },

    equal(a, b) {
      return !!a && !!b && a.rank === b.rank && a.suit === b.suit;
    },
  };

  /* ------------------------------------------------------------------ *
   * Deck
   * ------------------------------------------------------------------ */

  /**
   * Mirrors LemonPoker.Deck.normalize_seed/1: spreads an integer seed across
   * three large state words before feeding the PRNG.
   */
  function normalizeSeed(seed) {
    let base;
    if (typeof seed === "number" && Number.isInteger(seed)) {
      base = Math.abs(seed) + 1;
    } else {
      base = stringHash(String(seed)) + 1;
    }
    const m = 302681999;
    const rem1 = (base * 31415927) % m;
    const rem2 = (base * 77021123) % m;
    const rem3 = (base * 91781223) % m;
    return [Math.max(rem1, 1), Math.max(rem2, 1), Math.max(rem3, 1)];
  }

  function stringHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) % 2147483647;
    }
    return Math.abs(hash);
  }

  /** sfc32 — small, fast, deterministic PRNG returning floats in [0, 1). */
  function makeRng(a, b, c) {
    let s0 = a >>> 0;
    let s1 = b >>> 0;
    let s2 = c >>> 0;
    let s3 = 1;
    return function next() {
      const t = (((s0 + s1) | 0) + s3) | 0;
      s3 = (s3 + 1) | 0;
      s0 = s1 ^ (s1 >>> 9);
      s1 = (s2 + (s2 << 3)) | 0;
      s2 = ((s2 << 21) | (s2 >>> 11)) >>> 0;
      s2 = (s2 + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  const Deck = {
    new() {
      return Card.fullDeck();
    },

    /**
     * Shuffles a deck. `opts.seed` (integer or string) gives a deterministic
     * order, exactly as the Elixir version does with :rand seeding.
     */
    shuffle(deck, opts) {
      const cards = (deck || Deck.new()).slice();
      const seed = opts && opts.seed != null ? opts.seed : null;
      if (seed === null) {
        for (let i = cards.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = cards[i];
          cards[i] = cards[j];
          cards[j] = tmp;
        }
        return cards;
      }
      const [a, b, c] = normalizeSeed(seed);
      const rng = makeRng(a, b, c);
      // Decorate/sort/undecorate, mirroring Enum.map_reduce + sort_by.
      return cards
        .map((card) => ({ key: rng(), card }))
        .sort((x, y) => x.key - y.key)
        .map((pair) => pair.card);
    },

    /** Deals `count` cards off the top. */
    deal(deck, count) {
      if (!Number.isInteger(count) || count < 0) {
        return { ok: false, error: "not_enough_cards" };
      }
      if (deck.length < count) return { ok: false, error: "not_enough_cards" };
      return { ok: true, cards: deck.slice(0, count), rest: deck.slice(count) };
    },

    /** Burns the top card. */
    burn(deck) {
      const dealt = Deck.deal(deck, 1);
      if (!dealt.ok) return dealt;
      return { ok: true, card: dealt.cards[0], rest: dealt.rest };
    },

    /** True when the list is a deduplicated list of cards. */
    valid(deck) {
      if (!Array.isArray(deck)) return false;
      const seen = new Set();
      for (const card of deck) {
        if (
          !card ||
          RANKS.indexOf(card.rank) === -1 ||
          SUITS.indexOf(card.suit) === -1
        ) {
          return false;
        }
        const key = Card.toShortString(card);
        if (seen.has(key)) return false;
        seen.add(key);
      }
      return true;
    },
  };

  /* ------------------------------------------------------------------ *
   * HandRank
   * ------------------------------------------------------------------ */

  const CATEGORY_VALUES = {
    high_card: 0,
    pair: 1,
    two_pair: 2,
    three_of_a_kind: 3,
    straight: 4,
    flush: 5,
    full_house: 6,
    four_of_a_kind: 7,
    straight_flush: 8,
  };

  const CATEGORY_LABELS = {
    high_card: "HIGH CARD",
    pair: "PAIR",
    two_pair: "TWO PAIR",
    three_of_a_kind: "THREE OF A KIND",
    straight: "STRAIGHT",
    flush: "FLUSH",
    full_house: "FULL HOUSE",
    four_of_a_kind: "FOUR OF A KIND",
    straight_flush: "STRAIGHT FLUSH",
  };

  const HandRank = {
    CATEGORY_VALUES,

    /** Evaluates 5-7 cards, returning the best 5-card rank. */
    evaluate(cards) {
      if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
        return { ok: false, error: "invalid_card_count" };
      }
      let best = null;
      for (const combo of combinations(cards, 5)) {
        const rank = evaluateFive(combo);
        if (best === null || compareRanks(rank, best) > 0) best = rank;
      }
      return { ok: true, rank: best };
    },

    /** Compares two ranks -> "gt" | "lt" | "eq". */
    compare(left, right) {
      const cmp = compareRanks(left, right);
      if (cmp > 0) return "gt";
      if (cmp < 0) return "lt";
      return "eq";
    },

    label(rank) {
      return (
        CATEGORY_LABELS[rank.category] || String(rank.category).toUpperCase()
      );
    },

    /** Human-ish description, e.g. "FULL HOUSE, ACES FULL OF KINGS". */
    describe(rank) {
      const t = rank.tiebreaker;
      const name = (value) => valueName(value);
      const plural = (value) => valueName(value) + "S";
      switch (rank.category) {
        case "straight_flush":
          return t[0] === 14
            ? "ROYAL FLUSH"
            : `STRAIGHT FLUSH, ${name(t[0])} HIGH`;
        case "four_of_a_kind":
          return `FOUR OF A KIND, ${plural(t[0])}`;
        case "full_house":
          return `FULL HOUSE, ${plural(t[0])} FULL OF ${plural(t[1])}`;
        case "flush":
          return `FLUSH, ${name(t[0])} HIGH`;
        case "straight":
          return `STRAIGHT, ${name(t[0])} HIGH`;
        case "three_of_a_kind":
          return `THREE OF A KIND, ${plural(t[0])}`;
        case "two_pair":
          return `TWO PAIR, ${plural(t[0])} AND ${plural(t[1])}`;
        case "pair":
          return `PAIR OF ${plural(t[0])}`;
        default:
          return `HIGH CARD ${name(t[0])}`;
      }
    },
  };

  const VALUE_NAMES = {
    2: "TWO",
    3: "THREE",
    4: "FOUR",
    5: "FIVE",
    6: "SIX",
    7: "SEVEN",
    8: "EIGHT",
    9: "NINE",
    10: "TEN",
    11: "JACK",
    12: "QUEEN",
    13: "KING",
    14: "ACE",
  };
  function valueName(value) {
    return VALUE_NAMES[value] || String(value);
  }

  function compareRanks(left, right) {
    if (left.categoryValue !== right.categoryValue) {
      return left.categoryValue - right.categoryValue;
    }
    const a = left.tiebreaker;
    const b = right.tiebreaker;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = i < a.length ? a[i] : -1;
      const bv = i < b.length ? b[i] : -1;
      if (av !== bv) return av - bv;
    }
    return 0;
  }

  function evaluateFive(cards) {
    const values = cards.map(Card.rankValue);
    const suits = cards.map((card) => card.suit);
    const sortedDesc = values.slice().sort((a, b) => b - a);
    const isFlush = new Set(suits).size === 1;
    const high = straightHigh(values);
    const counts = valueCounts(values);

    if (isFlush && high !== null) return rank("straight_flush", [high], cards);

    if (hasKind(counts, 4)) {
      const quad = ofKind(counts, 4)[0][0];
      const kicker = ofKind(counts, 1)[0][0];
      return rank("four_of_a_kind", [quad, kicker], cards);
    }

    if (hasKind(counts, 3) && hasKind(counts, 2)) {
      const trip = ofKind(counts, 3)[0][0];
      const pair = ofKind(counts, 2)[0][0];
      return rank("full_house", [trip, pair], cards);
    }

    if (isFlush) return rank("flush", sortedDesc, cards);
    if (high !== null) return rank("straight", [high], cards);

    if (hasKind(counts, 3)) {
      const trip = ofKind(counts, 3)[0][0];
      const kickers = ofKind(counts, 1)
        .map((entry) => entry[0])
        .sort((a, b) => b - a);
      return rank("three_of_a_kind", [trip].concat(kickers), cards);
    }

    if (ofKind(counts, 2).length === 2) {
      const pairs = ofKind(counts, 2)
        .map((entry) => entry[0])
        .sort((a, b) => b - a);
      const kicker = ofKind(counts, 1)[0][0];
      return rank("two_pair", [pairs[0], pairs[1], kicker], cards);
    }

    if (hasKind(counts, 2)) {
      const pair = ofKind(counts, 2)[0][0];
      const kickers = ofKind(counts, 1)
        .map((entry) => entry[0])
        .sort((a, b) => b - a);
      return rank("pair", [pair].concat(kickers), cards);
    }

    return rank("high_card", sortedDesc, cards);
  }

  function rank(category, tiebreaker, cards) {
    return {
      category,
      categoryValue: CATEGORY_VALUES[category],
      tiebreaker,
      bestFive: cards.slice(),
    };
  }

  /** [[value, count], ...] sorted by count desc, then value desc. */
  function valueCounts(values) {
    const freq = new Map();
    for (const value of values) freq.set(value, (freq.get(value) || 0) + 1);
    return Array.from(freq.entries()).sort(
      (a, b) => b[1] - a[1] || b[0] - a[0],
    );
  }

  function hasKind(counts, n) {
    return counts.some((entry) => entry[1] === n);
  }

  function ofKind(counts, n) {
    return counts.filter((entry) => entry[1] === n);
  }

  function straightHigh(values) {
    const unique = Array.from(new Set(values)).sort((a, b) => b - a);
    const set = new Set(unique);
    if ([14, 5, 4, 3, 2].every((value) => set.has(value))) return 5;
    if (unique.length < 5) return null;
    for (let i = 0; i + 5 <= unique.length; i++) {
      const [a, b, c, d, e] = unique.slice(i, i + 5);
      if (a - 1 === b && b - 1 === c && c - 1 === d && d - 1 === e) return a;
    }
    return null;
  }

  function combinations(list, size) {
    const out = [];
    const combo = new Array(size);
    (function walk(start, depth) {
      if (depth === size) {
        out.push(combo.slice());
        return;
      }
      for (let i = start; i <= list.length - (size - depth); i++) {
        combo[depth] = list[i];
        walk(i + 1, depth + 1);
      }
    })(0, 0);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Table
   * ------------------------------------------------------------------ */

  const STREETS = ["preflop", "flop", "turn", "river"];

  function cloneSeats(seats) {
    const out = {};
    for (const key of Object.keys(seats))
      out[key] = Object.assign({}, seats[key]);
    return out;
  }

  function clonePlayers(players) {
    const out = {};
    for (const key of Object.keys(players)) {
      const player = players[key];
      out[key] = Object.assign({}, player, {
        holeCards: player.holeCards.slice(),
      });
    }
    return out;
  }

  /** Sorted numeric seat keys of a seat/player map. */
  function seatKeys(map) {
    return Object.keys(map)
      .map(Number)
      .sort((a, b) => a - b);
  }

  function nextInRing(sortedSeats, seat) {
    if (sortedSeats.length === 0) return null;
    for (const candidate of sortedSeats) {
      if (candidate > seat) return candidate;
    }
    return sortedSeats[0];
  }

  function rotateFrom(list, first) {
    const index = list.indexOf(first);
    if (index === -1) return list.slice();
    return list.slice(index).concat(list.slice(0, index));
  }

  function canAct(player) {
    return !player.folded && !player.allIn && player.stack > 0;
  }

  function commitChips(player, requested) {
    const amount = Math.min(Math.max(requested, 0), player.stack);
    const stack = player.stack - amount;
    const updated = Object.assign({}, player, {
      stack,
      committedRound: player.committedRound + amount,
      committedTotal: player.committedTotal + amount,
      allIn: stack === 0,
    });
    return { player: updated, committed: amount };
  }

  const Table = {
    /**
     * Creates a table state.
     * opts: { maxSeats = 9, smallBlind = 50, bigBlind = 100 }
     */
    new(id, opts) {
      const options = opts || {};
      const maxSeats = options.maxSeats == null ? 9 : options.maxSeats;
      const smallBlind = options.smallBlind == null ? 50 : options.smallBlind;
      const bigBlind = options.bigBlind == null ? 100 : options.bigBlind;

      if (!(maxSeats > 1)) throw new Error("max_seats must be > 1");
      if (!(smallBlind > 0 && bigBlind > 0 && bigBlind >= smallBlind)) {
        throw new Error("invalid blind values");
      }

      return {
        id,
        maxSeats,
        smallBlind,
        bigBlind,
        buttonSeat: null,
        handId: 0,
        seats: {},
        hand: null,
        lastHandResult: null,
      };
    },

    /** Seats a player. */
    seatPlayer(table, seat, playerId, stack) {
      if (
        !Number.isInteger(seat) ||
        typeof playerId !== "string" ||
        !Number.isInteger(stack) ||
        stack <= 0
      ) {
        return { ok: false, error: "invalid_player" };
      }
      if (seat < 1 || seat > table.maxSeats)
        return { ok: false, error: "invalid_seat" };
      if (Object.prototype.hasOwnProperty.call(table.seats, seat)) {
        return { ok: false, error: "seat_occupied" };
      }
      const taken = seatKeys(table.seats).some(
        (key) => table.seats[key].playerId === playerId,
      );
      if (taken) return { ok: false, error: "player_already_seated" };

      const seats = cloneSeats(table.seats);
      seats[seat] = { seat, playerId, stack, status: "active" };
      return { ok: true, table: Object.assign({}, table, { seats }) };
    },

    /** Updates a seated player's status: active | sitting_out | busted. */
    setStatus(table, seat, status) {
      if (["active", "sitting_out", "busted"].indexOf(status) === -1) {
        return { ok: false, error: "invalid_status" };
      }
      if (!table.seats[seat]) return { ok: false, error: "seat_not_found" };
      const seats = cloneSeats(table.seats);
      seats[seat].status = status;
      return { ok: true, table: Object.assign({}, table, { seats }) };
    },

    /**
     * Starts a hand: shuffles, deals hole cards, posts blinds, sets the button.
     * opts: { seed } for a deterministic shuffle, or { deck } for an explicit deck.
     */
    startHand(table, opts) {
      const options = opts || {};
      if (table.hand) return { ok: false, error: "hand_in_progress" };

      const active = activeSeats(table);
      if (active.length < 2) return { ok: false, error: "not_enough_players" };

      const button =
        table.buttonSeat == null
          ? active[0]
          : nextInRing(active, table.buttonSeat);
      const { smallBlindSeat, bigBlindSeat } = blindSeats(active, button);

      const resolved = resolveDeck(options);
      if (!resolved.ok) return resolved;

      const dealt = dealHoleCards(table, active, smallBlindSeat, resolved.deck);
      if (!dealt.ok) return dealt;

      const posted = postBlinds(
        dealt.players,
        smallBlindSeat,
        table.smallBlind,
        bigBlindSeat,
        table.bigBlind,
      );

      const toCall = Math.max(posted.sbPosted, posted.bbPosted);
      const firstActor = preflopFirstActor(
        active,
        bigBlindSeat,
        posted.players,
      );
      const actionQueue = buildQueue(posted.players, firstActor);

      const hand = {
        id: table.handId + 1,
        buttonSeat: button,
        smallBlindSeat,
        bigBlindSeat,
        street: "preflop",
        deck: dealt.deck,
        board: [],
        pot: posted.pot,
        toCall,
        minRaise: table.bigBlind,
        players: posted.players,
        actionQueue,
        actingSeat: actionQueue.length ? actionQueue[0] : null,
        events: [
          {
            type: "blind_posted",
            seat: smallBlindSeat,
            amount: posted.sbPosted,
          },
          { type: "blind_posted", seat: bigBlindSeat, amount: posted.bbPosted },
        ],
      };

      const started = Object.assign({}, table, {
        buttonSeat: button,
        handId: table.handId + 1,
        hand,
        lastHandResult: null,
      });

      return { ok: true, table: advanceUntilActionOrComplete(started) };
    },

    /** Legal actions for the current actor. */
    legalActions(table) {
      if (!table.hand) return { ok: false, error: "no_hand_in_progress" };
      const hand = table.hand;
      const seat = hand.actingSeat;
      if (seat == null) return { ok: false, error: "no_actor" };

      const player = hand.players[seat];
      const callAmount = Math.max(hand.toCall - player.committedRound, 0);
      const maxTotal = player.committedRound + player.stack;
      const facingBet = hand.toCall > 0;

      let raiseSpec = null;
      if (player.canRaise && maxTotal > hand.toCall) {
        const minTotal = hand.toCall + hand.minRaise;
        if (maxTotal < minTotal) {
          raiseSpec = { min: maxTotal, max: maxTotal, all_in_only: true };
        } else {
          raiseSpec = { min: minTotal, max: maxTotal, all_in_only: false };
        }
      }

      let betSpec = null;
      if (player.canRaise && !facingBet && player.stack > 0) {
        const minTotal = hand.minRaise;
        if (maxTotal < minTotal && maxTotal > 0) {
          betSpec = { min: maxTotal, max: maxTotal, all_in_only: true };
        } else if (maxTotal >= minTotal) {
          betSpec = { min: minTotal, max: maxTotal, all_in_only: false };
        }
      }

      const options = [];
      options.push("fold");
      if (callAmount === 0) options.push("check");
      if (callAmount > 0 && player.stack > 0) options.push("call");
      if (betSpec) options.push("bet");
      if (raiseSpec) options.push("raise");

      return {
        ok: true,
        legal: {
          seat,
          street: hand.street,
          to_call: callAmount,
          options,
          bet: betSpec,
          raise: raiseSpec,
        },
      };
    },

    /**
     * Applies an action for the acting seat.
     * `action` is "fold" | "check" | "call" | {type:"bet"|"raise", amount}.
     * Amounts are the TOTAL committed for the street, not the increment.
     */
    act(table, seat, action) {
      if (!table.hand) return { ok: false, error: "no_hand_in_progress" };
      if (table.hand.actingSeat !== seat)
        return { ok: false, error: "not_your_turn" };

      const normalized = Table.normalizeAction(action);
      if (!normalized) return { ok: false, error: "invalid_action" };

      const legalResult = Table.legalActions(table);
      if (!legalResult.ok) return legalResult;

      const validation = validateAction(normalized, legalResult.legal);
      if (!validation.ok) return validation;

      const hand = applyAction(table.hand, seat, normalized);
      const updated = Object.assign({}, table, { hand });
      return { ok: true, table: advanceUntilActionOrComplete(updated) };
    },

    /** Accepts "fold" / {type:"fold"} / {type:"bet", amount:120}. */
    normalizeAction(action) {
      if (typeof action === "string") {
        if (["fold", "check", "call"].indexOf(action) !== -1)
          return { type: action };
        return null;
      }
      if (!action || typeof action !== "object") return null;
      const type = action.type;
      if (["fold", "check", "call"].indexOf(type) !== -1) return { type };
      if (
        (type === "bet" || type === "raise") &&
        Number.isInteger(action.amount)
      ) {
        return { type, amount: action.amount };
      }
      return null;
    },

    /** True when the action is currently legal for the actor. */
    isLegalAction(action, legal) {
      const normalized = Table.normalizeAction(action);
      if (!normalized) return false;
      return validateAction(normalized, legal).ok;
    },

    formatAction(action) {
      const normalized = Table.normalizeAction(action);
      if (!normalized) return "";
      if (normalized.type === "bet" || normalized.type === "raise") {
        return `${normalized.type} ${normalized.amount}`;
      }
      return normalized.type;
    },

    /** Seats that are eligible to be dealt in. */
    activeSeats,

    /** Seats still in the hand (not folded). */
    contenderSeats,
  };

  function validateAction(action, legal) {
    const has = (option) => legal.options.indexOf(option) !== -1;

    if (
      action.type === "fold" ||
      action.type === "check" ||
      action.type === "call"
    ) {
      return has(action.type)
        ? { ok: true }
        : { ok: false, error: "invalid_action" };
    }

    const spec = action.type === "bet" ? legal.bet : legal.raise;
    if (!has(action.type) || !spec)
      return { ok: false, error: "invalid_action" };

    if (spec.all_in_only) {
      return action.amount === spec.max
        ? { ok: true }
        : { ok: false, error: "invalid_amount" };
    }
    if (action.amount >= spec.min && action.amount <= spec.max)
      return { ok: true };
    return { ok: false, error: "invalid_amount" };
  }

  function applyAction(hand, seat, action) {
    switch (action.type) {
      case "fold": {
        const players = clonePlayers(hand.players);
        players[seat].folded = true;
        players[seat].canRaise = false;
        const queue = trimQueue(hand.actionQueue.slice(1), players);
        const pot = seatKeys(players).reduce(
          (acc, key) => acc + players[key].committedTotal,
          0,
        );
        return Object.assign({}, hand, {
          players,
          actionQueue: queue,
          actingSeat: queue.length ? queue[0] : null,
          pot,
          events: hand.events.concat([
            { type: "action", seat, action: "fold" },
          ]),
        });
      }

      case "check": {
        const players = clonePlayers(hand.players);
        players[seat].canRaise = false;
        const queue = trimQueue(hand.actionQueue.slice(1), players);
        return Object.assign({}, hand, {
          players,
          actionQueue: queue,
          actingSeat: queue.length ? queue[0] : null,
          events: hand.events.concat([
            { type: "action", seat, action: "check" },
          ]),
        });
      }

      case "call": {
        const players = clonePlayers(hand.players);
        const callAmount = Math.max(
          hand.toCall - players[seat].committedRound,
          0,
        );
        const committed = commitChips(players[seat], callAmount);
        players[seat] = Object.assign(committed.player, { canRaise: false });
        const queue = trimQueue(hand.actionQueue.slice(1), players);
        return Object.assign({}, hand, {
          players,
          actionQueue: queue,
          actingSeat: queue.length ? queue[0] : null,
          pot: hand.pot + committed.committed,
          events: hand.events.concat([
            {
              type: "action",
              seat,
              action: "call",
              amount: committed.committed,
            },
          ]),
        });
      }

      case "bet":
      case "raise": {
        const players = clonePlayers(hand.players);
        const additional = action.amount - players[seat].committedRound;
        const committed = commitChips(players[seat], additional);
        players[seat] = Object.assign(committed.player, { canRaise: false });

        // For a bet the raise size is the bet itself; for a raise it is the
        // increment above the current bet.
        const raiseSize =
          action.type === "bet" ? action.amount : action.amount - hand.toCall;
        const fullRaise = raiseSize >= hand.minRaise;
        const minRaise = applyRaiseReopenRules(
          players,
          seat,
          fullRaise,
          hand.minRaise,
          raiseSize,
        );
        const queue = queueAfterAggression(players, seat);

        return Object.assign({}, hand, {
          players,
          toCall: action.amount,
          minRaise,
          pot: hand.pot + committed.committed,
          actionQueue: queue,
          actingSeat: queue.length ? queue[0] : null,
          events: hand.events.concat([
            {
              type: "action",
              seat,
              action: action.type,
              amount: action.amount,
            },
          ]),
        });
      }

      default:
        throw new Error(`unknown action: ${action.type}`);
    }
  }

  /**
   * A full-size raise reopens the betting for everyone else. A short all-in
   * raise does not: `canRaise` stays as it was, so players who already acted
   * may only call or fold.
   */
  function applyRaiseReopenRules(
    players,
    actorSeat,
    fullRaise,
    oldMinRaise,
    raiseSize,
  ) {
    if (!fullRaise) return oldMinRaise;
    for (const key of seatKeys(players)) {
      players[key].canRaise = canAct(players[key]) && key !== actorSeat;
    }
    return raiseSize;
  }

  function queueAfterAggression(players, actorSeat) {
    const seats = seatKeys(players);
    const first = nextInRing(seats, actorSeat);
    return rotateFrom(seats, first)
      .filter((seat) => seat !== actorSeat)
      .filter((seat) => canAct(players[seat]));
  }

  function trimQueue(queue, players) {
    return queue.filter((seat) => canAct(players[seat]));
  }

  function advanceUntilActionOrComplete(table) {
    let current = table;
    for (;;) {
      const hand = current.hand;
      if (!hand) return current;

      const contenders = contenderSeats(hand.players);
      if (contenders.length === 1)
        return finishUncontested(current, contenders[0]);
      if (showdownReady(hand)) return finishShowdown(current);
      if (hand.actionQueue.length === 0 && hand.street === "river")
        return finishShowdown(current);
      if (hand.actionQueue.length === 0) {
        current = advanceStreet(current);
        continue;
      }
      return Object.assign({}, current, {
        hand: Object.assign({}, hand, { actingSeat: hand.actionQueue[0] }),
      });
    }
  }

  function showdownReady(hand) {
    return (
      contenderSeats(hand.players).length > 1 &&
      actableSeats(hand.players).length === 0
    );
  }

  function finishUncontested(table, winnerSeat) {
    const hand = table.hand;
    const players = clonePlayers(hand.players);
    players[winnerSeat].stack += hand.pot;

    const winners = {};
    winners[winnerSeat] = hand.pot;

    const result = {
      handId: hand.id,
      board: hand.board.map(Card.toShortString),
      winners,
      pots: [{ amount: hand.pot, eligibleSeats: [winnerSeat] }],
      endedBy: "fold",
      showdown: null,
      holeCards: holeCardMap(hand.players),
    };

    return finalizeHand(table, players, result);
  }

  function advanceStreet(table) {
    const hand = table.hand;
    const info = nextStreetInfo(hand.street);
    const burned = Deck.burn(hand.deck);
    if (!burned.ok) throw new Error("deck exhausted while advancing street");
    const drawn = Deck.deal(burned.rest, info.count);
    if (!drawn.ok) throw new Error("deck exhausted while advancing street");

    const players = resetRoundState(hand.players);
    const board = hand.board.concat(drawn.cards);
    const firstActor = postflopFirstActor(players, hand.buttonSeat);
    const queue = buildQueue(players, firstActor);

    return Object.assign({}, table, {
      hand: Object.assign({}, hand, {
        street: info.street,
        board,
        deck: drawn.rest,
        toCall: 0,
        minRaise: table.bigBlind,
        players,
        actionQueue: queue,
        actingSeat: queue.length ? queue[0] : null,
        events: hand.events.concat([
          { type: "street_changed", street: info.street, board },
        ]),
      }),
    });
  }

  function finishShowdown(table) {
    const hand = runoutToRiver(table.hand);
    const sidePots = buildSidePots(hand.players);
    const { winnings, rankedHands } = distributeSidePots(hand, sidePots);

    const players = clonePlayers(hand.players);
    for (const key of Object.keys(winnings)) {
      players[key].stack += winnings[key];
    }

    const showdown = {};
    for (const key of Object.keys(rankedHands)) {
      const seat = Number(key);
      const handRank = rankedHands[key];
      showdown[seat] = {
        category: handRank.category,
        tiebreaker: handRank.tiebreaker,
        label: HandRank.describe(handRank),
        holeCards: hand.players[seat].holeCards.map(Card.toShortString),
        bestFive: handRank.bestFive.map(Card.toShortString),
      };
    }

    const result = {
      handId: hand.id,
      board: hand.board.map(Card.toShortString),
      winners: winnings,
      pots: sidePots.map((pot) => ({
        amount: pot.amount,
        eligibleSeats: pot.eligibleSeats,
      })),
      showdown,
      endedBy: "showdown",
      holeCards: holeCardMap(hand.players),
    };

    return finalizeHand(Object.assign({}, table, { hand }), players, result);
  }

  function holeCardMap(players) {
    const out = {};
    for (const seat of seatKeys(players)) {
      out[seat] = players[seat].holeCards.map(Card.toShortString);
    }
    return out;
  }

  function finalizeHand(table, finalPlayers, result) {
    const seats = cloneSeats(table.seats);
    for (const seat of seatKeys(finalPlayers)) {
      const handPlayer = finalPlayers[seat];
      const seatPlayer = seats[seat];
      let status;
      if (handPlayer.stack === 0) status = "busted";
      else if (seatPlayer.status === "sitting_out") status = "sitting_out";
      else status = "active";
      seats[seat] = Object.assign({}, seatPlayer, {
        stack: handPlayer.stack,
        status,
      });
    }

    return Object.assign({}, table, {
      seats,
      hand: null,
      lastHandResult: result,
    });
  }

  /** Runs the board out to five cards when everyone is all-in. */
  function runoutToRiver(hand) {
    const needed = 5 - hand.board.length;
    if (needed <= 0) return Object.assign({}, hand, { street: "river" });

    const plan = { preflop: [3, 1, 1], flop: [1, 1], turn: [1], river: [] }[
      hand.street
    ];
    let deck = hand.deck;
    let board = hand.board.slice();

    for (const count of plan) {
      if (count === 0 || board.length === 5) continue;
      const burned = Deck.burn(deck);
      if (!burned.ok) throw new Error("deck exhausted during runout");
      const drawn = Deck.deal(burned.rest, count);
      if (!drawn.ok) throw new Error("deck exhausted during runout");
      deck = drawn.rest;
      board = board.concat(drawn.cards);
    }

    return Object.assign({}, hand, {
      deck,
      board,
      street: "river",
      actionQueue: [],
      actingSeat: null,
    });
  }

  function distributeSidePots(hand, sidePots) {
    const rankedHands = {};
    for (const seat of contenderSeats(hand.players)) {
      const player = hand.players[seat];
      const evaluated = HandRank.evaluate(player.holeCards.concat(hand.board));
      if (!evaluated.ok) throw new Error("cannot evaluate showdown hand");
      rankedHands[seat] = evaluated.rank;
    }

    const winnings = {};
    for (const pot of sidePots) {
      const winners = winningSeatsForPot(pot, rankedHands);
      for (const [seat, amount] of splitPot(
        pot.amount,
        winners,
        hand.buttonSeat,
      )) {
        winnings[seat] = (winnings[seat] || 0) + amount;
      }
    }

    return { winnings, rankedHands };
  }

  function winningSeatsForPot(pot, rankedHands) {
    const eligible = pot.eligibleSeats;
    let winners = [eligible[0]];
    let bestRank = rankedHands[eligible[0]];

    for (const seat of eligible.slice(1)) {
      const current = rankedHands[seat];
      const cmp = HandRank.compare(current, bestRank);
      if (cmp === "gt") {
        winners = [seat];
        bestRank = current;
      } else if (cmp === "eq") {
        winners = [seat].concat(winners);
      }
    }

    return winners.slice().sort((a, b) => a - b);
  }

  /** Splits a pot; the odd chip goes to the first winner left of the button. */
  function splitPot(amount, winners, buttonSeat) {
    const share = Math.floor(amount / winners.length);
    const remainder = amount % winners.length;
    const sorted = winners.slice().sort((a, b) => a - b);
    const ordered = rotateFrom(sorted, nextInRing(sorted, buttonSeat));
    return ordered.map((seat, index) => [
      seat,
      share + (index < remainder ? 1 : 0),
    ]);
  }

  function buildSidePots(players) {
    const contributions = {};
    for (const seat of seatKeys(players))
      contributions[seat] = players[seat].committedTotal;

    const pots = [];
    for (;;) {
      const participants = seatKeys(contributions).filter(
        (seat) => contributions[seat] > 0,
      );
      if (participants.length === 0) break;

      const step = participants.reduce(
        (min, seat) => Math.min(min, contributions[seat]),
        Infinity,
      );
      const amount = step * participants.length;
      const eligibleSeats = participants.filter(
        (seat) => !players[seat].folded,
      );
      for (const seat of participants) contributions[seat] -= step;
      pots.push({ amount, eligibleSeats });
    }
    return pots;
  }

  function nextStreetInfo(street) {
    switch (street) {
      case "preflop":
        return { street: "flop", count: 3 };
      case "flop":
        return { street: "turn", count: 1 };
      case "turn":
        return { street: "river", count: 1 };
      default:
        return { street: "river", count: 0 };
    }
  }

  function resetRoundState(players) {
    const out = clonePlayers(players);
    for (const seat of seatKeys(out)) {
      out[seat].committedRound = 0;
      out[seat].canRaise = canAct(out[seat]);
    }
    return out;
  }

  function activeSeats(table) {
    return seatKeys(table.seats).filter(
      (seat) =>
        table.seats[seat].status === "active" && table.seats[seat].stack > 0,
    );
  }

  function contenderSeats(players) {
    return seatKeys(players).filter((seat) => !players[seat].folded);
  }

  function actableSeats(players) {
    return seatKeys(players).filter((seat) => canAct(players[seat]));
  }

  function blindSeats(active, button) {
    if (active.length === 2) {
      // Heads-up: the button posts the small blind.
      return {
        smallBlindSeat: button,
        bigBlindSeat: nextInRing(active, button),
      };
    }
    const smallBlindSeat = nextInRing(active, button);
    return { smallBlindSeat, bigBlindSeat: nextInRing(active, smallBlindSeat) };
  }

  function preflopFirstActor(active, bigBlindSeat, players) {
    const first = nextInRing(active, bigBlindSeat);
    const queue = buildQueue(players, first);
    return queue.length ? queue[0] : null;
  }

  function postflopFirstActor(players, buttonSeat) {
    const seats = seatKeys(players);
    const rotated = rotateFrom(seats, nextInRing(seats, buttonSeat));
    return rotated.find((seat) => canAct(players[seat])) ?? null;
  }

  function buildQueue(players, firstSeat) {
    if (firstSeat == null) return [];
    const seats = seatKeys(players);
    return rotateFrom(seats, firstSeat).filter((seat) => canAct(players[seat]));
  }

  function postBlinds(players, sbSeat, sbAmount, bbSeat, bbAmount) {
    const out = clonePlayers(players);
    const sb = commitChips(out[sbSeat], sbAmount);
    out[sbSeat] = sb.player;
    const bb = commitChips(out[bbSeat], bbAmount);
    out[bbSeat] = bb.player;
    return {
      players: out,
      pot: sb.committed + bb.committed,
      sbPosted: sb.committed,
      bbPosted: bb.committed,
    };
  }

  function dealHoleCards(table, active, firstDealSeat, deck) {
    const players = {};
    for (const seat of active) {
      const seatPlayer = table.seats[seat];
      players[seat] = {
        seat,
        playerId: seatPlayer.playerId,
        stack: seatPlayer.stack,
        holeCards: [],
        committedRound: 0,
        committedTotal: 0,
        folded: false,
        allIn: false,
        canRaise: true,
      };
    }

    const dealOrder = rotateFrom(active, firstDealSeat);
    let remaining = deck;

    for (let round = 0; round < 2; round++) {
      for (const seat of dealOrder) {
        const dealt = Deck.deal(remaining, 1);
        if (!dealt.ok) return { ok: false, error: "not_enough_cards" };
        players[seat].holeCards.push(dealt.cards[0]);
        remaining = dealt.rest;
      }
    }

    return { ok: true, players, deck: remaining };
  }

  function resolveDeck(opts) {
    if (opts.deck == null) {
      return { ok: true, deck: Deck.shuffle(Deck.new(), { seed: opts.seed }) };
    }
    if (Array.isArray(opts.deck) && Deck.valid(opts.deck)) {
      return { ok: true, deck: opts.deck.slice() };
    }
    return { ok: false, error: "invalid_deck" };
  }

  /* ------------------------------------------------------------------ *
   * Export
   * ------------------------------------------------------------------ */

  const PokerEngine = { Card, Deck, HandRank, Table, STREETS };

  global.PokerEngine = PokerEngine;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PokerEngine;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
