#!/usr/bin/env bash
# Builds each hasher twice from identical sources:
#   build/vector-<algo>  - native reference binary, produces the test vectors
#   build/mine-<algo>.*  - the WASM module the browser runs
# Both must agree bit for bit; mine.test.ts enforces that.
#
# Usage: ./build.sh [algo ...]   (default: all of them)
set -euo pipefail
# Run from this package regardless of the caller's directory: bun --filter sets cwd
# per package, but Docker and a plain ./build.sh do not.
cd "$(dirname "$0")"

OUT=build
WEB_PUBLIC=../web/public
mkdir -p "$OUT" "$WEB_PUBLIC"

# Upstreams are gitignored: fetched on first build so the repo stays small.
CPU=vendor/cpuminer-multi
RIN=vendor/cpuminer-opt-rin/algo/rinhash

# sphlib, yespower and argon2 all trip these; they are upstream's problem, not ours.
QUIET=(-Wno-unused-function -Wno-incompatible-pointer-types -Wno-implicit-function-declaration -Wno-pointer-sign)
EMFLAGS=(
  -O3
  -sEXPORTED_FUNCTIONS=_mine,_hash_once,_malloc,_free
  -sEXPORTED_RUNTIME_METHODS=HEAPU8
  -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=16MB
)
# No -msimd128: measured on Apple Silicon in both Chromium and Bun, yespower's SSE2
# path built for WASM SIMD runs at 0.85x the plain scalar build. -flto, emmalloc and
# a fixed heap all measured as noise. See "Why not SIMD" in the README.

sources_minotaurx() {
  [ -d "$CPU" ] || git clone --depth 1 https://github.com/litecoincash-project/cpuminer-multi.git "$CPU"

  # minotaur.c's scanhash driver needs the real miner.h and the whole miner with it.
  # We only want minotaurhash(), so cut the driver off at its own comment marker.
  sed '/^\/\/ Scan driver/,$d' "$CPU/algo/minotaur.c" > "$OUT/minotaur_core.c"
  grep -q minotaurhash "$OUT/minotaur_core.c" || { echo "strip removed too much"; exit 1; }

  INC=(-Iinclude -I"$CPU" -I"$CPU/sha3" -I"$CPU/algo/yespower")
  SRC=(mine.c "$OUT/minotaur_core.c" "$CPU/algo/yespower/yespower.c"
       "$CPU/algo/yespower/crypto/sha256.c" "$CPU/sha3/aes_helper.c")
  local a
  for a in blake bmw cubehash echo fugue groestl hamsi jh keccak luffa shabal \
           shavite simd skein whirlpool sha2 sha2big; do
    SRC+=("$CPU/sha3/sph_$a.c")
  done
  NATIVE_EXTRA=()
}

sources_rinhash() {
  if [ ! -d "$RIN" ]; then
    # Sparse: the repo is a whole miner and we want one algorithm's worth of it.
    git clone --depth 1 --filter=blob:none --sparse \
      https://github.com/Rin-coin/cpuminer-opt-rin.git vendor/cpuminer-opt-rin
    git -C vendor/cpuminer-opt-rin sparse-checkout set algo/rinhash
  fi
  # Upstream ships only argon2's SIMD fill_segment, which needs SSE2 and cpuminer's
  # simd-utils.h. The portable one comes from Argon2's own reference package.
  [ -f "$RIN/argon2d/ref.c" ] ||
    curl -sSfL -o "$RIN/argon2d/ref.c" \
      https://raw.githubusercontent.com/P-H-C/phc-winner-argon2/master/src/ref.c

  INC=(-Iinclude/rin -I"$RIN" -I"$RIN/argon2d" -I"$RIN/blake3" -I"$RIN/sha3")
  SRC=(rin.c
       "$RIN/argon2d/argon2.c" "$RIN/argon2d/core.c" "$RIN/argon2d/encoding.c"
       "$RIN/argon2d/ref.c" "$RIN/argon2d/argon2d_thread.c" "$RIN/blake2/blake2b.c"
       "$RIN/blake3/blake3.c" "$RIN/blake3/blake3_dispatch.c" "$RIN/blake3/blake3_portable.c"
       "$RIN/sha3/SimpleFIPS202.c" "$RIN/sha3/KeccakSponge.c" "$RIN/sha3/KeccakP-1600-reference.c")
  # BLAKE3 picks NEON on an arm64 host, which would need a file the WASM build never
  # compiles. Both builds take the portable path so both hash the same bytes.
  NATIVE_EXTRA=(-DBLAKE3_USE_NEON=0)
}

ALGOS=("$@")
[ ${#ALGOS[@]} -gt 0 ] || ALGOS=(minotaurx rinhash)

for algo in "${ALGOS[@]}"; do
  "sources_$algo"

  # The native reference only exists to produce test vectors. Skip it where there is
  # no host compiler (the emsdk image ships emcc's clang, not a system one) - the
  # vector test then falls back to its committed expectations.
  if command -v clang >/dev/null 2>&1; then
    echo "==> $algo native reference"
    clang -O2 -DVECTOR_MAIN ${NATIVE_EXTRA[@]+"${NATIVE_EXTRA[@]}"} "${INC[@]}" "${QUIET[@]}" \
      "${SRC[@]}" -o "$OUT/vector-$algo"
  else
    echo "==> $algo native reference skipped (no clang)"
  fi

  echo "==> $algo wasm"
  emcc "${EMFLAGS[@]}" "${INC[@]}" "${QUIET[@]}" "${SRC[@]}" -o "$OUT/mine-$algo.mjs"

  # The worker loads /mine-<algo>.mjs at runtime, so the output has to reach the frontend.
  cp "$OUT/mine-$algo.mjs" "$OUT/mine-$algo.wasm" "$WEB_PUBLIC/"
done

echo "==> done: packages/wasm/$OUT (and packages/web/public)"
