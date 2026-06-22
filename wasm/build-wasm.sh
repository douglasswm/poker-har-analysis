#!/usr/bin/env bash
# Build TexasSolver's console solver to a single-threaded WebAssembly module.
#
# Produces  console_solver.js  +  console_solver.wasm  that run under Node with
# `node console_solver.js -i config.txt` exactly like the native binary (NODERAWFS
# gives the wasm direct filesystem access, so it reads resources/ and writes the
# dump with no preloading). Use it as a drop-in backend for solver-server (set
# TENGAN_SOLVER_BIN to the .js) — no native C++ binary required.
#
# Prerequisites (install on your own machine — this is the one step the build
# sandbox could not run, because its network blocks the emscripten toolchain host):
#   - emscripten (emcc / emcmake on PATH)   https://emscripten.org/docs/getting_started/downloads.html
#   - cmake, git, python3
#
# The single-threaded source is byte-identical in output to the threaded native
# binary (proven; see README.md), so this build is correct GTO, just sequential.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HOME/TexasSolver-wasm-src}"
JOBS="${JOBS:-4}"

command -v emcmake >/dev/null || { echo "ERROR: emscripten (emcmake) not on PATH. See https://emscripten.org/docs/getting_started/downloads.html"; exit 1; }

if [ ! -d "$SRC/.git" ]; then
  echo "Cloning TexasSolver (console branch) into $SRC ..."
  git clone --depth 1 --branch console https://github.com/bupticybee/TexasSolver.git "$SRC"
fi
cd "$SRC"

# Apply the proven patch: omp stub + OpenMP off + emscripten link flags.
mkdir -p wasm_stub
cp "$HERE/omp.h" wasm_stub/omp.h
python3 "$HERE/patch-cmake.py" CMakeLists.txt

echo "Configuring (emcmake) ..."
emcmake cmake -B build-wasm -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5
echo "Building console_solver -> wasm ..."
cmake --build build-wasm --target console_solver -j"$JOBS"

OUT="$SRC/build-wasm/console_solver.js"
[ -f "$OUT" ] || { echo "ERROR: expected $OUT not found"; ls -la "$SRC/build-wasm" | head; exit 1; }
echo
echo "Built: $OUT (+ console_solver.wasm)"
echo "Verify it matches reference TexasSolver output:"
echo "  node $HERE/verify-wasm.mjs --wasm \"$OUT\" --cwd \"$SRC\""
echo "Use as solver-server backend:"
echo "  TENGAN_SOLVER_BIN=\"$OUT\" TENGAN_SOLVER_CWD=\"$SRC\" node solver-server/server.js"
