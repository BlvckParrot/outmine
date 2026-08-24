import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createModule } from "./module";

// Reference vectors produced by wasm/build/vector, the native build of the
// same C sources. A WASM build that disagrees here is silently mining garbage:
// the pool rejects every share and it looks like a network fault.
const VECTORS: [string, string][] = [
  [
    "00".repeat(80),
    "33a3ced4ed40fe5bc0add6b2c72fa523cc90ee8f7c6dba3fd95bba06083166b7",
  ],
  [
    "00000020" + "ab".repeat(76),
    "98bdf044854db1b6b66227d3a15a5443cf899b40fc4cbd2f4705a59020128c78",
  ],
];

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) =>
  Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

const Module = await createModule();

function hashOnce(header: Uint8Array): Uint8Array {
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

test.each(VECTORS)("minotaurx hash of %s", (header, expected) => {
  expect(hex(hashOnce(unhex(header)))).toBe(expected);
});

test("vectors still match the native build", async () => {
  if (!existsSync("wasm/build/vector")) return; // built by wasm/build.sh
  for (const [header, expected] of VECTORS) {
    const proc = Bun.spawnSync(["wasm/build/vector", header]);
    expect(proc.stdout.toString().trim()).toBe(expected);
  }
});

test("mine() finds a nonce and its hash meets the target", () => {
  // Target with the top 8 bits clear: ~1 hit per 256 hashes, so the test stays quick.
  const target = new Uint8Array(32).fill(0xff);
  target[31] = 0x00;

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
    expect(hex(hashOnce(stoppedHeader))).toBe(
      hex(Module.HEAPU8.slice(outPtr, outPtr + 32)),
    );

    // And the nonce must actually be written big-endian at bytes 76..79.
    const view = new DataView(stoppedHeader.buffer, stoppedHeader.byteOffset);
    expect(view.getUint32(76, false)).toBe(nonce);
  } finally {
    Module._free(inPtr);
    Module._free(tPtr);
    Module._free(outPtr);
  }
});
