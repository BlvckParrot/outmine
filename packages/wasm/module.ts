// Typed entry point for the emscripten glue that wasm/build.sh emits.
// The generated mine-<algo>.mjs carries no types, so the cast lives here once and
// everything downstream gets a checked interface.
//
// The browser does not come through here - the worker fetches /mine-<algo>.mjs from
// the site root, because emscripten's glue resolves its .wasm relative to itself.
// This is for the tests and the benchmark, which run under Bun.

export interface OutmineModule {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;

  /** Hashes nonces from nonceStart up to nonceEnd, writing the winning nonce's hash
   *  to outHash. Returns the nonce, or -1 when the range is exhausted. Writes each
   *  nonce it tries into header[76..79], so the header reflects the hit on return.
   *
   *  Which byte order it writes the nonce in is the algorithm's business: MinotaurX
   *  hashes cpuminer's be32enc'd header, RinHash hashes work->data as it stands. */
  _mine(
    headerPtr: number,
    targetPtr: number,
    nonceStart: number,
    nonceEnd: number,
    outHashPtr: number,
  ): number;

  /** Hashes one 80-byte header as-is. Used by the vector test. */
  _hash_once(headerPtr: number, outHashPtr: number): void;
}

export const ALGOS = ["minotaurx", "rinhash"] as const;
export type Algo = (typeof ALGOS)[number];

export async function createModule(algo: Algo = "minotaurx"): Promise<OutmineModule> {
  const glue = (await import(`./build/mine-${algo}.mjs`)) as {
    default: () => Promise<OutmineModule>;
  };
  return glue.default();
}
