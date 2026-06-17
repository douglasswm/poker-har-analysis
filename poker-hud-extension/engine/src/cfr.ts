// Discounted-CFR river solver — our own implementation of the algorithm used by
// bupticybee/TexasSolver (vector-form CFR, DCFR regret discounting, regret
// matching, average strategy, best-response exploitability).
//
// Scope: a single street (river). The board is complete, so there are no chance
// nodes — which is exactly why this is tractable in JS for live use. The tree
// is OOP-acts-first, with configurable bet/raise sizes and a raise cap.
import { Combo, disjoint } from "./cards.js";
import { evaluate7 } from "./evaluator.js";

// DCFR parameters (matching TexasSolver's DiscountedCfrTrainable.h)
const ALPHA = 1.5;
const BETA = 0.5;
const GAMMA = 2;
const THETA = 0.9;

export interface RiverSpot {
  board: number[];          // 5 card ids
  pot: number;              // dead money at the start of the subgame
  effStack: number;         // chips behind per player at subgame start
  oop: Combo[];
  ip: Combo[];
  betSizes: number[];       // bet/donk sizes as fraction of current pot
  raiseSizes: number[];     // raise sizes as fraction of (pot + call)
  raiseCap: number;         // max raises in a betting round
  allowAllIn?: boolean;     // include an explicit all-in (shove) option
}

type ActionKind = "check" | "bet" | "call" | "fold" | "raise";
interface ActionEdge { kind: ActionKind; amount: number; child: Node; allin?: boolean; }

interface ActionNode {
  type: "action";
  player: 0 | 1;            // 0 = OOP, 1 = IP
  n: number;               // range size of `player`
  a: number;               // number of actions
  edges: ActionEdge[];
  rPlus: Float64Array;     // [a*n + i]
  cum: Float64Array;       // [a*n + i]
}
interface ShowdownNode { type: "showdown"; cOOP: number; cIP: number; }
interface FoldNode { type: "fold"; folder: 0 | 1; cOOP: number; cIP: number; }
type Node = ActionNode | ShowdownNode | FoldNode;

export class RiverSolver {
  spot: RiverSpot;
  root: Node;
  rank0: number[];   // 7-card strength per OOP combo
  rank1: number[];
  w0: number[];      // weights
  w1: number[];
  Z: number;         // normalizing mass over disjoint deals

  rootActor: 0 | 1;

  constructor(spot: RiverSpot, rootOpts?: { actor: 0 | 1; cOOP: number; cIP: number; raises: number; prevCheck: boolean }) {
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
    this.root = rootOpts
      ? this.build(rootOpts.actor, rootOpts.cOOP, rootOpts.cIP, rootOpts.raises, rootOpts.prevCheck)
      : this.build(0, 0, 0, 0, false);
  }

  private rangeSize(player: 0 | 1): number {
    return player === 0 ? this.spot.oop.length : this.spot.ip.length;
  }

  // Recursively build the betting tree. cOOP/cIP are chips put in so far.
  private build(player: 0 | 1, cOOP: number, cIP: number, raises: number, prevCheck: boolean): Node {
    const s = this.spot;
    const own = player === 0 ? cOOP : cIP;
    const opp = player === 0 ? cIP : cOOP;
    const toCall = Math.max(cOOP, cIP) - own;
    const remaining = s.effStack - own;
    const potNow = s.pot + cOOP + cIP;
    const edges: ActionEdge[] = [];
    const other: 0 | 1 = player === 0 ? 1 : 0;

    if (remaining <= 0) {
      // No chips behind -> straight to showdown (or call already all-in).
      return { type: "showdown", cOOP, cIP };
    }

    if (toCall === 0) {
      // check
      if (prevCheck) {
        edges.push({ kind: "check", amount: 0, child: { type: "showdown", cOOP, cIP } });
      } else {
        edges.push({ kind: "check", amount: 0, child: this.build(other, cOOP, cIP, raises, true) });
      }
      // bets
      const seen = new Set<number>();
      for (const bs of s.betSizes) {
        let amt = Math.min(Math.round(bs * potNow), remaining);
        if (amt <= 0 || seen.has(amt)) continue;
        seen.add(amt);
        const nc = player === 0 ? [cOOP + amt, cIP] : [cOOP, cIP + amt];
        edges.push({ kind: "bet", amount: amt, allin: amt === remaining, child: this.build(other, nc[0], nc[1], raises, false) });
      }
      // explicit all-in (shove)
      if (s.allowAllIn && remaining > 0 && !seen.has(remaining)) {
        seen.add(remaining);
        const nc = player === 0 ? [cOOP + remaining, cIP] : [cOOP, cIP + remaining];
        edges.push({ kind: "bet", amount: remaining, allin: true, child: this.build(other, nc[0], nc[1], raises, false) });
      }
    } else {
      // fold
      edges.push({ kind: "fold", amount: 0, child: { type: "fold", folder: player, cOOP, cIP } });
      // call (closes action on the river)
      const callAmt = Math.min(toCall, remaining);
      const ncCall = player === 0 ? [cOOP + callAmt, cIP] : [cOOP, cIP + callAmt];
      edges.push({ kind: "call", amount: callAmt, child: { type: "showdown", cOOP: ncCall[0], cIP: ncCall[1] } });
      // raises
      if (raises < s.raiseCap && remaining > toCall) {
        const seen = new Set<number>();
        for (const rs of s.raiseSizes) {
          let add = toCall + Math.round(rs * (potNow + toCall));
          add = Math.min(add, remaining);
          if (add <= toCall || seen.has(add)) continue;
          seen.add(add);
          const nc = player === 0 ? [cOOP + add, cIP] : [cOOP, cIP + add];
          edges.push({ kind: "raise", amount: add, allin: add === remaining, child: this.build(other, nc[0], nc[1], raises + 1, false) });
        }
        // explicit all-in raise (shove over a bet)
        if (s.allowAllIn && remaining > toCall && !seen.has(remaining)) {
          const nc = player === 0 ? [cOOP + remaining, cIP] : [cOOP, cIP + remaining];
          edges.push({ kind: "raise", amount: remaining, allin: true, child: this.build(other, nc[0], nc[1], raises + 1, false) });
        }
      }
    }

    const n = this.rangeSize(player);
    const a = edges.length;
    return {
      type: "action", player, n, a, edges,
      rPlus: new Float64Array(a * n),
      cum: new Float64Array(a * n)
    };
  }

