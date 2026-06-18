"use strict";

// engine/src/cards.ts
var RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
var SUIT_GLYPH = ["\u2663", "\u2666", "\u2665", "\u2660"];
function rankOf(id2) {
  return Math.floor(id2 / 4);
}
function suitOf(id2) {
  return id2 % 4;
}
function cardStr(id2) {
  if (id2 < 0 || id2 > 51) return "??";
  return RANKS[rankOf(id2)] + SUIT_GLYPH[suitOf(id2)];
}
function disjoint(a1, b1, a2, b2) {
  return a1 !== a2 && a1 !== b2 && b1 !== a2 && b1 !== b2;
}

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

// engine/src/gtomath.ts
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

// engine/src/cfr.ts
var ALPHA = 1.5;
var BETA = 0.5;
var GAMMA = 2;
var THETA = 0.9;
var RiverSolver = class {
  constructor(spot2, rootOpts) {
    this.spot = spot2;
    this.rootActor = rootOpts ? rootOpts.actor : 0;
    const b = spot2.board;
    this.rank0 = spot2.oop.map((c) => evaluate7([c.a, c.b, ...b]));
    this.rank1 = spot2.ip.map((c) => evaluate7([c.a, c.b, ...b]));
    this.w0 = spot2.oop.map((c) => c.w);
    this.w1 = spot2.ip.map((c) => c.w);
    let Z = 0;
    for (let i = 0; i < spot2.oop.length; i++)
      for (let j = 0; j < spot2.ip.length; j++)
        if (disjoint(spot2.oop[i].a, spot2.oop[i].b, spot2.ip[j].a, spot2.ip[j].b))
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
        for (const rs2 of s.raiseSizes) {
          let add = toCall + Math.round(rs2 * (potNow + toCall));
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

// engine/test/run.ts
var failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  \u2014 " + extra : ""}`);
  if (!cond) failures++;
}
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}
var id = (rank, suit) => rank * 4 + suit;
var royal = evaluate7([id(12, 3), id(11, 3), id(10, 3), id(9, 3), id(8, 3), id(0, 0), id(1, 1)]);
var pairAces = evaluate7([id(12, 0), id(12, 1), id(7, 2), id(5, 3), id(3, 0), id(1, 1), id(0, 2)]);
var twoPair = evaluate7([id(12, 0), id(12, 1), id(11, 2), id(11, 3), id(3, 0), id(1, 1), id(0, 2)]);
var flush = evaluate7([id(12, 3), id(9, 3), id(6, 3), id(4, 3), id(1, 3), id(0, 0), id(2, 1)]);
check("royal flush > two pair", royal > twoPair);
check("two pair > pair of aces", twoPair > pairAces);
check("flush > two pair", flush > twoPair);
check("flush < royal flush", flush < royal);
check("MDF pot-bet = 50%", approx(mdf(1), 0.5));
check("MDF half-pot = 66.7%", approx(mdf(0.5), 2 / 3));
check("pot-odds half-pot = 25%", approx(potOddsEquity(0.5), 0.25));
check("bluff frac pot-bet = 1/3", approx(bluffFraction(1), 1 / 3));
check("alpha pot-bet = 50%", approx(alpha(1), 0.5));
check("MDF + alpha = 1", approx(mdf(0.75) + alpha(0.75), 1));
var board = [id(11, 0), id(10, 1), id(5, 3), id(0, 2), id(7, 0)];
var oop = [
  { a: id(7, 1), b: id(7, 2), w: 1 },
  // 9d 9h -> trips
  { a: id(1, 3), b: id(2, 3), w: 1 }
  // 3s 4s -> air
];
var ip = [
  { a: id(3, 1), b: id(3, 2), w: 1 },
  // 5d 5h
  { a: id(4, 1), b: id(4, 2), w: 1 }
  // 6d 6h
];
var spot = {
  board,
  pot: 100,
  effStack: 100,
  oop,
  ip,
  betSizes: [1],
  raiseSizes: [],
  raiseCap: 0
};
var solver = new RiverSolver(spot);
var expl0 = solver.exploitability();
solver.solve(1500);
var expl1 = solver.exploitability();
console.log(`
Exploitability: ${expl0.toFixed(2)}% (start) -> ${expl1.toFixed(2)}% (after 1500 iters)`);
check("CFR exploitability converges < 3% of pot", expl1 < 3, `${expl1.toFixed(2)}%`);
check("CFR exploitability decreased", expl1 < expl0);
var rs = solver.rootStrategy();
console.log("\nRoot (OOP) average strategy:");
for (const pc of rs.perCombo) {
  const hand = cardStr(pc.combo.a) + cardStr(pc.combo.b);
  const parts = rs.actions.map((act, k) => {
    const lbl = act.kind === "check" ? "check" : `${act.kind}${act.amount}`;
    return `${lbl} ${(pc.freqs[k] * 100).toFixed(0)}%`;
  });
  console.log(`  ${hand}: ${parts.join("  ")}`);
}
var betIdx = rs.actions.findIndex((a) => a.kind === "bet");
if (betIdx >= 0) {
  const valueBet = rs.perCombo[0].freqs[betIdx];
  const airBet = rs.perCombo[1].freqs[betIdx];
  check("value hand bets more often than air", valueBet >= airBet, `value ${(valueBet * 100).toFixed(0)}% vs air ${(airBet * 100).toFixed(0)}%`);
  check("value hand bets frequently (>50%)", valueBet > 0.5, `${(valueBet * 100).toFixed(0)}%`);
}
console.log(`
${failures === 0 ? "ALL TESTS PASSED \u2705" : failures + " TEST(S) FAILED \u274C"}`);
process.exit(failures ? 1 : 0);
