#!/usr/bin/env bash
# Builds the MinotaurX hasher twice from identical sources:
#   build/vector  - native reference binary, produces the test vectors
#   build/mine.*  - the WASM module the browser runs
# Both must agree bit for bit; wasm/mine.test.ts enforces that.
set -euo pipefail
cd "$(dirname "$0")/.."

CPU=vendor/cpuminer-multi
OUT=wasm/build
mkdir -p "$OUT"

# Upstream is gitignored: fetch it on first build so the repo stays small.
[ -d "$CPU" ] || git clone --depth 1 https://github.com/litecoincash-project/cpuminer-multi.git "$CPU"

# minotaur.c's scanhash driver needs the real miner.h and the whole miner with it.
# We only want minotaurhash(), so cut the driver off at its own comment marker.
sed '/^\/\/ Scan driver/,$d' "$CPU/algo/minotaur.c" > "$OUT/minotaur_core.c"
grep -q minotaurhash "$OUT/minotaur_core.c" || { echo "strip removed too much"; exit 1; }

SPH="blake bmw cubehash echo fugue groestl hamsi jh keccak luffa shabal shavite simd skein whirlpool sha2 sha2big"
SRC=("$OUT/minotaur_core.c" "$CPU/algo/yespower/yespower.c" "$CPU/algo/yespower/crypto/sha256.c" "$CPU/sha3/aes_helper.c")
for a in $SPH; do SRC+=("$CPU/sha3/sph_$a.c"); done

INC=(-Iwasm/include -I"$CPU" -I"$CPU/sha3" -I"$CPU/algo/yespower")
# sphlib and yespower both trip these; they are upstream's problem, not ours.
QUIET=(-Wno-unused-function -Wno-incompatible-pointer-types -Wno-implicit-function-declaration)

# The native reference only exists to produce test vectors. Skip it where there is
# no host compiler (the emsdk image ships emcc's clang, not a system one) - the
# vector test then falls back to its committed expectations.
if command -v clang >/dev/null 2>&1; then
  echo "==> native reference"
  clang -O2 -DVECTOR_MAIN "${INC[@]}" "${QUIET[@]}" wasm/mine.c "${SRC[@]}" -o "$OUT/vector"
else
  echo "==> native reference skipped (no clang)"
fi

echo "==> wasm"
emcc -O3 "${INC[@]}" "${QUIET[@]}" wasm/mine.c "${SRC[@]}" \
  -o "$OUT/mine.mjs" \
  -sEXPORTED_FUNCTIONS=_mine,_hash_once,_bench_yespower,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
  -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=16MB

# The worker loads /mine.mjs at runtime, so the build output has to reach the frontend.
mkdir -p web/public
cp "$OUT/mine.mjs" "$OUT/mine.wasm" web/public/

echo "==> done: $OUT (and web/public)"