  // Current strategy from positive regrets (regret matching). [a*n + i]
  private strategy(node: ActionNode): Float64Array {
    const { a, n, rPlus } = node;
    const out = new Float64Array(a * n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = 0; k < a; k++) { const v = rPlus[k * n + i]; if (v > 0) sum += v; }
      if (sum > 0) {
        for (let k = 0; k < a; k++) { const v = rPlus[k * n + i]; out[k * n + i] = v > 0 ? v / sum : 0; }
      } else {
        for (let k = 0; k < a; k++) out[k * n + i] = 1 / a;
      }
    }
    return out;
  }

  averageStrategy(node: ActionNode): Float64Array {
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
  private showdownUtil(trav: 0 | 1, node: ShowdownNode, oppReach: Float64Array): Float64Array {
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

  private foldUtil(trav: 0 | 1, node: FoldNode, oppReach: Float64Array): Float64Array {
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
  private cfr(trav: 0 | 1, node: Node, oppReach: Float64Array, iter: number): Float64Array {
    if (node.type === "showdown") return this.showdownUtil(trav, node, oppReach);
    if (node.type === "fold") return this.foldUtil(trav, node, oppReach);

    const { a, n, edges } = node;
    if (node.player === trav) {
      const strat = this.strategy(node);
      const childUtils: Float64Array[] = new Array(a);
      for (let k = 0; k < a; k++) childUtils[k] = this.cfr(trav, edges[k].child, oppReach, iter);
      const util = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let u = 0;
        for (let k = 0; k < a; k++) u += strat[k * n + i] * childUtils[k][i];
        util[i] = u;
      }
      // DCFR regret + strategy-sum update
      const alphaCoef = (() => { const x = Math.pow(iter, ALPHA); return x / (1 + x); })();
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
      // opponent node: fold their strategy into reach, sum action utilities
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
  private br(trav: 0 | 1, node: Node, oppReach: Float64Array): Float64Array {
    if (node.type === "showdown") return this.showdownUtil(trav, node, oppReach);
    if (node.type === "fold") return this.foldUtil(trav, node, oppReach);
    const { a, n, edges } = node;
    if (node.player === trav) {
      const childUtils: Float64Array[] = new Array(a);
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
  exploitability(): number {
    const br0 = this.br(0, this.root, Float64Array.from(this.w1));
    const br1 = this.br(1, this.root, Float64Array.from(this.w0));
    let v0 = 0, v1 = 0;
    for (let i = 0; i < this.w0.length; i++) v0 += this.w0[i] * br0[i];
    for (let i = 0; i < this.w1.length; i++) v1 += this.w1[i] * br1[i];
    const exploitChips = (v0 + v1) / this.Z - this.spot.pot;
    return (exploitChips / this.spot.pot) * 100;
  }

  solve(iterations: number): { exploitabilityPct: number } {
    for (let t = 1; t <= iterations; t++) {
      this.cfr(0, this.root, Float64Array.from(this.w1), t);
      this.cfr(1, this.root, Float64Array.from(this.w0), t);
    }
    return { exploitabilityPct: this.exploitability() };
  }

  // Average strategy at the root (the root actor's decision) for advice.
  rootStrategy(): { actions: { kind: ActionKind; amount: number; allin?: boolean }[]; perCombo: { combo: Combo; freqs: number[] }[] } {
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
}
