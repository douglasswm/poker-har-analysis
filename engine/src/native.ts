import type { ActionRec, Recommendation } from "./advisor.js";
import { RANKS, SUITS } from "./cards.js";
import { rangeGrid, type RangeGrid } from "./ranges.js";

export interface NativeActionReq {
  heroIsOOP: boolean;
  heroCardStr: string[];
  toCall: number;
  bb: number;
  pot: number;
  effStack: number;
  street: string;
  streetActions?: { kind: string; amtBB: number }[];
  range?: Recommendation["range"];
}

function betChild(node: any, targetBB: number) {
  if (!node || !node.childrens) return null;
  let best = null, bestd = 1e9;
  for (const k in node.childrens) {
    const m = /^(BET|RAISE)\s+([\d.]+)/.exec(k);
    if (!m) continue;
    const d = Math.abs(parseFloat(m[2]) - targetBB);
    if (d < bestd) { bestd = d; best = node.childrens[k]; }
  }
  return best;
}

function childForAction(node: any, a: { kind: string; amtBB: number }) {
  const ch = node && node.childrens; if (!ch) return null;
  if (a.kind === "check") return ch["CHECK"] || null;
  if (a.kind === "call") return ch["CALL"] || null;
  const pick = (pref: string) => {
    let best = null, bestd = 1e9;
    for (const k in ch) {
      const m = new RegExp("^" + pref + "\\s+([\\d.]+)").exec(k);
      if (!m) continue;
      const d = Math.abs(parseFloat(m[1]) - a.amtBB);
      if (d < bestd) { bestd = d; best = ch[k]; }
    }
    return best;
  };
  const pref = a.kind === "raise" ? "RAISE" : "BET";
  return pick(pref) || pick(pref === "RAISE" ? "BET" : "RAISE");
}

function navByReplay(tree: any, req: NativeActionReq) {
  let node = tree;
  for (let i = 0; i < (req.streetActions || []).length; i++) {
    node = childForAction(node, req.streetActions![i]);
    if (!node) return null;
  }
  return node;
}

function navByHeuristic(tree: any, req: NativeActionReq) {
  if (!(req.toCall > 0)) {
    return req.heroIsOOP ? tree : (tree.childrens && tree.childrens["CHECK"]);
  }
  const target = req.toCall / (req.bb || 1);
  return req.heroIsOOP ? betChild(tree.childrens && tree.childrens["CHECK"], target) : betChild(tree, target);
}

export function nativeNodeForHero(tree: any, req: NativeActionReq) {
  if (Array.isArray(req.streetActions)) {
    const n = navByReplay(tree, req);
    if (n && n.strategy && n.strategy.actions) return n;
  }
  return navByHeuristic(tree, req);
}

export function extractNativeActions(tree: any, req: NativeActionReq): ActionRec[] | null {
  const node = nativeNodeForHero(tree, req);
  const strat = node && node.strategy;
  if (!strat || !strat.actions || !strat.strategy) return null;
  const acts = strat.actions;
  const key = req.heroCardStr[0] + req.heroCardStr[1];
  const fr = strat.strategy[key] || strat.strategy[req.heroCardStr[1] + req.heroCardStr[0]];
  if (!fr) return null;
  const bb = req.bb || 1;
  const out: ActionRec[] = [];
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i], f = fr[i] || 0;
    if (f <= 0.004) continue;
    let kind = "check", allin = false, potFrac: number | undefined, amount: number | undefined;
    if (/^FOLD/.test(a)) kind = "fold";
    else if (/^CALL/.test(a)) kind = "call";
    else if (/^(BET|RAISE)/.test(a)) {
      kind = /^BET/.test(a) ? "bet" : "raise";
      const amtBB = parseFloat(a.split(" ")[1]);
      allin = amtBB >= (req.effStack || 1e9) * 0.98;
      amount = Math.round(amtBB * bb);
      if (!allin) potFrac = +(amtBB / (req.pot || 1)).toFixed(2);
    }
    out.push({ kind, freq: f, allin, potFrac, amount });
  }
  out.sort((x, y) => y.freq - x.freq);
  return out.length ? out : null;
}

export function nativeGridFromStrategy(stratNode: any, effStackBB: number): RangeGrid | null {
  if (!stratNode || !stratNode.actions || !stratNode.strategy) return null;
  const kinds = stratNode.actions.map((a: string) => {
    if (/^CHECK/.test(a)) return "check";
    if (/^CALL/.test(a)) return "call";
    if (/^FOLD/.test(a)) return "fold";
    const m = /^(BET|RAISE)\s+([\d.]+)/.exec(a);
    if (m) {
      const amt = parseFloat(m[2]);
      const allin = amt >= (effStackBB || 1e9) * 0.98;
      return allin ? "allin" : (m[1] === "BET" ? "bet" : "raise");
    }
    return "check";
  });
  const cid = (s: string) => RANKS.indexOf(s[0]) * 4 + SUITS.indexOf(s[1]);
  const combos: { a: number; b: number; freqs: number[] }[] = [];
  for (const k of Object.keys(stratNode.strategy)) {
    const ids = k.match(/../g);
    if (!ids || ids.length !== 2) continue;
    const a = cid(ids[0]), b = cid(ids[1]);
    if (a < 0 || b < 0 || a > 51 || b > 51) continue;
    combos.push({ a, b, freqs: stratNode.strategy[k] });
  }
  return rangeGrid(kinds, combos);
}

export function nativeRecommendation(tree: any, req: NativeActionReq, base?: Partial<Recommendation>, ms?: number): Recommendation | null {
  const actions = extractNativeActions(tree, req);
  if (!actions || !actions.length) return null;
  const node = nativeNodeForHero(tree, req);
  const grid = node && node.strategy ? nativeGridFromStrategy(node.strategy, req.effStack) : null;
  return {
    headline: "", source: "solver", bb: base?.bb || req.bb,
    detail: req.street.charAt(0).toUpperCase() + req.street.slice(1) + " GTO solve — native TexasSolver, range vs range.",
    top: actions[0], actions, rangeGrid: grid || undefined,
    note: "True solve (native TexasSolver · " + req.street + ") · " + (ms ? Math.round(ms / 1000) + "s" : ""),
    solver: { backend: "native-texassolver", status: "ready", detail: req.street },
    range: req.range || base?.range
  };
}
