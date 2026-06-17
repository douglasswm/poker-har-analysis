// parser.js — decodes the Stake Poker "front" protocol into a readable hand
// summary. Loaded in the isolated world before bridge.js, so it shares scope;
// it exposes window.PokerParser. Based on the protocol map in
// poker-har-analysis-report.md plus verified live frames.
(function () {
  "use strict";

  // Card ids 0..51: rank = floor(id/4), suit = id%4.
  const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const SUITS = ["♣", "♦", "♥", "♠"]; // 0=clubs 1=diamonds 2=hearts 3=spades

  function decodeCard(id) {
    id = parseInt(id, 10);
    if (isNaN(id) || id < 0 || id > 51) return null; // -1 = hidden
    return RANKS[Math.floor(id / 4)] + SUITS[id % 4];
  }

  function decodeCards(str) {
    if (!str) return [];
    return String(str)
      .split(";")
      .map(decodeCard)
      .filter(function (c) { return c !== null; });
  }

  // Last-action enum (la), mapped from chip-delta analysis of real frames.
  // Only clean labels are ever shown — never the raw number.
  const LAST_ACTION = {
    1: "fold",
    2: "check",
    3: "call",
    6: "post SB",
    7: "post BB",
    8: "bet/raise",
    9: "call",
    10: "showdown",   // at showdown / wins pot (result phase, m.r 5-6)
    11: "muck",       // showdown end, cards not shown
    13: "waiting",    // seated but waiting for the button to pass
    16: "return",     // uncalled-bet return / side-pot (result phase)
    25: "call",
    26: "timeout"
  };

  // Derive seat positions from the m (metadata) block + seat occupancy.
  // m.sb / m.bb are seat indices for the small/big blind. The button is not
  // always present (m.di); when absent we infer it as the occupied seat
  // immediately before the SB.
  function computePositions(seats, m) {
    const positions = {};
    if (!m) return positions;

    const occupied = seats
      .map(function (s, i) { return s ? i : -1; })
      .filter(function (i) { return i >= 0; });
    if (occupied.length === 0) return positions;

    const sb = m.sb;
    const bb = m.bb;
    if (sb != null) positions[sb] = "SB";
    if (bb != null) positions[bb] = "BB";

    // Button: explicit di if present, else seat before SB in occupied order.
    let btn = m.di;
    if (btn == null && sb != null) {
      const sbPos = occupied.indexOf(sb);
      if (sbPos >= 0) btn = occupied[(sbPos - 1 + occupied.length) % occupied.length];
    }
    if (btn != null) positions[btn] = "BTN";

    // Remaining seats clockwise after BB get UTG, UTG+1, ... up to CO.
    if (bb != null) {
      const order = ["UTG", "UTG+1", "MP", "HJ", "CO", "+5", "+6"];
      const start = occupied.indexOf(bb);
      let n = 0;
      for (let step = 1; step <= occupied.length; step++) {
        const seatIdx = occupied[(start + step) % occupied.length];
        if (positions[seatIdx]) continue; // already SB/BB/BTN
        if (n < order.length) positions[seatIdx] = order[n++];
      }
    }
    return positions;
  }

  // The hero's `dc` (hole cards) is only present in SOME frames of a hand, so
  // cache it per hand and reuse it when a later frame omits it.
  let cardCache = { handId: null, bySeat: {} };

  function dcToIds(dc) {
    return String(dc).split(";").map(function (x) { return parseInt(x, 10); })
      .filter(function (n) { return n >= 0 && n <= 51; });
  }

  function parseGameState(gs) {
    if (!gs || gs.gi == null) return null;
    if (cardCache.handId !== gs.gi) cardCache = { handId: gs.gi, bySeat: {} };
    const m = gs.m || {};
    const d = gs.d || {};
    const seatsRaw = gs.s || [];
    const positions = computePositions(seatsRaw, m);

    const STREET = { 1: "preflop", 2: "flop", 3: "turn", 4: "river" };

    const seats = [];
    for (let i = 0; i < seatsRaw.length; i++) {
      const s = seatsRaw[i];
      if (!s || !s.dn) continue; // empty / reserved
      // Resolve hole cards from this frame's dc, else from the per-hand cache.
      let cardIds = [];
      if (s.dc) {
        const ids = dcToIds(s.dc);
        if (ids.length === 2) { cardIds = ids; cardCache.bySeat[i] = ids; }
      }
      if (cardIds.length === 0 && cardCache.bySeat[i]) cardIds = cardCache.bySeat[i].slice();
      const heroCards = cardIds.length ? cardIds.map(decodeCard).join(" ") : "";
      seats.push({
        seat: i,
        position: positions[i] || "",
        name: s.dn,
        playerId: s.i,
        stack: s.c != null ? s.c : null,
        bet: s.b || 0,
        folded: s.s === 4,
        lastAction: LAST_ACTION[s.la] || "",
        cards: heroCards, // only the hero's own seat exposes real cards
        cardIds: cardIds  // numeric ids (cached per hand) for the solver
      });
    }

    return {
      tableId: gs.ti,
      handId: gs.gi,
      blinds: { sb: gs.sbv, bb: gs.bbv },
      street: STREET[m.r] || (gs.sfgs < 0 ? "pre-deal" : ""),
      board: decodeCards(d.c),
      pot: d.p != null ? d.p : null,
      heroHand: gs.ss && gs.ss.hc ? gs.ss.hc : "",
      seats: seats
    };
  }

  // Dealer chat messages carry hand lifecycle + winner info as text.
  function parseChat(msg) {
    const out = [];
    const list = msg.chatMessage || [];
    for (const c of list) {
      if (!c || !c.m) continue;
      out.push({ time: c.r, who: c.a, text: c.m.replace(/<[^>]+>/g, "") });
    }
    return out;
  }

  // --- Per-player action tracking across GameState frames ---------------
  const STREET_NAME = { 1: "preflop", 2: "flop", 3: "turn", 4: "river" };
  // tracker: detects each seat's actions by diffing consecutive states.
  let track = { handId: null, street: null, prev: {}, log: [], streetMaxBet: 0 };
  const warnedLa = new Set();

  function classify(curLa, curB, prevB, folded, prevFolded, streetMaxBet) {
    if (folded && !prevFolded) return { action: "fold", amount: 0 };
    switch (curLa) {
      case 1: return { action: "fold", amount: 0 };
      case 6: return { action: "post SB", amount: curB };
      case 7: return { action: "post BB", amount: curB };
      case 26: return { action: "timeout", amount: 0 };
      case 11: return null; // muck / showdown end — not a betting action
      case 13: return null; // waiting to enter — not a betting action
      case 10: return null; // showdown / win — result phase, not a bet
      case 16: return null; // uncalled-bet return / side-pot — not a bet
    }
    // Classify by chip movement vs the current max bet (more reliable than la):
    //   put in more than the max  -> raise (or bet if no prior bet)
    //   match the max             -> call
    //   no chips, turn passed     -> check
    if (curB > prevB) {
      if (streetMaxBet <= 0) return { action: "bet", amount: curB - prevB };
      if (curB > streetMaxBet) return { action: "raise", amount: curB - prevB };
      return { action: "call", amount: curB - prevB };
    }
    if (curB === prevB) {
      if (curLa === 9) return { action: "call", amount: 0 };
      return { action: "check", amount: 0 };
    }
    return null; // curB < prevB -> pot/bet reset or cleanup; ignore
  }

  function detectActions(gs) {
    const gi = gs.gi;
    const m = gs.m || {};
    const street = m.r;
    const seats = gs.s || [];

    if (gi !== track.handId) {
      track = { handId: gi, street: street, prev: {}, log: [], streetMaxBet: 0 };
    }
    if (street !== track.street) {
      // New betting round: reset per-seat bet baselines (don't log the reset).
      track.street = street;
      track.streetMaxBet = 0;
      for (const k in track.prev) track.prev[k].b = 0;
    }

    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      if (!s || !s.dn) continue;
      // Flag any last-action code we haven't mapped yet (straddle, ante,
      // all-in variants, etc.) once, with context, to help extend the map.
      if (s.la != null && !(s.la in LAST_ACTION) && !warnedLa.has(s.la)) {
        warnedLa.add(s.la);
        try {
          console.warn("[Tengan] Unmapped la code", s.la,
            "— seat", i, s.dn, "street", street, "bet", s.b, "state", s.s);
        } catch (e) { /* ignore */ }
      }
      const prev = track.prev[i] || { la: undefined, b: 0, folded: false, seen: false };
      const curB = s.b || 0;
      const curLa = s.la;
      const folded = s.s === 4;
      const changed = prev.seen && (curLa !== prev.la || curB !== prev.b || (folded && !prev.folded));

      const validStreet = street >= 1 && street <= 4;
      if (changed && validStreet) {
        const res = classify(curLa, curB, prev.b, folded, prev.folded, track.streetMaxBet);
        if (res && res.action) {
          const isAgg = res.action === "bet" || res.action === "raise" || res.action === "call";
          const negAgg = isAgg && res.amount < 0;            // uncalled-bet return, etc.
          const last = track.log[track.log.length - 1];
          const dupe = last && last.seat === i && last.action === res.action &&
            last.toAmount === curB && last.street === (STREET_NAME[street] || "");
          if (!negAgg && !dupe) {
            track.log.push({
              seat: i, name: s.dn,
              street: STREET_NAME[street] || "",
              action: res.action,
              amount: res.amount,
              toAmount: curB,
              la: curLa
            });
          }
        }
      }
      if (curB > track.streetMaxBet) track.streetMaxBet = curB;
      track.prev[i] = { la: curLa, b: curB, folded: folded, seen: true };
    }
  }

  // Called for every parsed front-socket frame. Returns an updated hand summary
  // (or null if the frame isn't a state update we track).
  let current = null;
  function update(json) {
    const t = json && (json.t || json.type);
    if (t === "GameState" && json.gameState) {
      detectActions(json.gameState);
      const parsed = parseGameState(json.gameState);
      if (parsed) {
        // attach position labels to the action log
        const posBySeat = {};
        for (const seat of parsed.seats) posBySeat[seat.seat] = seat.position;
        parsed.actions = track.log.map((a) => ({ ...a, position: posBySeat[a.seat] || "" }));
        // Make each seat's "last action" mirror the action feed (clean labels,
        // chip-derived) rather than the raw la code.
        const lastBySeat = {};
        for (const a of track.log) lastBySeat[a.seat] = a.action;
        for (const seat of parsed.seats) {
          if (lastBySeat[seat.seat]) seat.lastAction = lastBySeat[seat.seat];
        }
        current = parsed;
      }
      return current;
    }
    // Chat doesn't change the structured summary but is useful context; we
    // simply return the current summary so the panel stays in sync.
    return current;
  }

  function getActionLog() { return track.log; }

  window.PokerParser = {
    decodeCard: decodeCard,
    decodeCards: decodeCards,
    parseGameState: parseGameState,
    parseChat: parseChat,
    update: update,
    getActionLog: getActionLog,
    LAST_ACTION: LAST_ACTION
  };
})();
