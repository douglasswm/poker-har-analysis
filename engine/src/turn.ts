// Two-street (turn + river) Discounted-CFR solver — extends the river solver
// with a chance node that deals every river card and a full river betting
// subtree per card, all trained jointly with vector-form CFR. This is a *true*
// range-vs-range solve of the turn decision (not an equity rollout): the river
// is solved, not approximated.
//
// Cost scales with (turn nodes) × (~46 river cards) × (river nodes) ×
// |oop| × |ip| × iterations, so keep ranges modest for live use.
import { Combo, disjoint } from "./cards.js";
import { evaluate7 } from "./evaluator.js";

const ALPHA = 1.5, BETA = 0.5, GAMMA = 2, THETA = 0.9;

export interface TurnSpot {
  board: number[];          // 4 turn cards
  pot: number;
  effStack: number;
  oop: Combo[];
  ip: Combo[];
  turnBetSizes: number[];   // fraction of pot
  riverBetSizes: number[];
  raiseCap: number;
  allowAllIn?: boolean;
}

type ActionKind = "check" | "bet" | "call" | "fold" | "raise";
interface ActionEdge { kind: ActionKind; amount: number; child: TNode; allin?: boolean; }
interface ActionNode { type: "action"; player: 0 | 1; n: number; a: number; edges: ActionEdge[]; rPlus: Float64Array; cum: Float64Array; }
interface ChanceNode { type: "chance"; kids: { r: number; root: TNode }[]; }
interface ShowdownNode { type: "showdown"; cOOP: number; cIP: number; r: number; }   // r = river card index
interface FoldNode { type: "fold"; folder: 0 | 1; cOOP: number; cIP: number; }
type TNode = ActionNode | ChanceNode | ShowdownNode | FoldNode;

export class TurnSolver {
  spot: TurnSpot;
  root: TNode;
  rootActor: 0 | 1;
  w0: number[]; w1: number[]; Z: number;
  // river-dependent ranks: rankR[player] is a Map from river card -> ranks[]
  rankR0 = new Map<number, number[]>();
  rankR1 = new Map<number, number[]>();
  rivers: number[] = [];
  rPerMatch = 44;   // rivers valid for a given hero-vs-villain matchup (52 - 4 board - 2 - 2)

  constructor(spot: TurnSpot, rootOpts?: { actor: 0 | 1; cOOP: number; cIP: number; raises: number; prevCheck: boolean }) {
    this.spot = spot;
    this.rootActor = rootOpts ? rootOpts.actor : 0;
    this.w0 = spot.oop.map((c) => c.w);
    this.w1 = spot.ip.map((c) => c.w);
    let Z = 0;
    for (let i = 0; i < spot.oop.length; i++)
      for (let j = 0; j < spot.ip.length; j++)
        if (disjoint(spot.oop[i].a, spot.oop[i].b, spot.ip[j].a, spot.ip[j].b)) Z += this.w0[i] * this.w1[j];
    this.Z = Z || 1e-9;

    // viable river cards = all not on the turn board; precompute ranks per card.
    const onBoard = new Set(spot.board);
    for (let r = 0; r < 52; r++) {
      if (onBoard.has(r)) continue;
      this.rivers.push(r);
      const b5 = [...spot.board, r];
      this.rankR0.set(r, spot.oop.map((c) => (c.a === r || c.b === r) ? -1 : evaluate7([c.a, c.b, ...b5])));
      this.rankR1.set(r, spot.ip.map((c) => (c.a === r || c.b === r) ? -1 : evaluate7([c.a, c.b, ...b5])));
    }

    this.rPerMatch = 52 - spot.board.length - 4;
    const o = rootOpts || { actor: 0 as 0 | 1, cOOP: 0, cIP: 0, raises: 0, prevCheck: false };
    this.root = this.buildTurn(o.actor, o.cOOP, o.cIP, o.raises, o.prevCheck);
  }

