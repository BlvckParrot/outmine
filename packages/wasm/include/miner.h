/* Shim replacing cpuminer-multi's miner.h.
   minotaurhash() needs only these; the real header drags in the whole miner. */
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#define _ALIGN(x) __attribute__((aligned(x)))
