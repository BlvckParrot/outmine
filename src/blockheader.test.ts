import { expect, test } from "bun:test";
import { buildHeader, bytesToHex, diffToTarget, merkleRoot, sha256d, type StratumJob } from "./blockheader";

const job: StratumJob = {
  jobId: "abc",
  version: "20000000",
  prevHash: "0011223344556677" + "8899aabbccddeeff".repeat(3),
  coinb1: "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff",
  coinb2: "ffffffff0100f2052a010000001976a914000000000000000000000000000000000000000088ac00000000",
  merkleBranch: [],
  nbits: "1d0a3758",
  ntime: "68a80000",
};

test("sha256d matches the known double-SHA256 of 'abc'", () => {
  // sha256("abc") = ba7816bf…, sha256 of that = 4f8b42c2…
  expect(bytesToHex(sha256d(new TextEncoder().encode("abc")))).toBe(
    "4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358",
  );
});

test("diff 1 gives the classic difficulty-1 target", () => {
  expect(bytesToHex(diffToTarget(1))).toBe("00".repeat(24) + "0000ffff" + "00000000");
});

test("target shrinks as difficulty grows", () => {
  const asBig = (d: number) => {
    const words = new Uint32Array(diffToTarget(d).buffer);
    return [...words].reverse().reduce((acc, w) => (acc << 32n) | BigInt(w >>> 0), 0n);
  };
  expect(asBig(0.000002)).toBeGreaterThan(asBig(1));
  expect(asBig(1)).toBeGreaterThan(asBig(1000));
  expect(asBig(1000)).toBeGreaterThan(asBig(1e9));
});

test("header is 80 bytes with fields in the right slots", () => {
  const header = buildHeader(job, "800c87c1", "00000000");
  expect(header.length).toBe(80);
  expect(bytesToHex(header.subarray(0, 4))).toBe("00000020"); // version word reversed
  expect(bytesToHex(header.subarray(4, 12))).toBe("3322110077665544"); // prevhash: each word reversed, word order kept
  expect(bytesToHex(header.subarray(68, 72))).toBe("0000a868"); // ntime reversed
  expect(bytesToHex(header.subarray(72, 76))).toBe("58370a1d"); // nbits reversed
  expect(bytesToHex(header.subarray(76, 80))).toBe("00000000"); // nonce left for the miner
});

test("a different extranonce2 gives a different merkle root", () => {
  const a = merkleRoot(job, "800c87c1", "00000000");
  const b = merkleRoot(job, "800c87c1", "00000001");
  expect(bytesToHex(a)).not.toBe(bytesToHex(b));
});

test("merkle branch entries are folded in", () => {
  const withBranch = { ...job, merkleBranch: ["11".repeat(32)] };
  expect(bytesToHex(merkleRoot(withBranch, "800c87c1", "00000000"))).not.toBe(
    bytesToHex(merkleRoot(job, "800c87c1", "00000000")),
  );
});
