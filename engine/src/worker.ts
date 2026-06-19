// Web Worker entry — runs the (potentially multi-second) GTO solve off the
// page's main thread so the HUD never freezes. The bundle is self-contained;
// the bridge spawns it via chrome.runtime.getURL("src/engine.worker.js").
import Engine from "./index.js";

const ctx: any = self as any;
ctx.onmessage = (e: MessageEvent) => {
  const msg = (e && (e as any).data) || {};
  const { id, gs, positions, opts } = msg;
  try {
    const out = Engine.recommend(gs, positions, opts);
    ctx.postMessage({ id, out });
  } catch (err: any) {
    ctx.postMessage({ id, error: String((err && err.message) || err) });
  }
};