  private rangeSize(p: 0 | 1) { return p === 0 ? this.spot.oop.length : this.spot.ip.length; }

  // ---- Turn betting tree: street-end -> chance(river) ----
  private buildTurn(player: 0 | 1, cOOP: number, cIP: number, raises: number, prevCheck: boolean): TNode {
    const s = this.spot;
    const own = player === 0 ? cOOP : cIP;
    const toCall = Math.max(cOOP, cIP) - own;
    const remaining = s.effStack - own;
    const potNow = s.pot + cOOP + cIP;
    const other: 0 | 1 = player === 0 ? 1 : 0;
    const edges: ActionEdge[] = [];
    if (remaining <= 0) return this.buildChance(cOOP, cIP);

    if (toCall === 0) {
      if (prevCheck) edges.push({ kind: "check", amount: 0, child: this.buildChance(cOOP, cIP) });
      else edges.push({ kind: "check", amount: 0, child: this.buildTurn(other, cOOP, cIP, raises, true) });
      const seen = new Set<number>();
      for (const bs of s.turnBetSizes) {
        const amt = Math.min(Math.round(bs * potNow), remaining);
        if (amt <= 0 || seen.has(amt)) continue; seen.add(amt);
        const nc = player === 0 ? [cOOP + amt, cIP] : [cOOP, cIP + amt];
        edges.push({ kind: "bet", amount: amt, allin: amt === remaining, child: this.buildTurn(other, nc[0], nc[1], raises, false) });
      }
      if (s.allowAllIn && remaining > 0 && !seen.has(remaining)) {
        const nc = player === 0 ? [cOOP + remaining, cIP] : [cOOP, cIP + remaining];
        edges.push({ kind: "bet", amount: remaining, allin: true, child: this.buildTurn(other, nc[0], nc[1], raises, false) });
      }
    } else {
      edges.push({ kind: "fold", amount: 0, child: { type: "fold", folder: player, cOOP, cIP } });
      const callAmt = Math.min(toCall, remaining);
      const ncCall = player === 0 ? [cOOP + callAmt, cIP] : [cOOP, cIP + callAmt];
      edges.push({ kind: "call", amount: callAmt, child: this.buildChance(ncCall[0], ncCall[1]) });
      if (raises < s.raiseCap && remaining > toCall) {
        const seen = new Set<number>();
        if (s.allowAllIn && !seen.has(remaining)) {
          const nc = player === 0 ? [cOOP + remaining, cIP] : [cOOP, cIP + remaining];
          edges.push({ kind: "raise", amount: remaining, allin: true, child: this.buildTurn(other, nc[0], nc[1], raises + 1, false) });
        }
      }
    }
    const n = this.rangeSize(player), a = edges.length;
    return { type: "action", player, n, a, edges, rPlus: new Float64Array(a * n), cum: new Float64Array(a * n) };
  }

  private buildChance(cOOP: number, cIP: number): ChanceNode {
    const kids = this.rivers.map((r) => ({ r, root: this.buildRiver(r, 0, cOOP, cIP, 0, false) }));
    return { type: "chance", kids };
  }

