# argon2 ref.c

Argon2's portable reference `fill_segment`, one file, taken from
[phc-winner-argon2](https://github.com/P-H-C/phc-winner-argon2) `src/ref.c`
([f57e61e](https://github.com/P-H-C/phc-winner-argon2/commit/f57e61e19229e23c4445b85494dbf7c07de721cb)).
CC0-1.0 or Apache-2.0 at your option - the header on the file carries the terms.

Here rather than in `vendor/` because it is not a submodule and it is not upstream's to
place: cpuminer-opt-rin ships only argon2's SIMD `fill_segment`, which needs SSE2 and
cpuminer's `simd-utils.h`, so the portable path has to come from Argon2's own package.
It used to be curled into the rin checkout at build time, which pulled from `master` with
no digest locally, and wrote into somebody else's repository - now a submodule, so that
would also leave it permanently dirty.

It compiles against **rin's** `argon2.h`, `core.h` and `blake2/` rather than upstream's,
which is why it is not built from a checkout of its own repository: its includes are
quoted, so sitting next to upstream's headers would silently select those instead, and
rin's copies are modified. `build.sh` resolves them through `-I"$RIN/argon2d"` and
`-I"$RIN"`, so this file works from anywhere.
