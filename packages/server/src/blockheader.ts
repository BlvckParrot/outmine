// Turns a stratum job into the 80-byte header our WASM hashes.
//
// The browser only spins nonces; the merkle math stays here. That keeps the
// client tiny and lets the server hand each miner its own extranonce2 range.
//
// Byte order follows cpuminer's stratum_gen_work + scanhash pair: work->data is
// built with le32dec/be32dec, then scanhash be32enc's every word. The net effect
// per field is spelled out below. Getting this wrong yields hashes that are
// perfectly valid and rejected by every pool, so it is worth the comments.

import type { MinerAlgo } from "@outmine/protocol";

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
export const bytesToHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const sha256 = (data: Uint8Array) =>
  new Uint8Array(new Bun.CryptoHasher("sha256").update(data).digest().buffer);
export const sha256d = (data: Uint8Array) => sha256(sha256(data));

const reversed = (b: Uint8Array) => b.slice().reverse();

/** Reverse each 4-byte word in place, keeping word order. */
function reverseWords(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) out.set(reversed(bytes.subarray(i, i + 4)), i);
  return out;
}

export type StratumJob = {
  jobId: string;
  prevHash: string;
  coinb1: string;
  coinb2: string;
  merkleBranch: string[];
  version: string;
  nbits: string;
  ntime: string;
};

export function merkleRoot(job: StratumJob, extranonce1: string, extranonce2: string): Uint8Array {
  const coinbase = hexToBytes(job.coinb1 + extranonce1 + extranonce2 + job.coinb2);
  let root = sha256d(coinbase);
  for (const branch of job.merkleBranch) {
    const pair = new Uint8Array(64);
    pair.set(root, 0);
    pair.set(hexToBytes(branch), 32);
    root = sha256d(pair);
  }
  return root;
}

export function buildHeader(job: StratumJob, extranonce1: string, extranonce2: string): Uint8Array {
  const header = new Uint8Array(80);
  header.set(reversed(hexToBytes(job.version)), 0);          // version: whole word reversed
  header.set(reverseWords(hexToBytes(job.prevHash)), 4);     // prevhash: each word reversed, order kept
  header.set(merkleRoot(job, extranonce1, extranonce2), 36); // merkle root: as computed
  header.set(reversed(hexToBytes(job.ntime)), 68);
  header.set(reversed(hexToBytes(job.nbits)), 72);
  // bytes 76..79 are the nonce, written by the WASM miner.
  return header;
}

/** How the winning nonce goes back to the pool: cpuminer-multi's minotaur submits
 *  `le32enc(work->data[19])`, cpuminer-opt's rinhash `be32enc` of the same word.
 *
 *  Both algorithms hash the identical 80 bytes above, and each writes the nonce into
 *  bytes 76..79 in its own order - big-endian for MinotaurX, little-endian for
 *  RinHash - yet the hex they hand the pool differs in the opposite direction. That
 *  is not a rule anyone could derive; all four combinations were put to zpool and
 *  this is the one it accepts. hub.integration.test.ts is what keeps it honest. */
export const NONCE_SUBMIT_LITTLE_ENDIAN: Record<MinerAlgo, boolean> = {
  minotaurx: true,
  rinhash: false,
};

/** Port of cpuminer's diff_to_target. MinotaurX uses it with no difficulty factor. */
export function diffToTarget(diff: number): Uint8Array {
  const words = new Uint32Array(8);
  let k = 6;
  while (k > 0 && diff > 1.0) {
    diff /= 4294967296.0;
    k--;
  }
  const m = BigInt(Math.floor(4294901760.0 / diff));
  if (m === 0n && k === 6) return new Uint8Array(32).fill(0xff);
  words[k] = Number(m & 0xffffffffn);
  if (k + 1 < 8) words[k + 1] = Number((m >> 32n) & 0xffffffffn);
  return new Uint8Array(words.buffer);
}