  // ---- River betting subtree for a fixed river card r ----
  private buildRiver(r: number, player: 0 | 1, cOOP: number, cIP: number, raises: number, prevCheck: boolean): TNode {
    const s = this.spot;
    const own = player === 0 ? cOOP : cIP;
    const toCall = Math.max(cOOP, cIP) - own;
    const remaining = s.effStack - own;
    const potNow = s.pot + cOOP + cIP;
    const other: 0 | 1 = player === 0 ? 1 : 0;
    const edges: ActionEdge[] = [];
    if (remaining <= 0) return { type: "showdown", cOOP, cIP, r };

    if (toCall === 0) {
      if (prevCheck) edges.push({ kind: "check", amount: 0, child: { type: "showdown", cOOP, cIP, r } });
      else edges.push({ kind: "check", amount: 0, child: this.buildRiver(r, other, cOOP, cIP, raises, true) });
      const seen = new Set<number>();
      for (const bs of s.riverBetSizes) {
        const amt = Math.min(Math.round(bs * potNow), remaining);
        if (amt <= 0 || seen.has(amt)) continue; seen.add(amt);
        const nc = player === 0 ? [cOOP + amt, cIP] : [cOOP, cIP + amt];
        edges.push({ kind: "bet", amount: amt, allin: amt === remaining, child: this.buildRiver(r, other, nc[0], nc[1], raises, false) });
      }
      if (s.allowAllIn && remaining > 0 && !seen.has(remaining)) {
        const nc = player === 0 ? [cOOP + remaining, cIP] : [cOOP, cIP + remaining];
        edges.push({ kind: "bet", amount: remaining, allin: true, child: this.buildRiver(r, other, nc[0], nc[1], raises, false) });
      }
    } else {
      edges.push({ kind: "fold", amount: 0, child: { type: "fold", folder: player, cOOP, cIP } });
      const callAmt = Math.min(toCall, remaining);
      const ncCall = player === 0 ? [cOOP + callAmt, cIP] : [cOOP, cIP + callAmt];
      edges.push({ kind: "call", amount: callAmt, child: { type: "showdown", cOOP: ncCall[0], cIP: ncCall[1], r } });
      if (raises < s.raiseCap && remaining > toCall && s.allowAllIn) {
        const nc = player === 0 ? [cOOP + remaining, cIP] : [cOOP, cIP + remaining];
        edges.push({ kind: "raise", amount: remaining, allin: true, child: this.buildRiver(r, other, nc[0], nc[1], raises + 1, false) });
      }
    }
    const n = this.rangeSize(player), a = edges.length;
    return { type: "action", player, n, a, edges, rPlus: new Float64Array(a * n), cum: new Float64Array(a * n) };
  }

  private strategy(node: ActionNode): Float64Array {
    const { a, n, rPlus } = node; const out = new Float64Array(a * n);
    for (let i = 0; i < n; i++) {
      let sum = 0; for (let k = 0; k < a; k++) { const v = rPlus[k * n + i]; if (v > 0) sum += v; }
      if (sum > 0) for (let k = 0; k < a; k++) { const v = rPlus[k * n + i]; out[k * n + i] = v > 0 ? v / sum : 0; }
      else for (let k = 0; k < a; k++) out[k * n + i] = 1 / a;
    }
    return out;
  }
  private avgStrategy(node: ActionNode): Float64Array {
    const { a, n, cum } = node; const out = new Float64Array(a * n);
    for (let i = 0; i < n; i++) {
      let sum = 0; for (let k = 0; k < a; k++) sum += cum[k * n + i];
      if (sum > 0) for (let k = 0; k < a; k++) out[k * n + i] = cum[k * n + i] / sum;
      else for (let k = 0; k < a; k++) out[k * n + i] = 1 / a;
    }
    return out;
  }

