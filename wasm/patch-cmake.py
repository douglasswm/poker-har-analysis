#!/usr/bin/env python3
# Patch TexasSolver's CMakeLists.txt for a single-threaded WebAssembly build.
#
# Exactly the patch proven (byte-identical output) against the native binary:
#   - remove OpenMP (FIND_PACKAGE REQUIRED + -fopenmp flags); the #pragma omp lines
#     are ignored without -fopenmp, and the few omp_* calls resolve to wasm/omp.h.
#   - prepend the stub include dir so our omp.h wins over any system one.
# Plus the WASM-only bits:
#   - emscripten link flags on the console_solver target (raw FS, growable memory).
#
# Idempotent: running twice is a no-op. Usage: python3 patch-cmake.py CMakeLists.txt
import sys

MARK = "# >>> tengan wasm patch"

def main(path):
    s = open(path).read()
    if MARK in s:
        print("already patched:", path); return
    s = s.replace('set(CMAKE_CXX_FLAGS "-Wall -Wextra  -fopenmp")', 'set(CMAKE_CXX_FLAGS "-Wall -Wextra")')
    s = s.replace('set(CMAKE_C_FLAGS "-fopenmp")', 'set(CMAKE_C_FLAGS "")')
    s = s.replace('set(LINKFLAGS "-fopenmp")', 'set(LINKFLAGS "")')
    s = s.replace('FIND_PACKAGE(OpenMP REQUIRED)', '# OpenMP disabled (single-threaded wasm)\nset(OPENMP_FOUND FALSE)')
    s = s.replace('include_directories(include)',
                  'include_directories(BEFORE ${CMAKE_CURRENT_SOURCE_DIR}/wasm_stub)\ninclude_directories(include)')
    # emscripten link flags for the console executable
    flags = "-sNODERAWFS=1 -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1 -sSTACK_SIZE=8MB -O3 -sASSERTIONS=0"
    block = ("\n" + MARK + "\n"
             "if(EMSCRIPTEN)\n"
             f'  set_target_properties(console_solver PROPERTIES LINK_FLAGS "{flags}")\n'
             "endif()\n"
             "# <<< tengan wasm patch\n")
    s = s.replace('target_link_libraries(console_solver TexasSolver)',
                  'target_link_libraries(console_solver TexasSolver)\n' + block)
    open(path, "w").write(s)
    print("patched:", path)

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "CMakeLists.txt")
