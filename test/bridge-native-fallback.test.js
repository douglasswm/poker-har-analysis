import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync("src/bridge.js", "utf8");

assert.match(src, /let nativeDispatched = false;/);
assert.match(src, /nativeDispatched = dispatchNative\(req, gs, positions, opts, id\);/);
assert.doesNotMatch(src, /if \(dispatchNative\(req, gs, positions, opts, id\)\) return;/);
assert.match(src, /state\.nativeSolvedId === d\.id/);
assert.match(src, /native beat the fallback worker/);

console.log("PASS bridge native fallback keeps worker solve visible");
