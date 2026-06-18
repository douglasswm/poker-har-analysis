"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // engine/src/cards.ts
  var RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  var SUIT_GLYPH = ["\u2663", "\u2666", "\u2665", "\u2660"];
  function rankOf(id) {
    return Math.floor(id / 4);
  }
  function suitOf(id) {
    return id % 4;
  }
  function cardStr(id) {
    if (id < 0 || id > 51) return "??";
    return RANKS[rankOf(id)] + SUIT_GLYPH[suitOf(id)];
  }
  function parseCardList(s) {
    if (!s) return [];
    return String(s).split(";").map((x) => parseInt(x, 10)).filter((n) => n >= 0 && n <= 51);
  }
  function disjoint(a1, b1, a2, b2) {
    return a1 !== a2 && a1 !== b2 && b1 !== a2 && b1 !== b2;
  }

  // engine/src/spot.ts
  var STREET = { 1: "preflop", 2: "flop", 3: "turn", 4: "river" };
  function buildSpot(gs, positions, opts) {
    const empty = {
      ok: false,
      street: "pre-deal",
      heroCards: [],
      board: [],
      pot: 0,
      bb: 0,
      toCall: 0,
      effStack: 0,
      heroPosition: "",
      heroIsOOP: true,
      activePlayers: 0
    };
    if (!gs || gs.gi == null) return { ...empty, reason: "no gamestate" };
    const seats = gs.s || [];
    const m = gs.m || {};
    const d = gs.d || {};
    const board = parseCardList(d.c || "");
    const bb = gs.bbv || 2;
    const seatCards = (s) => s ? parseCardList(s.dc || s.d || "") : [];
    let heroSeat = -1, heroCards = [];
    if (opts && opts.heroSeat != null && seats[opts.heroSeat] && seats[opts.heroSeat].dn) {
      heroSeat = opts.heroSeat;
      heroCards = opts.heroCards && opts.heroCards.length === 2 ? opts.heroCards.slice() : seatCards(seats[heroSeat]);
    } else {
      for (let i = 0; i < seats.length; i++) {
        const ids = seatCards(seats[i]);
        if (ids.length === 2) {
          heroSeat = i;
          heroCards = ids;
          break;
        }
      }
      if (opts && opts.heroCards && opts.heroCards.length === 2) heroCards = opts.heroCards.slice();
    }
    let active = 0, minStack = Infinity, maxBet = 0, heroBet = 0;
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      if (!s || !s.dn) continue;
      const folded = s.s === 4;
      if (!folded) {
        active++;
        if (typeof s.c === "number") minStack = Math.min(minStack, s.c);
      }
      if (typeof s.b === "number" && !folded) maxBet = Math.max(maxBet, s.b);
      if (i === heroSeat && typeof s.b === "number") heroBet = s.b;
    }
    if (!isFinite(minStack)) minStack = 0;
    const byBoard = { 5: "river", 4: "turn", 3: "flop" };
    const street = STREET[m.r] || byBoard[board.length] || (gs.sfgs < 0 ? "pre-deal" : "preflop");
    const pot = typeof d.p === "number" ? d.p : 0;
    const toCall = Math.max(0, maxBet - heroBet);
    const pos = positions[heroSeat] || "";
    const heroIsOOP = pos !== "CO" && pos !== "BTN";
    return {
      ok: heroSeat >= 0,
      reason: heroSeat < 0 ? "hero not seated (spectating)" : void 0,
      tableId: gs.ti,
      handId: gs.gi,
      street,
      heroSeat,
      heroCards,
      board,
      pot,
      bb,
      toCall,
      effStack: minStack,
      heroPosition: pos,
      heroIsOOP,
      activePlayers: active
    };
  }

  // engine/src/gtomath.ts
  var gtomath_exports = {};
  __export(gtomath_exports, {
    alpha: () => alpha,
    bluffFraction: () => bluffFraction,
    callFracOfPot: () => callFracOfPot,
    mdf: () => mdf,
    potOddsEquity: () => potOddsEquity,
    spotMath: () => spotMath,
    spr: () => spr,
    valueToBluff: () => valueToBluff
  });
  function potOddsEquity(s) {
    return s / (1 + 2 * s);
  }
  function mdf(s) {
    return 1 / (1 + s);
  }
  function alpha(s) {
    return s / (1 + s);
  }
  function bluffFraction(s) {
    return s / (1 + 2 * s);
  }
  function valueToBluff(s) {
    const b = bluffFraction(s);
    return { value: 1 - b, bluff: b };
  }
  function spr(effStack, pot) {
    return pot > 0 ? effStack / pot : Infinity;
  }
  function callFracOfPot(toCall, potBeforeCall) {
    return potBeforeCall > 0 ? toCall / potBeforeCall : 0;
  }
  function spotMath(betFrac, effStack, pot) {
    return {
      potOddsPct: +(potOddsEquity(betFrac) * 100).toFixed(1),
      mdfPct: +(mdf(betFrac) * 100).toFixed(1),
      alphaPct: +(alpha(betFrac) * 100).toFixed(1),
      bluffPct: +(bluffFraction(betFrac) * 100).toFixed(1),
      spr: +spr(effStack, pot).toFixed(2)
    };
  }

  // engine/src/ranges.ts
  function handCode(c1, c2) {
    let r1 = rankOf(c1), r2 = rankOf(c2);
    const suited = suitOf(c1) === suitOf(c2);
    if (r1 < r2) {
      const t = r1;
      r1 = r2;
      r2 = t;
    }
    const hi = RANKS[r1], lo = RANKS[r2];
    if (r1 === r2) return hi + lo;
    return hi + lo + (suited ? "s" : "o");
  }
  function toChartPos(label) {
    switch (label) {
      case "SB":
        return "SB";
      case "BB":
        return "BB";
      case "BTN":
        return "BTN";
      case "CO":
        return "CO";
      case "HJ":
        return "HJ";
      case "LJ":
      case "MP":
        return "MP";
      case "UTG":
      case "UTG+1":
      case "UTG+2":
      case "UTG+3":
        return "UTG";
      default:
        return "MP";
    }
  }
  var PAIRS = ["22", "33", "44", "55", "66", "77", "88", "99", "TT", "JJ", "QQ", "KK", "AA"];
  var SUITED_ACES = ["A2s", "A3s", "A4s", "A5s", "A6s", "A7s", "A8s", "A9s", "ATs", "AJs", "AQs", "AKs"];
  var R_UTG = [
    ...PAIRS,
    ...SUITED_ACES,
    "AKo",
    "AQo",
    "AJo",
    "KQo",
    "KQs",
    "KJs",
    "KTs",
    "K9s",
    "QJs",
    "QTs",
    "Q9s",
    "JTs",
    "J9s",
    "T9s",
    "98s",
    "87s",
    "76s",
    "65s"
  ];
  var R_MP = [...R_UTG, "ATo", "KJo", "QJo", "KTo", "K8s", "Q8s", "J8s", "T8s", "97s", "86s", "54s"];
  var R_HJ = [...R_MP, "A9o", "A8o", "QTo", "JTo", "K7s", "K6s", "Q7s", "J7s", "T7s", "96s", "75s", "64s", "53s"];
  var R_CO = [
    ...R_HJ,
    "A7o",
    "A6o",
    "A5o",
    "A4o",
    "A3o",
    "A2o",
    "K9o",
    "Q9o",
    "J9o",
    "T9o",
    "98o",
    "K5s",
    "K4s",
    "K3s",
    "K2s",
    "Q6s",
    "Q5s",
    "Q4s",
    "J6s",
    "J5s",
    "T6s",
    "95s",
    "85s",
    "74s",
    "63s",
    "52s",
    "43s",
    "32s"
  ];
  var R_BTN = [
    ...R_CO,
    "K8o",
    "K7o",
    "K6o",
    "K5o",
    "K4o",
    "K3o",
    "K2o",
    "Q8o",
    "Q7o",
    "Q6o",
    "Q5o",
    "J8o",
    "J7o",
    "J6o",
    "T8o",
    "T7o",
    "97o",
    "87o",
    "86o",
    "76o",
    "75o",
    "65o",
    "64o",
    "54o",
    "53o",
    "43o",
    "J4s",
    "J3s",
    "J2s",
    "T5s",
    "T4s",
    "T3s",
    "T2s",
    "94s",
    "93s",
    "84s",
    "83s",
    "73s",
    "72s",
    "62s",
    "42s"
  ];
  var R_SB = [
    ...R_HJ,
    "A7o",
    "A6o",
    "A5o",
    "A4o",
    "A3o",
    "A2o",
    "K9o",
    "Q9o",
    "J9o",
    "T9o",
    "98o",
    "K5s",
    "K4s",
    "K3s",
    "K2s",
    "Q6s",
    "Q5s",
    "J6s",
    "T6s",
    "95s",
    "85s",
    "74s",
    "63s",
    "52s",
    "43s"
  ];
  var RFI = {
    UTG: R_UTG,
    MP: R_MP,
    HJ: R_HJ,
    CO: R_CO,
    BTN: R_BTN,
    SB: R_SB,
    BB: []
    // BB defends by calling/3-betting vs a raise, handled separately
  };
  var OPEN_ORDER = ["UTG", "MP", "HJ", "CO", "BTN"];
  function rangeAtShift(pos, shift) {
    if (pos === "BB") return [];
    if (pos === "SB") {
      if (shift <= -1) return R_HJ;
      if (shift >= 1) return R_BTN;
      return R_SB;
    }
    const i = OPEN_ORDER.indexOf(pos);
    if (i < 0) return RFI[pos] || [];
    const j = Math.max(0, Math.min(OPEN_ORDER.length - 1, i + shift));
    return RFI[OPEN_ORDER[j]];
  }
  var SHOVE_BB = 25;
  function sortOpts(opts) {
    return opts.filter((o) => o.freq > 1e-3).sort((a, b) => b.freq - a.freq);
  }
  var OPEN_BB = 2.5;
  var OPEN_SB_BB = 3;
  var THREEBET_BB = 9;
  function preflopAdvice(c1, c2, pos, facing, stackBB = 100) {
    const code = handCode(c1, c2);
    const core = rangeAtShift(pos, -1);
    const std = rangeAtShift(pos, 0);
    const ext = rangeAtShift(pos, 1);
    const playFreq = () => {
      if (core.includes(code)) return 1;
      if (std.includes(code)) return 0.66;
      if (ext.includes(code)) return 0.33;
      return 0;
    };
    const premium = ["AA", "KK", "QQ", "AKs", "AKo"].includes(code);
    const shortStack = stackBB <= SHOVE_BB;
    const bbRound = Math.round(stackBB);
    if (facing === "open") {
      if (pos === "BB") return { options: [{ action: "check", freq: 1 }], rationale: "BB \u2014 checked to you." };
      const f = playFreq();
      if (f <= 0) return { options: [{ action: "fold", freq: 1 }], rationale: `${code} is below the ${pos} opening range.` };
      if (shortStack) {
        const opts2 = [{ action: "allin", freq: f }];
        if (f < 1) opts2.push({ action: "fold", freq: 1 - f });
        return { options: sortOpts(opts2), rationale: `${bbRound}bb \u2014 open-shove range from ${pos}.` };
      }
      const sizeBB = pos === "SB" ? OPEN_SB_BB : OPEN_BB;
      const opts = [{ action: "raise", freq: f, sizeBB }];
      if (f < 1) opts.push({ action: "fold", freq: 1 - f });
      return { options: sortOpts(opts), rationale: f >= 1 ? `${code} opens from ${pos}.` : `${code} \u2014 borderline open from ${pos} (mix).` };
    }
    const latePos = pos === "BTN" || pos === "BB" || pos === "CO" || pos === "HJ";
    if (shortStack) {
      if (premium) return { options: [{ action: "allin", freq: 1 }], rationale: `${bbRound}bb \u2014 shove ${code} over the raise.` };
      if (core.includes(code)) return { options: [{ action: "allin", freq: 1 }], rationale: `${bbRound}bb \u2014 re-shove ${code}.` };
      if (std.includes(code)) return { options: sortOpts([{ action: "allin", freq: 0.5 }, { action: "fold", freq: 0.5 }]), rationale: `${bbRound}bb \u2014 ${code} is a marginal re-shove (mix).` };
      return { options: [{ action: "fold", freq: 1 }], rationale: `Fold ${code} at ${bbRound}bb vs a raise.` };
    }
    if (premium) return { options: [{ action: "raise", freq: 1, sizeBB: THREEBET_BB }], rationale: `${code} \u2014 3-bet for value.` };
    if (!latePos) return { options: [{ action: "fold", freq: 1 }], rationale: `${code} folds to the raise out of position.` };
    if (core.includes(code)) {
      return { options: [{ action: "call", freq: 1 }], rationale: `${code} \u2014 defend in ${pos}.` };
    }
    if (std.includes(code)) {
      return { options: sortOpts([{ action: "call", freq: 0.5 }, { action: "fold", freq: 0.5 }]), rationale: `${code} \u2014 marginal defend in ${pos} (mix).` };
    }
    return { options: [{ action: "fold", freq: 1 }], rationale: `${code} folds to the raise.` };
  }
  var GRID_RANKS = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  function preflopGrid(posLabel, facing, stackBB) {
    const pos = toChartPos(posLabel || "BTN");
    const cells = [];
    const tally = { allin: 0, raise: 0, call: 0, check: 0, fold: 0 };
    let totalCombos = 0;
    for (let r = 0; r < 13; r++) {
      for (let c = 0; c < 13; c++) {
        const hiRank = GRID_RANKS[Math.min(r, c)];
        const loRank = GRID_RANKS[Math.max(r, c)];
        const pair = r === c;
        const suited = c > r;
        let c1, c2, combos;
        if (pair) {
          c1 = hiRank * 4 + 0;
          c2 = hiRank * 4 + 1;
          combos = 6;
        } else if (suited) {
          c1 = hiRank * 4 + 0;
          c2 = loRank * 4 + 0;
          combos = 4;
        } else {
          c1 = hiRank * 4 + 0;
          c2 = loRank * 4 + 1;
          combos = 12;
        }
        const adv = preflopAdvice(c1, c2, pos, facing, stackBB);
        cells.push({ code: handCode(c1, c2), pair, suited, options: adv.options });
        for (const o of adv.options) tally[o.action] = (tally[o.action] || 0) + o.freq * combos;
        totalCombos += combos;
      }
    }
    const legend = {
      allin: +(tally.allin / totalCombos * 100).toFixed(2),
      raise: +(tally.raise / totalCombos * 100).toFixed(2),
      call: +(tally.call / totalCombos * 100).toFixed(2),
      check: +(tally.check / totalCombos * 100).toFixed(2),
      fold: +(tally.fold / totalCombos * 100).toFixed(2)
    };
    return { pos, facing, cells, legend };
  }
  function expandRange(codes, board) {
    const out = [];
    const boardSet = new Set(board);
    for (let a = 0; a < 52; a++) {
      if (boardSet.has(a)) continue;
      for (let b = a + 1; b < 52; b++) {
        if (boardSet.has(b)) continue;
        if (codes.includes(handCode(a, b))) out.push({ a, b, w: 1 });
      }
    }
    return out;
  }
  var GENERIC_CONTINUE = [
    ...RFI.BTN,
    "Q7s",
    "Q6s",
    "Q5s",
    "J7s",
    "T7s",
    "96s",
    "75s",
    "64s",
    "53s",
    "43s",
    "A8o",
    "A7o",
    "K9o",
    "K9s",
    "Q9o",
    "J9o",
    "98o",
    "T8o"
  ];

  // engine/src/evaluator.ts
  var CAT = {
    HIGH: 0,
    PAIR: 1,
    TWO_PAIR: 2,
    TRIPS: 3,
    STRAIGHT: 4,
    FLUSH: 5,
    FULL: 6,
    QUADS: 7,
    STRAIGHT_FLUSH: 8
  };
  function score5(ranks, suits) {
    const counts = new Array(13).fill(0);
    for (const r of ranks) counts[r]++;
    const isFlush = suits.every((s) => s === suits[0]);
    let mask = 0;
    for (const r of ranks) mask |= 1 << r;
    let straightHigh = -1;
    for (let hi = 12; hi >= 4; hi--) {
      const need = 1 << hi | 1 << hi - 1 | 1 << hi - 2 | 1 << hi - 3 | 1 << hi - 4;
      if ((mask & need) === need) {
        straightHigh = hi;
        break;
      }
    }
    if (straightHigh === -1) {
      const wheel = 1 << 12 | 1 << 0 | 1 << 1 | 1 << 2 | 1 << 3;
      if ((mask & wheel) === wheel) straightHigh = 3;
    }
    const order = [...Array(13).keys()].filter((r) => counts[r] > 0).sort((x, y) => counts[y] - counts[x] || y - x);
    const pack = (cat, tb) => {
      let v = cat;
      for (let i = 0; i < 5; i++) v = v * 16 + (tb[i] || 0);
      return v;
    };
    const countsSorted = order.map((r) => counts[r]);
    if (isFlush && straightHigh >= 0) return pack(CAT.STRAIGHT_FLUSH, [straightHigh]);
    if (countsSorted[0] === 4) return pack(CAT.QUADS, [order[0], order[1]]);
    if (countsSorted[0] === 3 && countsSorted[1] === 2) return pack(CAT.FULL, [order[0], order[1]]);
    if (isFlush) return pack(CAT.FLUSH, ranks.slice().sort((a, b) => b - a));
    if (straightHigh >= 0) return pack(CAT.STRAIGHT, [straightHigh]);
    if (countsSorted[0] === 3) return pack(CAT.TRIPS, [order[0], order[1], order[2]]);
    if (countsSorted[0] === 2 && countsSorted[1] === 2) return pack(CAT.TWO_PAIR, [order[0], order[1], order[2]]);
    if (countsSorted[0] === 2) return pack(CAT.PAIR, [order[0], order[1], order[2], order[3]]);
    return pack(CAT.HIGH, order.slice(0, 5));
  }
  var COMBOS5_OF_7 = (() => {
    const res = [];
    for (let a = 0; a < 7; a++)
      for (let b = a + 1; b < 7; b++)
        for (let c = b + 1; c < 7; c++)
          for (let d = c + 1; d < 7; d++)
            for (let e = d + 1; e < 7; e++) res.push([a, b, c, d, e]);
    return res;
  })();
  var CATEGORY_NAMES = [
    "High Card",
    "Pair",
    "Two Pair",
    "Three of a Kind",
    "Straight",
    "Flush",
    "Full House",
    "Four of a Kind",
    "Straight Flush"
  ];
  var _combosCache = {};
  function combos5(n) {
    const key = n + "c5";
    if (_combosCache[key]) return _combosCache[key];
    const res = [];
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++)
        for (let c = b + 1; c < n; c++)
          for (let d = c + 1; d < n; d++)
            for (let e = d + 1; e < n; e++) res.push([a, b, c, d, e]);
    _combosCache[key] = res;
    return res;
  }
  function bestScore(cards) {
    if (cards.length < 5) return -1;
    const ranks = cards.map(rankOf);
    const suits = cards.map(suitOf);
    let best = -1;
    for (const idx of combos5(cards.length)) {
      const v = score5(
        [ranks[idx[0]], ranks[idx[1]], ranks[idx[2]], ranks[idx[3]], ranks[idx[4]]],
        [suits[idx[0]], suits[idx[1]], suits[idx[2]], suits[idx[3]], suits[idx[4]]]
      );
      if (v > best) best = v;
    }
    return best;
  }
  function handCategory(cards) {
    if (!cards || cards.length < 5) return { cat: -1, name: "?" };
    const cat = Math.floor(bestScore(cards) / Math.pow(16, 5));
    return { cat, name: CATEGORY_NAMES[cat] };
  }
  function evaluate7(cards) {
    return evaluate7Best(cards);
  }
  function evaluate7Best(cards) {
    const ranks = cards.map(rankOf);
    const suits = cards.map(suitOf);
    let best = -1;
    for (const idx of COMBOS5_OF_7) {
      const v = score5(
        [ranks[idx[0]], ranks[idx[1]], ranks[idx[2]], ranks[idx[3]], ranks[idx[4]]],
        [suits[idx[0]], suits[idx[1]], suits[idx[2]], suits[idx[3]], suits[idx[4]]]
      );
      if (v > best) best = v;
    }
    return best;
  }

  // engine/src/cfr.ts
  var ALPHA = 1.5;
  var BETA = 0.5;
  var GAMMA = 2;
  var THETA = 0.9;
  var RiverSolver = class {
    constructor(spot, rootOpts) {
      this.spot = spot;
      this.rootActor = rootOpts ? rootOpts.actor : 0;
      const b = spot.board;
      this.rank0 = spot.oop.map((c) => evaluate7([c.a, c.b, ...b]));
      this.rank1 = spot.ip.map((c) => evaluate7([c.a, c.b, ...b]));
      this.w0 = spot.oop.map((c) => c.w);
      this.w1 = spot.ip.map((c) => c.w);
      let Z = 0;
      for (let i = 0; i < spot.oop.length; i++)
        for (let j = 0; j < spot.ip.length; j++)
          if (disjoint(spot.oop[i].a, spot.oop[i].b, spot.ip[j].a, spot.ip[j].b))
            Z += this.w0[i] * this.w1[j];
      this.Z = Z || 1e-9;
      this.root = rootOpts ? this.build(rootOpts.actor, rootOpts.cOOP, rootOpts.cIP, rootOpts.raises, rootOpts.prevCheck) : this.build(0, 0, 0, 0, false);
    }
    rangeSize(player) {
      return player === 0 ? this.spot.oop.length : this.spot.ip.length;
    }
    // Recursively build the betting tree. cOOP/cIP are chips put in so far.
    build(player, cOOP, cIP, raises, prevCheck) {
      const s = this.spot;
      const own = player === 0 ? cOOP : cIP;
      const opp = player === 0 ? cIP : cOOP;
      const toCall = Math.max(cOOP, cIP) - own;
      const remaining = s.effStack - own;
      const potNow = s.pot + cOOP + cIP;
      const edges = [];
      const other = player === 0 ? 1 : 0;
      if (remaining <= 0) {
        return { type: "showdown", cOOP, cIP };
      }
      if (toCall === 0) {
        if (prevCheck) {
          edges.push({ kind: "check", amount: 0, child: { type: "showdown", cOOP, cIP } });
        } else {
          edges.push({ kind: "check", amount: 0, child: this.build(other, cOOP, cIP, raises, true) });
        }
        const seen = /* @__PURE__ */ new Set();
        for (const bs of s.betSizes) {
          let amt = Math.min(Math.round(bs * potNow), remaining);
          if (amt <= 0 || seen.has(amt)) continue;
          seen.add(amt);
          const nc = player === 0 ? [cOOP + amt, cIP] : [cOOP, cIP + amt];
          edges.push({ kind: "bet", amount: amt, allin: amt === remaining, child: this.build(other, nc[0], nc[1], raises, false) });
        }
        if (s.allowAllIn && remaining > 0 && !seen.has(remaining)) {
          seen.add(remaining);
          const nc = player === 0 ? [cOOP + remaining, cIP] : [cOOP, cIP + remaining];
          edges.push({ kind: "bet", amount: remaining, allin: true, child: this.build(other, nc[0], nc[1], raises, false) });
        }
      } else {
        edges.push({ kind: "fold", amount: 0, child: { type: "fold", folder: player, cOOP, cIP } });
        const callAmt = Math.min(toCall, remaining);
        const ncCall = player === 0 ? [cOOP + callAmt, cIP] : [cOOP, cIP + callAmt];
        edges.push({ kind: "call", amount: callAmt, child: { type: "showdown", cOOP: ncCall[0], cIP: ncCall[1] } });
        if (raises < s.raiseCap && remaining > toCall) {
          const seen = /* @__PURE__ */ new Set();
          for (const rs of s.raiseSizes) {
            let add = toCall + Math.round(rs * (potNow + toCall));
            add = Math.min(add, remaining);
            if (add <= toCall || seen.has(add)) continue;
            seen.add(add);
            const nc = player === 0 ? [cOOP + add, cIP] : [cOOP, cIP + add];
            edges.push({ kind: "raise", amount: add, allin: add === remaining, child: this.build(other, nc[0], nc[1], raises + 1, false) });
          }
          if (s.allowAllIn && remaining > toCall && !seen.has(remaining)) {
            const nc = player === 0 ? [cOOP + remaining, cIP] : [cOOP, cIP + remaining];
            edges.push({ kind: "raise", amount: remaining, allin: true, child: this.build(other, nc[0], nc[1], raises + 1, false) });
          }
        }
      }
      const n = this.rangeSize(player);
      const a = edges.length;
      return {
        type: "action",
        player,
        n,
        a,
        edges,
        rPlus: new Float64Array(a * n),
        cum: new Float64Array(a * n)
      };
    }
    // Current strategy from positive regrets (regret matching). [a*n + i]
    strategy(node) {
      const { a, n, rPlus } = node;
      const out = new Float64Array(a * n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = 0; k < a; k++) {
          const v = rPlus[k * n + i];
          if (v > 0) sum += v;
        }
        if (sum > 0) {
          for (let k = 0; k < a; k++) {
            const v = rPlus[k * n + i];
            out[k * n + i] = v > 0 ? v / sum : 0;
          }
        } else {
          for (let k = 0; k < a; k++) out[k * n + i] = 1 / a;
        }
      }
      return out;
    }
    averageStrategy(node) {
      const { a, n, cum } = node;
      const out = new Float64Array(a * n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = 0; k < a; k++) sum += cum[k * n + i];
        if (sum > 0) for (let k = 0; k < a; k++) out[k * n + i] = cum[k * n + i] / sum;
        else for (let k = 0; k < a; k++) out[k * n + i] = 1 / a;
      }
      return out;
    }
    // --- Terminal utilities for `trav`, given opponent reach over opp combos. ---
    showdownUtil(trav, node, oppReach) {
      const travCombos = trav === 0 ? this.spot.oop : this.spot.ip;
      const oppCombos = trav === 0 ? this.spot.ip : this.spot.oop;
      const travRank = trav === 0 ? this.rank0 : this.rank1;
      const oppRank = trav === 0 ? this.rank1 : this.rank0;
      const cTrav = trav === 0 ? node.cOOP : node.cIP;
      const cOpp = trav === 0 ? node.cIP : node.cOOP;
      const winNet = this.spot.pot + cOpp;
      const loseNet = -cTrav;
      const tieNet = (this.spot.pot + cOpp - cTrav) / 2;
      const out = new Float64Array(travCombos.length);
      for (let i = 0; i < travCombos.length; i++) {
        const ti = travCombos[i];
        let u = 0;
        for (let j = 0; j < oppCombos.length; j++) {
          const r = oppReach[j];
          if (r === 0) continue;
          const oj = oppCombos[j];
          if (!disjoint(ti.a, ti.b, oj.a, oj.b)) continue;
          if (travRank[i] > oppRank[j]) u += r * winNet;
          else if (travRank[i] < oppRank[j]) u += r * loseNet;
          else u += r * tieNet;
        }
        out[i] = u;
      }
      return out;
    }
    foldUtil(trav, node, oppReach) {
      const travCombos = trav === 0 ? this.spot.oop : this.spot.ip;
      const oppCombos = trav === 0 ? this.spot.ip : this.spot.oop;
      const cTrav = trav === 0 ? node.cOOP : node.cIP;
      const cOpp = trav === 0 ? node.cIP : node.cOOP;
      const net = node.folder === trav ? -cTrav : this.spot.pot + cOpp;
      const out = new Float64Array(travCombos.length);
      for (let i = 0; i < travCombos.length; i++) {
        const ti = travCombos[i];
        let reach = 0;
        for (let j = 0; j < oppCombos.length; j++) {
          const r = oppReach[j];
          if (r === 0) continue;
          const oj = oppCombos[j];
          if (disjoint(ti.a, ti.b, oj.a, oj.b)) reach += r;
        }
        out[i] = net * reach;
      }
      return out;
    }
    // --- CFR traversal for `trav`. oppReach indexes the opponent's range. ---
    cfr(trav, node, oppReach, iter) {
      if (node.type === "showdown") return this.showdownUtil(trav, node, oppReach);
      if (node.type === "fold") return this.foldUtil(trav, node, oppReach);
      const { a, n, edges } = node;
      if (node.player === trav) {
        const strat = this.strategy(node);
        const childUtils = new Array(a);
        for (let k = 0; k < a; k++) childUtils[k] = this.cfr(trav, edges[k].child, oppReach, iter);
        const util = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          let u = 0;
          for (let k = 0; k < a; k++) u += strat[k * n + i] * childUtils[k][i];
          util[i] = u;
        }
        const alphaCoef = (() => {
          const x = Math.pow(iter, ALPHA);
          return x / (1 + x);
        })();
        for (let k = 0; k < a; k++) {
          for (let i = 0; i < n; i++) {
            const idx = k * n + i;
            const regret = childUtils[k][i] - util[i];
            let r = node.rPlus[idx] + regret;
            r *= r > 0 ? alphaCoef : BETA;
            node.rPlus[idx] = r;
          }
        }
        const stratNew = this.strategy(node);
        const sCoef = Math.pow(iter / (iter + 1), GAMMA);
        for (let idx = 0; idx < a * n; idx++) node.cum[idx] = node.cum[idx] * THETA + stratNew[idx] * sCoef;
        return util;
      } else {
        const strat = this.strategy(node);
        const travN = this.rangeSize(trav);
        const util = new Float64Array(travN);
        for (let k = 0; k < a; k++) {
          const newReach = new Float64Array(n);
          for (let j = 0; j < n; j++) newReach[j] = oppReach[j] * strat[k * n + j];
          const cu = this.cfr(trav, edges[k].child, newReach, iter);
          for (let i = 0; i < travN; i++) util[i] += cu[i];
        }
        return util;
      }
    }
    // --- Best response value for `trav` vs opponent AVERAGE strategy. ---
    br(trav, node, oppReach) {
      if (node.type === "showdown") return this.showdownUtil(trav, node, oppReach);
      if (node.type === "fold") return this.foldUtil(trav, node, oppReach);
      const { a, n, edges } = node;
      if (node.player === trav) {
        const childUtils = new Array(a);
        for (let k = 0; k < a; k++) childUtils[k] = this.br(trav, edges[k].child, oppReach);
        const travN = this.rangeSize(trav);
        const util = new Float64Array(travN);
        for (let i = 0; i < travN; i++) {
          let best = -Infinity;
          for (let k = 0; k < a; k++) if (childUtils[k][i] > best) best = childUtils[k][i];
          util[i] = best;
        }
        return util;
      } else {
        const avg = this.averageStrategy(node);
        const travN = this.rangeSize(trav);
        const util = new Float64Array(travN);
        for (let k = 0; k < a; k++) {
          const newReach = new Float64Array(n);
          for (let j = 0; j < n; j++) newReach[j] = oppReach[j] * avg[k * n + j];
          const cu = this.br(trav, edges[k].child, newReach);
          for (let i = 0; i < travN; i++) util[i] += cu[i];
        }
        return util;
      }
    }
    // Exploitability as a % of the starting pot (lower = closer to equilibrium).
    exploitability() {
      const br0 = this.br(0, this.root, Float64Array.from(this.w1));
      const br1 = this.br(1, this.root, Float64Array.from(this.w0));
      let v0 = 0, v1 = 0;
      for (let i = 0; i < this.w0.length; i++) v0 += this.w0[i] * br0[i];
      for (let i = 0; i < this.w1.length; i++) v1 += this.w1[i] * br1[i];
      const exploitChips = (v0 + v1) / this.Z - this.spot.pot;
      return exploitChips / this.spot.pot * 100;
    }
    solve(iterations) {
      for (let t = 1; t <= iterations; t++) {
        this.cfr(0, this.root, Float64Array.from(this.w1), t);
        this.cfr(1, this.root, Float64Array.from(this.w0), t);
      }
      return { exploitabilityPct: this.exploitability() };
    }
    // Average strategy at the root (the root actor's decision) for advice.
    rootStrategy() {
      const root = this.root;
      if (root.type !== "action") return { actions: [], perCombo: [] };
      const avg = this.averageStrategy(root);
      const actorRange = root.player === 0 ? this.spot.oop : this.spot.ip;
      const actions = root.edges.map((e) => ({ kind: e.kind, amount: e.amount, allin: e.allin }));
      const perCombo = actorRange.map((combo, i) => ({
        combo,
        freqs: root.edges.map((_, k) => avg[k * root.n + i])
      }));
      return { actions, perCombo };
    }
  };

  // engine/src/advisor.ts
  function hasStrongDraw(cards) {
    const suits = [0, 0, 0, 0];
    for (const c of cards) suits[suitOf(c)]++;
    if (suits.some((s) => s === 4)) return true;
    const rset = new Set(cards.map(rankOf));
    const ranks = [...rset];
    if (rset.has(12)) ranks.push(-1);
    ranks.sort((a, b) => a - b);
    let run = 1, best = 1;
    for (let i = 1; i < ranks.length; i++) {
      if (ranks[i] === ranks[i - 1] + 1) {
        run++;
        best = Math.max(best, run);
      } else if (ranks[i] !== ranks[i - 1]) run = 1;
    }
    return best >= 4;
  }
  function advise(spot, opts) {
    if (!spot.ok) {
      return { headline: "\u2014", source: "math", detail: spot.reason || "no spot" };
    }
    if (spot.heroCards.length !== 2) {
      return {
        headline: "Enter hole cards",
        source: "math",
        detail: `Seat ${spot.heroPosition || spot.heroSeat} has no visible cards \u2014 pick the two cards to get a recommendation.`
      };
    }
    const stackBB = spot.bb > 0 ? spot.effStack / spot.bb : 100;
    if (spot.street === "preflop") {
      const facing = spot.toCall > spot.bb ? "raise" : "open";
      const adv = preflopAdvice(spot.heroCards[0], spot.heroCards[1], toChartPos(spot.heroPosition || "BTN"), facing, stackBB);
      const actions = adv.options.map((o) => ({
        kind: o.action === "allin" ? "raise" : o.action,
        freq: o.freq,
        allin: o.action === "allin",
        sizeBB: o.action === "raise" ? o.sizeBB : void 0
      }));
      return {
        headline: "",
        source: "chart",
        detail: adv.rationale,
        bb: spot.bb,
        top: actions[0],
        actions,
        note: "Preflop chart."
      };
    }
    const betFrac = spot.toCall > 0 ? callFracOfPot(spot.toCall, spot.pot - spot.toCall || spot.pot) : 0.66;
    const math = spotMath(betFrac, spot.effStack, spot.pot);
    if (spot.street === "river" && spot.heroCards.length === 2) {
      try {
        const rec = solveRiver(spot, opts?.iterations ?? 400);
        return { ...rec, math };
      } catch (e) {
        return {
          headline: "math only",
          source: "math",
          detail: "River solve failed: " + (e?.message || e),
          math
        };
      }
    }
    return flopTurnAdvice(spot, math);
  }
  var POSTFLOP = {
    valueEq: 0.58,
    valueMedSize: 0.5,
    valueBigEq: 0.72,
    valueBigSize: 0.75,
    semibluffFreq: 0.66,
    bluffFreq: 0.3,
    bluffSize: 0.75,
    raiseEq: 0.7,
    raiseSize: 0.75,
    callBuffer: 0.05
  };
  function heroEquity(hero, board, villRange, samples) {
    const need = 5 - board.length;
    if (need < 0 || !villRange.length) return 0.5;
    const used = /* @__PURE__ */ new Set([...hero, ...board]);
    const deck = [];
    for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
    let win = 0, tie = 0, n = 0;
    for (let s = 0; s < samples; s++) {
      const vc = villRange[Math.random() * villRange.length | 0];
      if (used.has(vc.a) || used.has(vc.b)) continue;
      const run = [];
      let guard = 0;
      while (run.length < need && guard < 200) {
        const c = deck[Math.random() * deck.length | 0];
        if (c === vc.a || c === vc.b || run.indexOf(c) >= 0) {
          guard++;
          continue;
        }
        run.push(c);
      }
      if (run.length < need) continue;
      const hs = evaluate7([hero[0], hero[1], ...board, ...run]);
      const vs = evaluate7([vc.a, vc.b, ...board, ...run]);
      if (hs > vs) win++;
      else if (hs === vs) tie++;
      n++;
    }
    return n ? (win + tie * 0.5) / n : 0.5;
  }
  function flopTurnAdvice(spot, math) {
    const cfg = POSTFLOP;
    const all = [...spot.heroCards, ...spot.board];
    const draw = hasStrongDraw(all);
    const cat = handCategory(all).cat;
    const madeShowdown = cat >= 1;
    const pot = spot.pot;
    const bb = spot.bb;
    const villRange = expandRange(GENERIC_CONTINUE, [...spot.board, ...spot.heroCards]);
    const eq = heroEquity(spot.heroCards, spot.board, villRange, 1500);
    const eqPct = Math.round(eq * 100);
    const eff = spot.effStack;
    const cap = (a) => {
      if (eff > 0 && a.amount != null && a.amount >= eff) {
        a.amount = eff;
        a.allin = true;
      }
      return a;
    };
    const bet = (frac, freq = 1) => cap({ kind: "bet", freq, potFrac: frac, amount: Math.round(frac * pot) });
    const raiseTo = (frac) => {
      const potAfterCall = pot + spot.toCall;
      return cap({ kind: "raise", freq: 1, potFrac: frac, amount: spot.toCall + Math.round(frac * potAfterCall) });
    };
    const plain = (kind, freq = 1) => ({ kind, freq });
    const mix = (betFrac, betFreq) => {
      const b = bet(betFrac, betFreq);
      const c = plain("check", 1 - betFreq);
      return betFreq >= 0.5 ? { actions: [b, c], top: b } : { actions: [c, b], top: c };
    };
    let actions;
    let top;
    let detail;
    if (spot.toCall > 0) {
      const betFrac = callFracOfPot(spot.toCall, pot - spot.toCall || pot);
      const need = potOddsEquity(betFrac);
      const needPct = Math.round(need * 100);
      const band = 0.03;
      if (eq >= cfg.raiseEq) {
        top = raiseTo(cfg.raiseSize);
        actions = [top];
        detail = `~${eqPct}% equity \u2014 raise for value.`;
      } else if (eq >= need + band) {
        top = plain("call");
        actions = [top];
        detail = `~${eqPct}% vs ${needPct}% needed \u2014 call.`;
      } else if (eq >= need - band) {
        let callF = (eq - (need - band)) / (2 * band);
        callF = Math.max(0.05, Math.min(0.95, callF));
        const c = plain("call", callF);
        const f = plain("fold", 1 - callF);
        ({ actions, top } = callF >= 0.5 ? { actions: [c, f], top: c } : { actions: [f, c], top: f });
        detail = `~${eqPct}% \u2248 ${needPct}% needed \u2014 marginal, mix call/fold.`;
      } else if (draw && eq >= need - cfg.callBuffer) {
        top = plain("call");
        actions = [top];
        detail = `~${eqPct}% + draw \u2014 call.`;
      } else {
        top = plain("fold");
        actions = [top];
        detail = `~${eqPct}% < ${needPct}% needed \u2014 fold.`;
      }
    } else {
      if (eq >= cfg.valueBigEq) {
        top = bet(cfg.valueBigSize);
        actions = [top];
        detail = `~${eqPct}% equity \u2014 value bet (big).`;
      } else if (eq >= cfg.valueEq) {
        top = bet(cfg.valueMedSize);
        actions = [top];
        detail = `~${eqPct}% equity \u2014 value bet.`;
      } else if (draw && cfg.semibluffFreq > 0) {
        ({ actions, top } = mix(cfg.bluffSize, cfg.semibluffFreq));
        detail = `~${eqPct}% + draw \u2014 semi-bluff (mix).`;
      } else if (!madeShowdown && cfg.bluffFreq > 0) {
        ({ actions, top } = mix(cfg.bluffSize, cfg.bluffFreq));
        detail = `~${eqPct}% equity \u2014 bluff some, check some.`;
      } else {
        top = plain("check");
        actions = [top];
        detail = madeShowdown ? `~${eqPct}% equity \u2014 showdown value, check.` : `~${eqPct}% equity \u2014 check.`;
      }
    }
    return { headline: "", source: "equity", detail, bb, top, actions, math };
  }
  function solveRiver(spot, iterations) {
    const heroIsOOP = spot.heroIsOOP;
    const heroPlayer = heroIsOOP ? 0 : 1;
    const heroCombo = { a: spot.heroCards[0], b: spot.heroCards[1], w: 1 };
    const villainRange = expandRange(GENERIC_CONTINUE, [...spot.board, spot.heroCards[0], spot.heroCards[1]]);
    const potBeforeBet = spot.toCall > 0 ? Math.max(1, spot.pot - spot.toCall) : spot.pot;
    const rspot = {
      board: spot.board,
      pot: potBeforeBet,
      effStack: Math.max(1, spot.effStack),
      oop: heroIsOOP ? [heroCombo] : villainRange,
      ip: heroIsOOP ? villainRange : [heroCombo],
      betSizes: [0.5, 1],
      raiseSizes: [1],
      raiseCap: 1,
      allowAllIn: true
    };
    const rootOpts = spot.toCall > 0 ? {
      actor: heroPlayer,
      cOOP: heroIsOOP ? 0 : spot.toCall,
      cIP: heroIsOOP ? spot.toCall : 0,
      // Villain's bet is the opening bet (not a raise), so hero can still
      // raise/all-in over it.
      raises: 0,
      prevCheck: false
    } : { actor: heroPlayer, cOOP: 0, cIP: 0, raises: 0, prevCheck: false };
    const solver = new RiverSolver(rspot, rootOpts);
    const { exploitabilityPct } = solver.solve(iterations);
    const rs = solver.rootStrategy();
    const hero = rs.perCombo[0];
    const actions = rs.actions.map((act, k) => ({
      kind: act.kind,
      amount: act.amount,
      allin: act.allin,
      freq: hero ? hero.freqs[k] : 0
    }));
    actions.sort((a, b) => b.freq - a.freq);
    const top = actions[0];
    return {
      headline: "",
      source: "solver",
      detail: `Hero ${cardStr(spot.heroCards[0])}${cardStr(spot.heroCards[1])} on ${spot.board.map(cardStr).join(" ")} \u2014 DCFR over a generic villain range.`,
      actions,
      top,
      bb: spot.bb,
      exploitabilityPct: +exploitabilityPct.toFixed(2),
      note: "Villain range is a generic continuing range (no read). Single-street solve."
    };
  }

  // engine/src/index.ts
  var TenganEngine = {
    version: "0.1.0",
    buildSpot,
    advise,
    cardStr,
    handCategory,
    // {cat,name} for a 7-card hand (used for bluff classification)
    preflopGrid,
    // 13x13 strategy matrix for a position/facing/stack
    gtomath: gtomath_exports,
    // Convenience: from a raw GameState json + positions map -> recommendation.
    // opts may force a hero seat / supply hole cards, and set solve iterations.
    recommend(gs, positions, opts) {
      const spot = buildSpot(gs, positions, { heroSeat: opts?.heroSeat, heroCards: opts?.heroCards });
      return { spot, recommendation: advise(spot, { iterations: opts?.iterations }) };
    }
  };
  globalThis.TenganEngine = TenganEngine;
  var src_default = TenganEngine;
})();
