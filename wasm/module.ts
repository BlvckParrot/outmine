// Typed entry point for the emscripten glue that wasm/build.sh emits.
// The generated mine.mjs carries no types, so the cast lives here once and
// everything downstream gets a checked interface.
import createModuleUntyped from "./build/mine.mjs";

export interface OutmineModule {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;

  /** Hashes nonces from nonceStart up to nonceEnd, writing the winning nonce's hash
   *  to outHash. Returns the nonce, or -1 when the range is exhausted. Writes each
   *  nonce it tries into header[76..79], so the header reflects the hit on return. */
  _mine(
    headerPtr: number,
    targetPtr: number,
    nonceStart: number,
    nonceEnd: number,
    outHashPtr: number,
  ): number;

  /** Hashes one 80-byte header as-is. Used by the vector test. */
  _hash_once(headerPtr: number, outHashPtr: number): void;

  /** One bare yespower round, for comparing algorithms. */
  _bench_yespower(input64Ptr: number, rounds: number, out32Ptr: number): number;
}

export const createModule = createModuleUntyped as unknown as () => Promise<OutmineModule>;