  private showdownUtil(trav: 0 | 1, node: ShowdownNode, oppReach: Float64Array): Float64Array {
    const travCombos = trav === 0 ? this.spot.oop : this.spot.ip;
    const oppCombos = trav === 0 ? this.spot.ip : this.spot.oop;
    const travRank = (trav === 0 ? this.rankR0 : this.rankR1).get(node.r)!;
    const oppRank = (trav === 0 ? this.rankR1 : this.rankR0).get(node.r)!;
    const cTrav = trav === 0 ? node.cOOP : node.cIP;
    const cOpp = trav === 0 ? node.cIP : node.cOOP;
    const winNet = this.spot.pot + cOpp, loseNet = -cTrav, tieNet = (this.spot.pot + cOpp - cTrav) / 2;
    const out = new Float64Array(travCombos.length);
    for (let i = 0; i < travCombos.length; i++) {
      const ti = travCombos[i]; if (travRank[i] < 0) { out[i] = 0; continue; }
      let u = 0;
      for (let j = 0; j < oppCombos.length; j++) {
        const rch = oppReach[j]; if (rch === 0 || oppRank[j] < 0) continue;
        const oj = oppCombos[j]; if (!disjoint(ti.a, ti.b, oj.a, oj.b)) continue;
        if (travRank[i] > oppRank[j]) u += rch * winNet; else if (travRank[i] < oppRank[j]) u += rch * loseNet; else u += rch * tieNet;
      }
      out[i] = u;
    }
    return out;
  }
  private foldUtil(trav: 0 | 1, node: FoldNode, oppReach: Float64Array): Float64Array {
    const travCombos = trav === 0 ? this.spot.oop : this.spot.ip;
    const oppCombos = trav === 0 ? this.spot.ip : this.spot.oop;
    const cTrav = trav === 0 ? node.cOOP : node.cIP, cOpp = trav === 0 ? node.cIP : node.cOOP;
    const net = node.folder === trav ? -cTrav : this.spot.pot + cOpp;
    const out = new Float64Array(travCombos.length);
    for (let i = 0; i < travCombos.length; i++) {
      const ti = travCombos[i]; let reach = 0;
      for (let j = 0; j < oppCombos.length; j++) { const rch = oppReach[j]; if (rch === 0) continue; const oj = oppCombos[j]; if (disjoint(ti.a, ti.b, oj.a, oj.b)) reach += rch; }
      out[i] = net * reach;
    }
    return out;
  }

  private cfr(trav: 0 | 1, node: TNode, oppReach: Float64Array, iter: number): Float64Array {
    if (node.type === "showdown") return this.showdownUtil(trav, node, oppReach);
    if (node.type === "fold") return this.foldUtil(trav, node, oppReach);
    if (node.type === "chance") {
      const travCombos = trav === 0 ? this.spot.oop : this.spot.ip;
      const oppCombos = trav === 0 ? this.spot.ip : this.spot.oop;
      const util = new Float64Array(travCombos.length);
      for (const kid of node.kids) {
        const r = kid.r;
        // zero opponent combos blocked by this river card
        const oppR = new Float64Array(oppReach.length);
        for (let j = 0; j < oppCombos.length; j++) { const oj = oppCombos[j]; oppR[j] = (oj.a === r || oj.b === r) ? 0 : oppReach[j]; }
        const cu = this.cfr(trav, kid.root, oppR, iter);
        for (let i = 0; i < travCombos.length; i++) { const ti = travCombos[i]; if (ti.a === r || ti.b === r) continue; util[i] += cu[i]; }
      }
      for (let i = 0; i < travCombos.length; i++) util[i] /= this.rPerMatch; // valid rivers per matchup
      return util;
    }
    const { a, n, edges } = node;
    if (node.player === trav) {
      const strat = this.strategy(node);
      const cu: Float64Array[] = new Array(a);
      for (let k = 0; k < a; k++) cu[k] = this.cfr(trav, edges[k].child, oppReach, iter);
      const util = new Float64Array(n);
      for (let i = 0; i < n; i++) { let u = 0; for (let k = 0; k < a; k++) u += strat[k * n + i] * cu[k][i]; util[i] = u; }
      const alphaCoef = (() => { const x = Math.pow(iter, ALPHA); return x / (1 + x); })();
      for (let k = 0; k < a; k++) for (let i = 0; i < n; i++) {
        const idx = k * n + i; let rr = node.rPlus[idx] + (cu[k][i] - util[i]); rr *= rr > 0 ? alphaCoef : BETA; node.rPlus[idx] = rr;
      }
      const sN = this.strategy(node), sCoef = Math.pow(iter / (iter + 1), GAMMA);
      for (let idx = 0; idx < a * n; idx++) node.cum[idx] = node.cum[idx] * THETA + sN[idx] * sCoef;
      return util;
    } else {
      const strat = this.strategy(node); const travN = this.rangeSize(trav); const util = new Float64Array(travN);
      for (let k = 0; k < a; k++) { const nr = new Float64Array(n); for (let j = 0; j < n; j++) nr[j] = oppReach[j] * strat[k * n + j]; const cu = this.cfr(trav, edges[k].child, nr, iter); for (let i = 0; i < travN; i++) util[i] += cu[i]; }
      return util;
    }
  }

