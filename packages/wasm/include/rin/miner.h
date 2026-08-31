/* Shim replacing cpuminer-opt's miner.h for the RinHash sources.
   argon2d/core.c reaches into the miner for two things only: an aligned
   allocator and the _ALIGN macro. The real header drags in the whole miner. */
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>

#define _ALIGN(x) __attribute__((aligned(x)))

/* Argon2 wants its 64 KiB region aligned for the SIMD block functions. We build
   the portable ref.c, which does not need it, but core.c allocates either way. */
static inline void *mm_malloc(size_t size, size_t alignment)
{
    void *ptr = NULL;
    if (alignment < sizeof(void *)) alignment = sizeof(void *);
    /* Round up: posix_memalign requires a multiple of sizeof(void*) and a
       power of two, and rejects sizes it cannot serve. */
    if (posix_memalign(&ptr, alignment, size) != 0) return NULL;
    return ptr;
}

static inline void mm_free(void *ptr) { free(ptr); }
