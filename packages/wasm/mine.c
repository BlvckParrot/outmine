/* outmine WASM miner: nonce loop for MinotaurX.
   Derived from cpuminer-multi (GPLv2) - see vendor/cpuminer-multi.

   The nonce loop lives here rather than in JS: crossing the JS/WASM boundary
   per hash costs more than the hash itself. */
#include <stdint.h>
#include <string.h>
#include <stdbool.h>
#include <algo/yespower/yespower.h>

void minotaurhash(void *output, const void *input, bool minotaurX);

/* cpuminer's fulltest: compare as 256-bit little-endian words, most significant first. */
static bool hash_meets_target(const uint32_t *hash, const uint32_t *target)
{
    for (int i = 7; i >= 0; i--) {
        if (hash[i] > target[i]) return false;
        if (hash[i] < target[i]) return true;
    }
    return true; /* exactly equal counts as a hit */
}

/* header80 must already be in cpuminer's endiandata byte order.
   Returns the winning nonce, or -1 when the range is exhausted. */
int32_t mine(uint8_t *header80, const uint8_t *target32,
             uint32_t nonce_start, uint32_t nonce_end, uint8_t *out_hash)
{
    uint32_t _Alignas(64) hash[8];

    for (uint32_t nonce = nonce_start; nonce != nonce_end; nonce++) {
        header80[76] = (uint8_t)(nonce >> 24);
        header80[77] = (uint8_t)(nonce >> 16);
        header80[78] = (uint8_t)(nonce >> 8);
        header80[79] = (uint8_t)(nonce);

        minotaurhash(hash, header80, true);

        if (hash_meets_target(hash, (const uint32_t *)target32)) {
            memcpy(out_hash, hash, 32);
            return (int32_t)nonce;
        }
    }
    return -1;
}

/* One bare yespower(2048,8) round - the same work yescrypt does per hash.
   Lets us compare algorithms without pulling in a second upstream. */
int32_t bench_yespower(const uint8_t *input64, uint32_t rounds, uint8_t *out32)
{
    static const yespower_params_t params = {YESPOWER_1_0, 2048, 8, "et in arcadia ego", 17};
    uint8_t buf[64];
    memcpy(buf, input64, 64);
    for (uint32_t i = 0; i < rounds; i++) {
        buf[0] = (uint8_t)i;
        if (yespower_tls(buf, 64, &params, (yespower_binary_t *)out32) != 0) return -1;
    }
    return 0;
}

/* Hash one header as-is, no nonce loop. Used by the vector test. */
void hash_once(const uint8_t *header80, uint8_t *out_hash)
{
    minotaurhash(out_hash, header80, true);
}

#ifdef VECTOR_MAIN
#include <stdio.h>
#include <stdlib.h>

/* Native reference build: prints the MinotaurX hash of an 80-byte hex header. */
int main(int argc, char **argv)
{
    if (argc != 2 || strlen(argv[1]) != 160) {
        fprintf(stderr, "usage: %s <160-hex-char header>\n", argv[0]);
        return 2;
    }
    uint8_t header[80], out[32];
    for (int i = 0; i < 80; i++) {
        char byte[3] = {argv[1][i * 2], argv[1][i * 2 + 1], 0};
        header[i] = (uint8_t)strtol(byte, NULL, 16);
    }
    hash_once(header, out);
    for (int i = 0; i < 32; i++) printf("%02x", out[i]);
    printf("\n");
    return 0;
}
#endif