  private br(trav: 0 | 1, node: TNode, oppReach: Float64Array): Float64Array {
    if (node.type === "showdown") return this.showdownUtil(trav, node, oppReach);
    if (node.type === "fold") return this.foldUtil(trav, node, oppReach);
    if (node.type === "chance") {
      const travCombos = trav === 0 ? this.spot.oop : this.spot.ip;
      const oppCombos = trav === 0 ? this.spot.ip : this.spot.oop;
      const util = new Float64Array(travCombos.length);
      for (const kid of node.kids) {
        const r = kid.r; const oppR = new Float64Array(oppReach.length);
        for (let j = 0; j < oppCombos.length; j++) { const oj = oppCombos[j]; oppR[j] = (oj.a === r || oj.b === r) ? 0 : oppReach[j]; }
        const cu = this.br(trav, kid.root, oppR);
        for (let i = 0; i < travCombos.length; i++) { const ti = travCombos[i]; if (ti.a === r || ti.b === r) continue; util[i] += cu[i]; }
      }
      for (let i = 0; i < travCombos.length; i++) util[i] /= this.rPerMatch;
      return util;
    }
    const { a, n, edges } = node;
    if (node.player === trav) {
      const cu: Float64Array[] = new Array(a); for (let k = 0; k < a; k++) cu[k] = this.br(trav, edges[k].child, oppReach);
      const travN = this.rangeSize(trav); const util = new Float64Array(travN);
      for (let i = 0; i < travN; i++) { let best = -Infinity; for (let k = 0; k < a; k++) if (cu[k][i] > best) best = cu[k][i]; util[i] = best; }
      return util;
    } else {
      const avg = this.avgStrategy(node); const travN = this.rangeSize(trav); const util = new Float64Array(travN);
      for (let k = 0; k < a; k++) { const nr = new Float64Array(n); for (let j = 0; j < n; j++) nr[j] = oppReach[j] * avg[k * n + j]; const cu = this.br(trav, edges[k].child, nr); for (let i = 0; i < travN; i++) util[i] += cu[i]; }
      return util;
    }
  }

  exploitability(): number {
    const br0 = this.br(0, this.root, Float64Array.from(this.w1));
    const br1 = this.br(1, this.root, Float64Array.from(this.w0));
    let v0 = 0, v1 = 0;
    for (let i = 0; i < this.w0.length; i++) v0 += this.w0[i] * br0[i];
    for (let i = 0; i < this.w1.length; i++) v1 += this.w1[i] * br1[i];
    return ((v0 + v1) / this.Z - this.spot.pot) / this.spot.pot * 100;
  }

  solve(iterations: number): { exploitabilityPct: number } {
    for (let t = 1; t <= iterations; t++) {
      this.cfr(0, this.root, Float64Array.from(this.w1), t);
      this.cfr(1, this.root, Float64Array.from(this.w0), t);
    }
    return { exploitabilityPct: this.exploitability() };
  }

  rootStrategy(): { actions: { kind: ActionKind; amount: number; allin?: boolean }[]; perCombo: { combo: Combo; freqs: number[] }[] } {
    const root = this.root;
    if (root.type !== "action") return { actions: [], perCombo: [] };
    const avg = this.avgStrategy(root);
    const actorRange = root.player === 0 ? this.spot.oop : this.spot.ip;
    const actions = root.edges.map((e) => ({ kind: e.kind, amount: e.amount, allin: e.allin }));
    const perCombo = actorRange.map((combo, i) => ({ combo, freqs: root.edges.map((_, k) => avg[k * root.n + i]) }));
    return { actions, perCombo };
  }
}
