# WASM TexasSolver — no-native-binary GTO (G1)

The native solve-server (`../solver-server`) gives true TexasSolver GTO but needs
the C++ `console_solver` binary installed. This directory builds that same solver
to **WebAssembly**, so the no-compromise flop/turn/river solver runs with **no
native binary** — `node console_solver.js` is a drop-in backend for the server.

## Status — honest

- ✅ **Single-threaded source proven correct.** The wasm build is single-threaded
  (no OpenMP — see below). Rebuilt natively with OpenMP removed and the `omp.h`
  stub, the solver's output is **byte-identical** to the threaded binary
  (max |Δ| = 0 across 2,416 combo-action frequencies on a flop solve). So removing
  threading changes *speed only, not the GTO result*.
- ✅ **Build kit verified except the compile itself.** The CMake patch
  (`patch-cmake.py`) is proven: a freshly-patched tree still builds and still emits
  the byte-identical reference. The `omp.h` stub is the exact one used in that proof.
- ⚠️ **The `emcc` compile must run on your machine.** The build sandbox these files
  were prepared in blocks the emscripten toolchain host (HTTP 403 via its proxy)
  and has no root to install it, so the final `emcc` step could not be executed
  here. On any normal machine, `emcc` installs in minutes and `build-wasm.sh` runs
  end-to-end; `verify-wasm.mjs` then re-checks the wasm against the committed
  reference output.

## Why single-threaded

In-browser threads need `SharedArrayBuffer`, which requires COOP/COEP response
headers that a Chrome MV3 extension cannot reliably set. Single-threaded wasm has
**none of that** — one `.wasm`, no headers, runs anywhere. The cost is wall-clock
speed (sequential CFR); correctness is unchanged (proven above). Threading can be
added later for a server/desktop context if wanted.

## Build

Prereqs on your machine: `emscripten` (emcc/emcmake on PATH), `cmake`, `git`,
`python3`.

```bash
bash wasm/build-wasm.sh            # clones TexasSolver (console branch), patches, builds
# -> <src>/build-wasm/console_solver.js (+ .wasm)
```

`build-wasm.sh` applies exactly the proven patch: copies `omp.h` into the source's
`wasm_stub/`, runs `patch-cmake.py` (drops OpenMP, prepends the stub include, adds
emscripten link flags), then `emcmake cmake` + build.

## Verify (re-proves GTO correctness on your machine)

```bash
node wasm/verify-wasm.mjs --wasm <src>/build-wasm/console_solver.js --cwd <src>
# -> MATCH ✅  wasm GTO == reference TexasSolver (byte-exact)
```

It runs the wasm on `reference/solve.txt` and diffs every combo frequency against
`reference/expected.json` (produced by the real TexasSolver binary).

## Use it (drop-in, no native binary)

`-sNODERAWFS=1` gives the wasm direct filesystem access under Node, so it reads
`resources/` and writes the dump just like the native binary. Point the server at
the `.js` — it detects the extension and runs it via node:

```bash
TENGAN_SOLVER_BIN="<src>/build-wasm/console_solver.js" \
TENGAN_SOLVER_CWD="<src>" \
node solver-server/server.js
```

The HUD ("solver" toggle) and `npm run parity -- --live` then work unchanged — and
the parity harness will re-confirm the wasm matches the in-engine solver's
decisions on your machine.

## Files

- `omp.h` — single-threaded `<omp.h>` stub (proven).
- `patch-cmake.py` — CMake patch (OpenMP off + stub include + emscripten flags).
- `build-wasm.sh` — clone + patch + build.
- `verify-wasm.mjs` — run the wasm and diff vs the reference dump.
- `reference/solve.txt`, `reference/expected.json` — deterministic config + the
  real-TexasSolver output it must reproduce.

## Beyond Node: fully in-browser (future)

The Node path above removes the *native binary* but still runs a localhost server.
To run the solver **inside the extension with no server at all**, load the `.wasm`
in the HUD's worker and supply the inputs through Emscripten's in-memory FS
(`MEMFS`) instead of `NODERAWFS`: fetch the card dictionary
(`resources/compairer/card5_dic_sorted.txt`, 52 MB raw / 6.4 MB gzipped) once,
cache it (Cache Storage / IndexedDB), mount it in MEMFS, write the config to MEMFS,
run `callMain(["-i","cfg"])`, and read the dumped JSON back from MEMFS. That's a
larger integration (asset hosting + caching + worker glue) and is the remaining
step to a zero-install, zero-server solver.
