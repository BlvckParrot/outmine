/* Shim replacing XKCP's generated config.h.
   KeccakSponge.c gates each permutation width behind one of these; RinHash uses
   SHA3-256, which is Keccak-p[1600], and that is the only one vendored. */
#pragma once
#define XKCP_has_KeccakP1600
