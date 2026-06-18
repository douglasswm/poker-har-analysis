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
  // Positions are fixed for a hand, but the raw seat array / blind-button
  // metadata can drift frame-to-frame (sparse seats, players joining or sitting
  // out, a missing button index), which would re-derive different labels mid-hand
  // and flip the advice. So we compute once per hand and lock the result.
  let posCache = { handId: null, map: null };

  function computePositions(seats, m) {
    const positions = {};
    if (!m) return positions;

    // Count only actually-seated players (have a display name), not empty/
    // placeholder seats, so the position derivation is stable.
    const occupied = seats
      .map(function (s, i) { return (s && s.dn) ? i : -1; })
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

    // Remaining seats (between BB and BTN, in action order) get standard names.
    if (bb != null) {
      const seq = [];
      const start = occupied.indexOf(bb);
      for (let step = 1; step <= occupied.length; step++) {
        const seatIdx = occupied[(start + step) % occupied.length];
        if (positions[seatIdx]) continue; // already SB/BB/BTN
        seq.push(seatIdx);
      }
      const labels = positionLabels(seq.length);
      seq.forEach((idx, i) => { positions[idx] = labels[i] || ""; });
    }
    return positions;
  }

  // Standard poker names for the k seats between the BB and the button, in
  // action order (UTG first … CO last). UTG anchors the first seat; CO/HJ/LJ
  // anchor the button side; UTG+1/UTG+2 then MP fill the middle — no "+N".
  function positionLabels(k) {
    const res = new Array(k).fill(null);
    if (k >= 1) res[0] = "UTG";
    if (k >= 2) res[k - 1] = "CO";
    if (k >= 3) res[k - 2] = "HJ";
    if (k >= 4) res[k - 3] = "LJ";
    const mid = ["UTG+1", "UTG+2", "UTG+3"];
    let fi = 0;
    for (let i = 1; i < k; i++) if (!res[i]) res[i] = fi < mid.length ? mid[fi++] : "MP";
    return res;
  }

  // The hero's hole cards are only present in SOME frames of a hand, so cache
  // them per hand. Depending on the client build the local player's cards arrive
  // in `dc` (older) or `d` (newer, alongside a `wc` win-chance field); opponents'
  // `d` is masked as "-1;-1" (filtered out below).
  let cardCache = { handId: null, bySeat: {}, heroSeat: -1, heroScore: 0 };

  function dcToIds(dc) {
    return String(dc).split(";").map(function (x) { return parseInt(x, 10); })
      .filter(function (n) { return n >= 0 && n <= 51; });
  }

  function parseGameState(gs) {
    if (!gs || gs.gi == null) return null;
    if (cardCache.handId !== gs.gi) cardCache = { handId: gs.gi, bySeat: {}, heroSeat: -1, heroScore: 0 };
    const m = gs.m || {};
    const d = gs.d || {};
    const seatsRaw = gs.s || [];

    // Positions: reuse the locked map for this hand; otherwise compute and lock
    // it the moment we have a usable blinds picture (both SB and BB assigned).
    if (posCache.handId !== gs.gi) posCache = { handId: gs.gi, map: null };
    let positions;
    if (posCache.map) {
      positions = posCache.map;
    } else {
      positions = computePositions(seatsRaw, m);
      // Lock once the hand is live (cards dealt, m.r >= 1) and we have a full
      // blinds+button picture — this is the authoritative seating for the hand.
      const labels = Object.keys(positions).map(function (k) { return positions[k]; });
      const usable = labels.indexOf("SB") >= 0 && labels.indexOf("BB") >= 0 && labels.indexOf("BTN") >= 0;
      if (usable && m.r >= 1) posCache.map = positions;
    }

    const STREET = { 1: "preflop", 2: "flop", 3: "turn", 4: "river" };

    // Pass 1 — identify the local-player (hero) seat using only RELIABLE signals,
    // BEFORE building seats. A win-chance field (`wc`) and a `dc` that parses to
    // two real cards are local-player signals; a masked "-1;-1" dc or an
    // opponent's cards revealed in `d` at showdown are NOT, so they can't tag an
    // opponent as the hero. The strongest-signal seat wins, and the choice is
    // locked for the hand by score so later (e.g. showdown) frames can't flip it.
    let bestSeat = -1, bestScore = 0;
    for (let i = 0; i < seatsRaw.length; i++) {
      const s = seatsRaw[i];
      if (!s || !s.dn) continue;
      let score = 0;
      if (s.wc != null) score += 2;                 // win-chance = local player
      if (s.dc) { const ids = dcToIds(s.dc); if (ids.length === 2) score += 1; } // own dealt cards (valid)
      if (score > bestScore) { bestScore = score; bestSeat = i; }
    }
    if (bestSeat >= 0 && bestScore > cardCache.heroScore) {
      cardCache.heroSeat = bestSeat;
      cardCache.heroScore = bestScore;
    }

    // Pass 2 — build seats. Card display still reads dc OR d (so revealed cards
    // show), but isHero comes solely from the locked hero-seat above.
    const seats = [];
    for (let i = 0; i < seatsRaw.length; i++) {
      const s = seatsRaw[i];
      if (!s || !s.dn) continue; // empty / reserved
      let cardIds = [];
      const rawCards = s.dc || s.d;
      if (rawCards) {
        const ids = dcToIds(rawCards);
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
        folded: s.la === 1,
        lastAction: LAST_ACTION[s.la] || "",
        cards: heroCards,                  // hero's real cards (dc or d)
        cardIds: cardIds,                  // numeric ids (cached per hand)
        isHero: cardCache.heroSeat === i   // local-player seat (locked per hand)
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
      maxSeats: seatsRaw.length,
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
      // No chip delta in this frame's `b` (sparse capture / b reset). Fall back
      // to the la code: 3/9 = call, 8 = bet/raise, 2 = check.
      if (curLa === 3 || curLa === 9) return { action: "call", amount: 0 };
      if (curLa === 8) return { action: streetMaxBet > 0 ? "raise" : "bet", amount: 0 };
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
      // Folds are marked by la===1 (the seat-state `s` field is NOT a fold flag
      // — active players can have s===4).
      const folded = s.la === 1;
      const changed = prev.seen && (curLa !== prev.la || curB !== prev.b || (folded && !prev.folded));

      const validStreet = street >= 1 && street <= 4;
      if (changed && validStreet) {
        const res = classify(curLa, curB, prev.b, folded, prev.folded, track.streetMaxBet);
        if (res && res.action) {
          const isAgg = res.action === "bet" || res.action === "raise" || res.action === "call";
          const negAgg = isAgg && res.amount < 0;            // uncalled-bet return, etc.
          const last = track.log[track.log.length - 1];
          const streetName = STREET_NAME[street] || "";
          const dupe = last && last.seat === i && last.action === res.action &&
            last.toAmount === curB && last.street === streetName;
          // Can't check after committing chips this street (la-flicker noise).
          const spuriousCheck = res.action === "check" && track.log.some((x) =>
            x.seat === i && x.street === streetName &&
            (x.action === "call" || x.action === "bet" || x.action === "raise"));
          if (!negAgg && !dupe && !spuriousCheck) {
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

  // --- Winner/result + per-player statistics ----------------------------
  let pending = null;             // accumulator for the in-progress hand
  const playerStats = {};         // name -> aggregate counters
  const handHistory = {};         // name -> recent hands (newest first)
  const MAX_HISTORY = 40;

  function newHand(gi) {
    return { gi: gi, boardIds: [], shown: {}, winners: [], actions: [], seatNames: {}, finalized: false };
  }
  function emptyStat() {
    return { hands: 0, vpip: 0, pfr: 0, sawFlop: 0, wtsd: 0, won: 0,
             bets: 0, raises: 0, calls: 0, checks: 0, folds: 0,
             riverAggShown: 0, riverBluffs: 0 };
  }

  // Parse a dealer "wins" line. Handles:
  //   "Jotave9 wins (1.52) with Two Pair: Qs & 3s"
  //   "Elfenomeno9 wins (0.11): cards not shown."
  //   "Husse13 wins main pot(2.66) with Straight: A high"
  function parseWinLine(text) {
    const m = text.match(/^(.+?)\s+wins\b[^(]*\(([\d.]+)\)/i);
    if (!m) return null;
    const wm = text.match(/\bwith\s+(.+?)\.?\s*$/i);
    return { name: m[1].trim(), amount: parseFloat(m[2]),
             handType: wm ? wm[1].trim() : null, shown: !!wm };
  }

  function summarizeLines(acts) {
    const order = ["preflop", "flop", "turn", "river"];
    const byStreet = {};
    for (const a of acts) (byStreet[a.street] = byStreet[a.street] || []).push(a.action);
    return order.filter((s) => byStreet[s]).map((s) => ({ street: s, acts: byStreet[s] }));
  }

  function finalizeHand(h) {
    if (!h || h.finalized || !h.actions.length) return;
    h.finalized = true;
    const byPlayer = {};
    for (const a of h.actions) (byPlayer[a.name] = byPlayer[a.name] || []).push(a);
    const winnerNames = new Set(h.winners.map((w) => w.name));
    // river aggressor = last player to bet/raise on the river
    let riverAgg = null;
    for (const a of h.actions) {
      if (a.street === "river" && (a.action === "bet" || a.action === "raise")) riverAgg = a.name;
    }
    const HC = (window.TenganEngine && window.TenganEngine.handCategory) || null;

    for (const name of Object.keys(byPlayer)) {
      const acts = byPlayer[name];
      const st = (playerStats[name] = playerStats[name] || emptyStat());
      st.hands++;
      const pf = acts.filter((a) => a.street === "preflop");
      const vol = pf.some((a) => a.action === "call" || a.action === "bet" || a.action === "raise");
      const pfr = pf.some((a) => a.action === "bet" || a.action === "raise");
      const foldedPre = pf.some((a) => a.action === "fold");
      if (vol) st.vpip++;
      if (pfr) st.pfr++;
      const sawFlop = acts.some((a) => a.street !== "preflop") || (vol && !foldedPre);
      if (sawFlop) st.sawFlop++;
      for (const a of acts) {
        if (a.action === "bet") st.bets++;
        else if (a.action === "raise") st.raises++;
        else if (a.action === "call") st.calls++;
        else if (a.action === "check") st.checks++;
        else if (a.action === "fold") st.folds++;
      }
      const shown = h.shown[name];
      if (shown) st.wtsd++;
      if (winnerNames.has(name)) st.won++;
      // River bluff: was the last river aggressor AND showed no-pair at showdown.
      if (riverAgg === name && shown && h.boardIds.length === 5 && HC) {
        st.riverAggShown++;
        const cat = HC(shown.concat(h.boardIds)).cat;
        if (cat === 0) st.riverBluffs++;
      }
      const hist = (handHistory[name] = handHistory[name] || []);
      const w = h.winners.find((x) => x.name === name);
      hist.unshift({
        gi: h.gi,
        lines: summarizeLines(acts),
        shown: shown ? shown.map(decodeCard).join(" ") : "",
        result: winnerNames.has(name) ? "won" : (foldedPre ? "folded pre" : (shown ? "lost sd" : "folded")),
        handType: w ? w.handType : null,
        amount: w ? w.amount : null
      });
      if (hist.length > MAX_HISTORY) hist.pop();
    }
  }

  function getPlayerStats() {
    const rows = [];
    for (const name of Object.keys(playerStats)) {
      const s = playerStats[name];
      const aggr = s.bets + s.raises;
      const af = s.calls > 0 ? aggr / s.calls : (aggr > 0 ? Infinity : 0);
      rows.push({
        name: name,
        hands: s.hands,
        vpip: s.hands ? Math.round((100 * s.vpip) / s.hands) : 0,
        pfr: s.hands ? Math.round((100 * s.pfr) / s.hands) : 0,
        af: af === Infinity ? Infinity : Math.round(af * 10) / 10,
        wtsd: s.sawFlop ? Math.round((100 * s.wtsd) / s.sawFlop) : 0,
        bluff: s.riverAggShown ? Math.round((100 * s.riverBluffs) / s.riverAggShown) : null,
        bluffN: s.riverAggShown,
        won: s.won
      });
    }
    rows.sort((a, b) => b.hands - a.hands);
    return rows;
  }
  function getPlayerHistory(name) { return handHistory[name] || []; }

  // Wipe all accumulated player stats + hand history (in place; keeps refs).
  function resetStats() {
    for (const k in playerStats) delete playerStats[k];
    for (const k in handHistory) delete handHistory[k];
    pending = null;
  }

  // Called for every parsed front-socket frame. Returns an updated hand summary
  // (or null if the frame isn't a state update we track).
  let current = null;
  function update(json) {
    const t = json && (json.t || json.type);

    if (t === "GameState" && json.gameState) {
      const gs = json.gameState;
      // Finalize the previous hand into stats when a new one starts.
      if (pending && pending.gi !== gs.gi) { finalizeHand(pending); pending = null; }
      if (!pending) pending = newHand(gs.gi);

      detectActions(gs);
      const parsed = parseGameState(gs);
      if (parsed) {
        const posBySeat = {};
        for (const seat of parsed.seats) posBySeat[seat.seat] = seat.position;
        const nameBySeat = {};
        for (const seat of parsed.seats) nameBySeat[seat.seat] = seat.name;
        parsed.actions = track.log.map((a) => ({
          ...a, position: posBySeat[a.seat] || "", name: nameBySeat[a.seat] || a.name
        }));
        const lastBySeat = {};
        for (const a of track.log) lastBySeat[a.seat] = a.action;
        for (const seat of parsed.seats) {
          if (lastBySeat[seat.seat]) seat.lastAction = lastBySeat[seat.seat];
        }

        // Accumulate this hand's data.
        pending.actions = parsed.actions.slice();
        if (gs.d && gs.d.c) pending.boardIds = dcToIds(gs.d.c);
        const mr = gs.m && gs.m.r;
        if (mr >= 5) {
          for (const s of (gs.s || [])) {
            if (s && s.dn) {
              const ids = dcToIds(s.dc || s.d || "");
              if (ids.length === 2) pending.shown[s.dn] = ids;
            }
          }
        }
        // Attach winner/result + shown cards for display.
        parsed.result = pending.winners.length ? { winners: pending.winners.slice() } : null;
        parsed.shownHands = Object.keys(pending.shown).map((n) => ({
          name: n, cards: pending.shown[n].map(decodeCard).join(" ")
        }));
        current = parsed;
      }
      return current;
    }

    if (t === "Chat" && json.chatMessage) {
      for (const c of json.chatMessage) {
        if (!c || !c.m || c.a !== "Dealer") continue;
        const text = c.m.replace(/<[^>]+>/g, "");
        const w = parseWinLine(text);
        if (w && pending) pending.winners.push(w);
      }
      if (current && pending) current.result = pending.winners.length ? { winners: pending.winners.slice() } : null;
      return current;
    }
    return current;
  }

  function getActionLog() { return track.log; }

  window.PokerParser = {
    decodeCard: decodeCard,
    decodeCards: decodeCards,
    parseGameState: parseGameState,
    parseChat: parseChat,
    parseWinLine: parseWinLine,
    update: update,
    getActionLog: getActionLog,
    getPlayerStats: getPlayerStats,
    getPlayerHistory: getPlayerHistory,
    resetStats: resetStats,
    LAST_ACTION: LAST_ACTION
  };
})();
