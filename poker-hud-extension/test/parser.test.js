// Offline self-test: feed real frames from the redacted HAR through parser.js
// and verify card decoding, positions, board, and pot reconstruct sensibly.
// Run: node test/parser.test.js   (ESM — root package.json has "type":"module")
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load parser.js with a fake `window` so its IIFE attaches PokerParser.
const window = {};
const code = fs.readFileSync(path.join(__dirname, "..", "src", "parser.js"), "utf8");
eval(code); // eslint-disable-line no-eval
const P = window.PokerParser;

// --- Unit checks on the card decoder (anchors from the report) ---
const cardChecks = [
  [16, "6♣"], [17, "6♦"], [51, "A♠"], [41, "Q♦"], [0, "2♣"], [50, "A♥"]
];
let ok = 0, fail = 0;
for (const [id, expect] of cardChecks) {
  const got = P.decodeCard(id);
  if (got === expect) { ok++; }
  else { fail++; console.log(`CARD FAIL: ${id} -> ${got} (expected ${expect})`); }
}
console.log(`Card decode: ${ok}/${cardChecks.length} passed`);

// --- Replay the redacted HAR through the parser ---
const harPath = path.join(__dirname, "..", "..", "poker-har-analysis", "poker.redacted.har");
if (!fs.existsSync(harPath)) {
  console.log("HAR not found at", harPath, "- skipping replay test.");
  process.exit(fail ? 1 : 0);
}
const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
const game = har.log.entries.find((e) => e.request.url.includes("/front"));
const hands = {};
let stateFrames = 0;
for (const m of game._webSocketMessages) {
  let j;
  try { j = JSON.parse(m.data); } catch (e) { continue; }
  if (j.t !== "GameState" || !j.gameState) continue;
  stateFrames++;
  const s = P.update(j);
  if (s) hands[s.handId] = s;
}

const handIds = Object.keys(hands);
console.log(`\nReplayed ${stateFrames} GameState frames across ${handIds.length} hands.\n`);

for (const hid of handIds.slice(0, 4)) {
  const h = hands[hid];
  console.log(`Hand ${h.handId}  table ${h.tableId}  ${h.street}`);
  console.log(`  board: ${h.board.join(" ") || "—"}   pot: ${h.pot}`);
  const withPos = h.seats.filter((s) => s.position).length;
  console.log(`  seats: ${h.seats.length} (${withPos} positioned)`);
}

let asserts = 0, afail = 0;
for (const hid of handIds) {
  const h = hands[hid];
  asserts++;
  if (h.board.some((c) => !/^(?:10|[2-9JQKA])[♣♦♥♠]$/.test(c))) {
    afail++; console.log(`ASSERT FAIL: bad board card in hand ${hid}: ${h.board}`);
  }
}
console.log(`Board-card sanity: ${asserts - afail}/${asserts} hands clean`);
console.log(fail + afail === 0 ? "\nPARSER CHECKS PASSED ✅" : "\nSOME CHECKS FAILED ❌");
process.exit(fail + afail ? 1 : 0);
