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
    let heroSeat = -1, heroCards = [];
    if (opts && opts.heroSeat != null && seats[opts.heroSeat] && seats[opts.heroSeat].dn) {
      heroSeat = opts.heroSeat;
      const s = seats[heroSeat];
      heroCards = opts.heroCards && opts.heroCards.length === 2 ? opts.heroCards.slice() : s.dc ? parseCardList(s.dc) : [];
    } else {
      for (let i = 0; i < seats.length; i++) {
        const s = seats[i];
        if (s && s.dc) {
          heroSeat = i;
          heroCards = parseCardList(s.dc);
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
    const earlyPost = ["SB", "BB", "UTG", "UTG+1", "MP", "HJ"];
    const heroIsOOP = earlyPost.includes(pos);
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
  var RFI = {
    UTG: ["AA", "KK", "QQ", "JJ", "TT", "99", "88", "77", "AKs", "AQs", "AJs", "ATs", "KQs", "KJs", "QJs", "JTs", "AKo", "AQo"],
    MP: ["AA", "KK", "QQ", "JJ", "TT", "99", "88", "77", "66", "55", "AKs", "AQs", "AJs", "ATs", "A9s", "KQs", "KJs", "KTs", "QJs", "QTs", "JTs", "T9s", "98s", "AKo", "AQo", "AJo", "KQo"],
    CO: ["AA", "KK", "QQ", "JJ", "TT", "99", "88", "77", "66", "55", "44", "33", "22", "AKs", "AQs", "AJs", "ATs", "A9s", "A8s", "A7s", "A6s", "A5s", "A4s", "A3s", "A2s", "KQs", "KJs", "KTs", "K9s", "QJs", "QTs", "Q9s", "JTs", "J9s", "T9s", "98s", "87s", "76s", "65s", "AKo", "AQo", "AJo", "ATo", "KQo", "KJo", "QJo"],
    BTN: ["AA", "KK", "QQ", "JJ", "TT", "99", "88", "77", "66", "55", "44", "33", "22", "AKs", "AQs", "AJs", "ATs", "A9s", "A8s", "A7s", "A6s", "A5s", "A4s", "A3s", "A2s", "KQs", "KJs", "KTs", "K9s", "K8s", "K7s", "K6s", "K5s", "QJs", "QTs", "Q9s", "Q8s", "JTs", "J9s", "J8s", "T9s", "T8s", "98s", "97s", "87s", "86s", "76s", "65s", "54s", "AKo", "AQo", "AJo", "ATo", "A9o", "KQo", "KJo", "KTo", "QJo", "QTo", "JTo", "T9o"],
    SB: ["AA", "KK", "QQ", "JJ", "TT", "99", "88", "77", "66", "55", "44", "33", "22", "AKs", "AQs", "AJs", "ATs", "A9s", "A8s", "A7s", "A6s", "A5s", "A4s", "A3s", "A2s", "KQs", "KJs", "KTs", "K9s", "QJs", "QTs", "Q9s", "JTs", "J9s", "T9s", "98s", "87s", "76s", "65s", "AKo", "AQo", "AJo", "ATo", "KQo", "KJo", "QJo"],
    BB: []
    // BB defends by calling/3-betting vs a raise, handled separately
  };
  function preflopAdvice(c1, c2, pos, facing, stackBB = 100) {
    const code = handCode(c1, c2);
    const inRange = (RFI[pos] || []).includes(code);
    if (stackBB <= 20) {
      const premium = ["AA", "KK", "QQ", "JJ", "AKs", "AKo", "AQs"].includes(code);
      if (facing === "raise") {
        if (premium) return { action: "raise", rationale: `Short (${Math.round(stackBB)}bb): shove (all-in) ${code} over the raise.` };
        return { action: "fold", rationale: `${code} folds to a raise at ${Math.round(stackBB)}bb.` };
      }
      if (pos === "BB" && facing === "unopened") return { action: "check", rationale: "BB option." };
      if (inRange || premium) return { action: "raise", rationale: `Short (${Math.round(stackBB)}bb): open-shove (all-in) ${code}.` };
      return { action: "fold", rationale: `${code} below the ${pos} shoving range at ${Math.round(stackBB)}bb.` };
    }
    if (facing === "unopened") {
      if (pos === "BB") return { action: "check", rationale: "BB, folded to you \u2014 check your option." };
      if (inRange) return { action: "raise", sizeBB: pos === "SB" ? 3 : 2.5, rationale: `${code} is in the ${pos} RFI range.` };
      return { action: "fold", rationale: `${code} is below the ${pos} opening range.` };
    }
    if (facing === "raise") {
      const premium = ["AA", "KK", "QQ", "AKs", "AKo"].includes(code);
      const strong = RFI.CO.includes(code);
      if (premium) return { action: "raise", sizeBB: 9, rationale: `${code} is a premium 3-bet for value.` };
      if (strong && (pos === "BTN" || pos === "BB" || pos === "CO")) return { action: "call", rationale: `${code} is a reasonable call/defend in ${pos}.` };
      return { action: "fold", rationale: `${code} folds to a raise from ${pos}.` };
    }
    if (inRange) return { action: "raise", sizeBB: 4, rationale: `Iso-raise ${code} over the limp.` };
    return { action: "fold", rationale: `${code} folds over a limp from ${pos}.` };
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
  function evaluate7(cards) {
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
      const facing = spot.toCall > spot.bb ? "raise" : spot.toCall > 0 ? "limp" : "unopened";
      const adv = preflopAdvice(spot.heroCards[0], spot.heroCards[1], spot.heroPosition || "BTN", facing, stackBB);
      const shove = stackBB <= 20 && adv.action === "raise";
      const size = adv.sizeBB ? ` ${adv.sizeBB}bb` : "";
      return {
        headline: shove ? "ALL-IN" : `${adv.action.toUpperCase()}${size}`,
        source: "chart",
        detail: adv.rationale,
        note: "Preflop chart (6-max default ranges)."
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
    const facingBet = spot.toCall > 0;
    return {
      headline: facingBet ? `Defend \u2265 ${math.mdfPct}% of range; need ${math.potOddsPct}% equity to call` : `Bet sizing reference; SPR ${math.spr}`,
      source: "math",
      detail: facingBet ? `Facing ~${(betFrac * 100).toFixed(0)}% pot. MDF ${math.mdfPct}%, pot odds ${math.potOddsPct}%.` : `Polarize big / merge small. Optimal bluff share at this size \u2248 ${math.bluffPct}%.`,
      math,
      note: "Flop/turn live solving is out of scope (too slow); GTO math shown instead."
    };
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
      label: labelFor(act, spot.pot),
      freq: hero ? hero.freqs[k] : 0
    }));
    actions.sort((a, b) => b.freq - a.freq);
    const top = actions[0];
    return {
      headline: top ? `${top.label.toUpperCase()} (${(top.freq * 100).toFixed(0)}%)` : "\u2014",
      source: "solver",
      detail: `Hero ${cardStr(spot.heroCards[0])}${cardStr(spot.heroCards[1])} on ${spot.board.map(cardStr).join(" ")} \u2014 DCFR over a generic villain range.`,
      actions,
      exploitabilityPct: +exploitabilityPct.toFixed(2),
      note: "Villain range is a generic continuing range (no read). Single-street solve."
    };
  }
  function labelFor(act, pot) {
    if (act.kind === "check") return "check";
    if (act.kind === "fold") return "fold";
    if (act.kind === "call") return "call";
    if (act.allin) return act.kind === "raise" ? "raise all-in" : "all-in";
    const frac = pot > 0 ? act.amount / pot : 0;
    return `${act.kind} ${frac.toFixed(2)}x pot`;
  }

  // engine/src/index.ts
  var TenganEngine = {
    version: "0.1.0",
    buildSpot,
    advise,
    cardStr,
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
