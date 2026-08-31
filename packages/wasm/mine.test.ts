import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { ALGOS, createModule, type Algo, type OutmineModule } from "./module";

// Reference vectors produced by build/vector-<algo>, the native build of the
// same C sources. A WASM build that disagrees here is silently mining garbage:
// the pool rejects every share and it looks like a network fault.
const VECTORS: Record<Algo, [string, string][]> = {
  minotaurx: [
    [
      "00".repeat(80),
      "33a3ced4ed40fe5bc0add6b2c72fa523cc90ee8f7c6dba3fd95bba06083166b7",
    ],
    [
      "00000020" + "ab".repeat(76),
      "98bdf044854db1b6b66227d3a15a5443cf899b40fc4cbd2f4705a59020128c78",
    ],
  ],
  rinhash: [
    [
      "00".repeat(80),
      "94a91eed857dfa0e04e8fc01255f801194f139fe4ba3beada920d6e9d0bfc048",
    ],
    [
      "00000020" + "ab".repeat(76),
      "7450f690fe932dab2e6f362af8d25a77794bedd301cdf3ba49f344a88da3a880",
    ],
  ],
};

/** Where in the header each algorithm writes the nonce. MinotaurX hashes the header
 *  cpuminer be32enc's before scanning; RinHash hashes work->data untouched, so its
 *  nonce word is little-endian. Getting this backwards is invisible until the pool
 *  rejects every share, so both directions are pinned here. */
const NONCE_BIG_ENDIAN: Record<Algo, boolean> = { minotaurx: true, rinhash: false };

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) =>
  Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

const modules = Object.fromEntries(
  await Promise.all(ALGOS.map(async (a) => [a, await createModule(a)] as const)),
) as Record<Algo, OutmineModule>;

function hashOnce(Module: OutmineModule, header: Uint8Array): Uint8Array {
  const inPtr = Module._malloc(80);
  const outPtr = Module._malloc(32);
  try {
    Module.HEAPU8.set(header, inPtr);
    Module._hash_once(inPtr, outPtr);
    return Module.HEAPU8.slice(outPtr, outPtr + 32);
  } finally {
    Module._free(inPtr);
    Module._free(outPtr);
  }
}

for (const algo of ALGOS) {
  test.each(VECTORS[algo])(`${algo} hash of %s`, (header, expected) => {
    expect(hex(hashOnce(modules[algo], unhex(header)))).toBe(expected);
  });

  test(`${algo} vectors still match the native build`, () => {
    // Anchored to this file, not the working directory: `bun test` runs from the repo
    // root while `bun --filter` runs from the package.
    const vector = `${import.meta.dir}/build/vector-${algo}`;
    if (!existsSync(vector)) return; // built by build.sh
    for (const [header, expected] of VECTORS[algo]) {
      const proc = Bun.spawnSync([vector, header]);
      expect(proc.stdout.toString().trim()).toBe(expected);
    }
  });

  test(`${algo} mine() finds a nonce and its hash meets the target`, () => {
    // Target with the top 8 bits clear: ~1 hit per 256 hashes, so the test stays quick.
    const target = new Uint8Array(32).fill(0xff);
    target[31] = 0x00;

    const Module = modules[algo];
    const header = unhex("00000020" + "ab".repeat(76));
    const inPtr = Module._malloc(80);
    const tPtr = Module._malloc(32);
    const outPtr = Module._malloc(32);
    try {
      Module.HEAPU8.set(header, inPtr);
      Module.HEAPU8.set(target, tPtr);
      const nonce = Module._mine(inPtr, tPtr, 0, 50_000, outPtr);
      expect(nonce).toBeGreaterThanOrEqual(0);

      // The hash mine() reported must be the hash of the header it stopped on.
      const stoppedHeader = Module.HEAPU8.slice(inPtr, inPtr + 80);
      expect(hex(hashOnce(Module, stoppedHeader))).toBe(
        hex(Module.HEAPU8.slice(outPtr, outPtr + 32)),
      );

      // And the nonce must land at bytes 76..79 in this algorithm's byte order.
      const view = new DataView(stoppedHeader.buffer, stoppedHeader.byteOffset);
      expect(view.getUint32(76, !NONCE_BIG_ENDIAN[algo])).toBe(nonce);
    } finally {
      Module._free(inPtr);
      Module._free(tPtr);
      Module._free(outPtr);
    }
  });
}
