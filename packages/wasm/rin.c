/* outmine WASM miner: nonce loop for RinHash.
   Hash sequence and parameters follow Rin-coin/cpuminer-opt-rin's
   algo/rinhash/rinhash.c; only the scanhash driver is ours.

   RinHash hashes the same 80 bytes MinotaurX does - cpuminer's endiandata - but
   writes the nonce into them little-endian rather than big-endian, because its
   scanhash stores `pdata[19] = n` natively instead of calling be32enc. It then
   submits that nonce to the pool big-endian, which is the opposite way round.
   None of that is derivable; all four combinations were put to zpool and this is
   the one it accepts. Getting it wrong is invisible from here: the pool takes
   every share and calls it invalid, which looks exactly like a bad network. */
#include <stdint.h>
#include <string.h>

#include <blake3.h>
#include <argon2.h>
#include <SimpleFIPS202.h>

/* Argon2d over 64 KiB is the whole cost of a RinHash. Everything around it -
   one BLAKE3 of 80 bytes and one SHA3-256 of 32 - is rounding error. */
#define RIN_M_COST 64
#define RIN_T_COST 2
static const char RIN_SALT[] = "RinCoinSalt";

void rinhash(uint8_t *out32, const uint8_t *header80)
{
    uint8_t blake3_out[32];
    blake3_hasher blake;
    blake3_hasher_init(&blake);
    blake3_hasher_update(&blake, header80, 80);
    blake3_hasher_finalize(&blake, blake3_out, 32);

    uint8_t argon_out[32];
    argon2_context ctx = {0};
    ctx.out = argon_out;
    ctx.outlen = 32;
    ctx.pwd = blake3_out;
    ctx.pwdlen = 32;
    ctx.salt = (uint8_t *)RIN_SALT;
    ctx.saltlen = sizeof(RIN_SALT) - 1;
    ctx.t_cost = RIN_T_COST;
    ctx.m_cost = RIN_M_COST;
    ctx.lanes = 1;
    ctx.threads = 1;
    ctx.version = ARGON2_VERSION_13;
    ctx.flags = ARGON2_DEFAULT_FLAGS;

    if (argon2d_ctx(&ctx) != ARGON2_OK) {
        /* Cannot happen with constant parameters, and a silent wrong hash would
           look like a network fault, so make it loudly wrong instead. */
        memset(out32, 0, 32);
        return;
    }

    SHA3_256(out32, argon_out, 32);
}

/* cpuminer's fulltest: compare as 256-bit little-endian words, most significant
   first. Same rule as MinotaurX - RinHash registers no target factor either. */
static int hash_meets_target(const uint32_t *hash, const uint32_t *target)
{
    for (int i = 7; i >= 0; i--) {
        if (hash[i] > target[i]) return 0;
        if (hash[i] < target[i]) return 1;
    }
    return 1;
}

int32_t mine(uint8_t *header80, const uint8_t *target32,
             uint32_t nonce_start, uint32_t nonce_end, uint8_t *out_hash)
{
    uint32_t _Alignas(64) hash[8];

    for (uint32_t nonce = nonce_start; nonce != nonce_end; nonce++) {
        /* Little-endian, unlike MinotaurX. See the note at the top: this line and
           NONCE_SUBMIT_LITTLE_ENDIAN on the server disagree on purpose. */
        header80[76] = (uint8_t)(nonce);
        header80[77] = (uint8_t)(nonce >> 8);
        header80[78] = (uint8_t)(nonce >> 16);
        header80[79] = (uint8_t)(nonce >> 24);

        rinhash((uint8_t *)hash, header80);

        if (hash_meets_target(hash, (const uint32_t *)target32)) {
            memcpy(out_hash, hash, 32);
            return (int32_t)nonce;
        }
    }
    return -1;
}

void hash_once(const uint8_t *header80, uint8_t *out_hash)
{
    rinhash(out_hash, header80);
}

#ifdef VECTOR_MAIN
#include <stdio.h>
#include <stdlib.h>

/* Native reference build: prints the RinHash of an 80-byte hex header. */
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
