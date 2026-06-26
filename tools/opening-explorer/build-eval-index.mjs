/**
 * Phase 1 of the Backend Eval DB pipeline.
 *
 * Streams the Lichess cloud eval DB (.jsonl.zst) ONCE and writes a packed,
 * sorted, random-access lookup file (evals.bin): for every position, an
 * XXH64 hash of its normalized FEN paired with a single i16 eval scalar.
 *
 * Downstream tools mmap/read evals.bin and binary-search it in RAM (~3.7 GB for
 * the full ~388M-position DB) instead of re-streaming the 19 GB source.
 *
 * Usage:
 *   node --max-old-space-size=8192 build-eval-index.mjs [input.jsonl.zst]
 *
 * Env:
 *   INPUT        input .jsonl.zst (overrides argv[2]; default: data/*eval*.jsonl.zst)
 *   OUTPUT       output path (default data/evals.bin)
 *   PROGRESS_MS  progress interval ms (default 10000)
 *   MAX_RECORDS  stop after N records, 0 = all (default 0; for fast testing)
 *   CAPACITY     initial array capacity, grows as needed (default 4_000_000)
 *
 * ── FEN key ──
 * The eval DB FEN is already the 4-field key (pieces + side + castling + ep);
 * we hash exactly those 4 fields. chess.js (downstream) emits the same 4 fields
 * with the same en-passant convention, so keys match byte-for-byte.
 *
 * ── i16 value encoding (see BACKEND-EVAL-DB.md) ──
 *   centipawns : stored as-is, clamped to ±29000
 *   mate in N  : sign * (32000 - min(|N|, 2000))  → magnitude in [30000, 32000]
 * Decode: |v| >= 30000 → mate in (32000 - |v|), side sign(v); else v is cp.
 *
 * ── evals.bin format ──
 *   off 0  : 4-byte magic "EVB1"
 *   off 4  : uint32 LE version (1)
 *   off 8  : uint32 LE count N
 *   off 12 : uint32 LE reserved (0)
 *   off 16 : N × u64 LE hashes, ascending  (binary-search key)
 *   off 16 + N*8 : N × i16 LE evals         (parallel to hashes)
 */
import { spawn } from "child_process";
import { createInterface } from "readline";
import { createReadStream, statSync, readdirSync, createWriteStream } from "fs";
import path from "path";
import { xxh64 } from "@node-rs/xxhash";

const DATA_DIR = path.resolve(import.meta.dirname, "data");
const PROGRESS_MS = parseInt(process.env.PROGRESS_MS || "10000");
const MAX_RECORDS = parseInt(process.env.MAX_RECORDS || "0");
const INIT_CAPACITY = parseInt(process.env.CAPACITY || "4000000");

const CP_CLAMP = 29000;
const MATE_BASE = 32000;
const MATE_N_CLAMP = 2000;
const U32 = 0xffffffffn;

// ── i16 eval encoding from the deepest eval's best line ──
function encodeEval(evals) {
  let best = null;
  for (const e of evals) {
    if (!e.pvs || e.pvs.length === 0) continue;
    if (best === null || e.depth > best.depth) best = e;
  }
  if (best === null) return null;

  const pv = best.pvs[0];
  if (pv.mate !== undefined) {
    const sign = pv.mate >= 0 ? 1 : -1;
    const n = Math.min(Math.abs(pv.mate), MATE_N_CLAMP);
    return sign * (MATE_BASE - n);
  }
  if (pv.cp !== undefined) {
    return Math.max(-CP_CLAMP, Math.min(CP_CLAMP, pv.cp | 0));
  }
  return null;
}

function normalizeFen(fen) {
  const p = fen.split(" ");
  return `${p[0]} ${p[1]} ${p[2]} ${p[3]}`;
}

// ── LSD radix sort on the 64-bit key (hi,lo as u32), carrying the i16 eval ──
// 16-bit digits → 4 passes. No comparator (V8 rejects custom comparefn on huge
// TypedArrays), O(n), in-place via ping-pong buffers. Mutates the inputs and
// returns the buffers holding the sorted data.
function radixSortByHash(n, hi, lo, ev) {
  let aHi = hi, aLo = lo, aEv = ev;
  let bHi = new Uint32Array(n), bLo = new Uint32Array(n), bEv = new Int16Array(n);
  const RADIX = 1 << 16, MASK = RADIX - 1;
  const count = new Uint32Array(RADIX + 1);
  for (let pass = 0; pass < 4; pass++) {
    count.fill(0);
    const useHi = pass >= 2;
    const shift = (pass & 1) * 16;
    for (let i = 0; i < n; i++) {
      const w = useHi ? aHi[i] : aLo[i];
      count[((w >>> shift) & MASK) + 1]++;
    }
    for (let i = 0; i < RADIX; i++) count[i + 1] += count[i];
    for (let i = 0; i < n; i++) {
      const w = useHi ? aHi[i] : aLo[i];
      const p = count[(w >>> shift) & MASK]++;
      bHi[p] = aHi[i]; bLo[p] = aLo[i]; bEv[p] = aEv[i];
    }
    let t;
    t = aHi; aHi = bHi; bHi = t;
    t = aLo; aLo = bLo; bLo = t;
    t = aEv; aEv = bEv; bEv = t;
  }
  return { hi: aHi, lo: aLo, ev: aEv };
}

function fmtCount(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

async function main() {
  let input = process.env.INPUT || process.argv[2];
  if (!input) {
    const cands = readdirSync(DATA_DIR).filter(
      (f) => f.includes("eval") && f.endsWith(".jsonl.zst")
    );
    if (cands.length === 0) {
      console.error("No *eval*.jsonl.zst found in data/. Pass an input path.");
      process.exit(1);
    }
    input = path.join(DATA_DIR, cands.sort().reverse()[0]);
  }
  if (!input.includes("/")) input = path.join(DATA_DIR, input);
  const output = process.env.OUTPUT || path.join(DATA_DIR, "evals.bin");
  const compressedTotal = statSync(input).size;

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║      Build Eval Index — pack + sort evals.bin     ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`Input    : ${input} (${(compressedTotal / 1e9).toFixed(2)} GB compressed)`);
  console.log(`Output   : ${output}`);
  console.log(`PROGRESS_MS: ${PROGRESS_MS}   MAX_RECORDS: ${MAX_RECORDS || "∞"}   CAPACITY: ${fmtCount(INIT_CAPACITY)}`);
  console.log();

  // Growable column store: hash split into hi/lo u32 (fast Number-comparator sort).
  let cap = INIT_CAPACITY;
  let hi = new Uint32Array(cap);
  let lo = new Uint32Array(cap);
  let ev = new Int16Array(cap);
  let n = 0;

  function grow() {
    const ncap = cap * 2;
    const nhi = new Uint32Array(ncap);
    nhi.set(hi);
    hi = nhi;
    const nlo = new Uint32Array(ncap);
    nlo.set(lo);
    lo = nlo;
    const nev = new Int16Array(ncap);
    nev.set(ev);
    ev = nev;
    cap = ncap;
    process.stderr.write(`  [grew capacity → ${fmtCount(cap)}]\n`);
  }

  // Stream .zst → lines; count compressed bytes for ETA.
  let compressedRead = 0;
  const fileStream = createReadStream(input, { highWaterMark: 1 << 20 });
  fileStream.on("data", (c) => {
    compressedRead += c.length;
  });
  const zstd = spawn("zstd", ["-dc"], { stdio: ["pipe", "pipe", "inherit"] });
  fileStream.pipe(zstd.stdin);
  zstd.stdin.on("error", () => {});
  const rl = createInterface({ input: zstd.stdout, crlfDelay: Infinity });

  let lines = 0;
  let parseErrors = 0;
  let noEval = 0;
  const startTime = Date.now();
  let lastTime = startTime;
  let lastLines = 0;
  let lastStored = 0;

  function printProgress() {
    const now = Date.now();
    const elapsed = now - startTime;
    const frac = compressedTotal ? compressedRead / compressedTotal : 0;
    const pct = (frac * 100).toFixed(1);
    const eta = frac > 0.0001 ? fmtDuration((elapsed * (1 - frac)) / frac) : "…";
    const dl = lines - lastLines;
    const ds = n - lastStored;
    const lps = dl / ((now - lastTime) / 1000 || 1);
    process.stderr.write(
      `${pct.padStart(5)}% | lines ${fmtCount(lines)} (+${fmtCount(dl)}) | ` +
        `stored ${fmtCount(n)} (+${fmtCount(ds)}) | ${fmtCount(Math.round(lps))} l/s | ` +
        `${fmtDuration(elapsed)} elapsed | ETA ${eta}\n`
    );
    lastTime = now;
    lastLines = lines;
    lastStored = n;
  }
  const timer = setInterval(printProgress, PROGRESS_MS);

  for await (const line of rl) {
    if (line.length === 0) continue;
    lines++;
    if (MAX_RECORDS && lines > MAX_RECORDS) {
      lines--;
      break;
    }

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      parseErrors++;
      continue;
    }
    if (!rec.fen || !rec.evals) {
      noEval++;
      continue;
    }
    const val = encodeEval(rec.evals);
    if (val === null) {
      noEval++;
      continue;
    }

    if (n === cap) grow();
    const h = xxh64(Buffer.from(normalizeFen(rec.fen), "latin1"), 0n);
    hi[n] = Number(h >> 32n);
    lo[n] = Number(h & U32);
    ev[n] = val;
    n++;
  }

  clearInterval(timer);
  try {
    fileStream.destroy();
    zstd.kill("SIGTERM");
  } catch {}
  printProgress();

  console.log(`\nStreamed ${fmtCount(lines)} records → ${fmtCount(n)} stored ` +
    `(${parseErrors} parse errors, ${noEval} without usable eval)`);

  // ── Sort by hash (LSD radix, no comparator — safe for huge arrays) ──
  console.log(`Sorting ${fmtCount(n)} entries by hash…`);
  const sortStart = Date.now();
  const sorted = radixSortByHash(n, hi, lo, ev);
  const sHi = sorted.hi, sLo = sorted.lo, sEv = sorted.ev;
  console.log(`Sorted in ${fmtDuration(Date.now() - sortStart)}`);

  // ── Write evals.bin ──
  console.log(`Writing ${output}…`);
  const writeStart = Date.now();
  const ws = createWriteStream(output);
  const writeBuf = (buf) =>
    new Promise((res) => {
      if (!ws.write(buf)) ws.once("drain", res);
      else res();
    });

  const header = Buffer.alloc(16);
  header.write("EVB1", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(n, 8);
  header.writeUInt32LE(0, 12);
  await writeBuf(header);

  const CHUNK = 1 << 20; // entries per flush
  // hashes block: u64 LE = [lo, hi]
  let hbuf = Buffer.allocUnsafe(Math.min(CHUNK, n || 1) * 8);
  for (let i = 0; i < n; ) {
    const end = Math.min(i + CHUNK, n);
    const len = end - i;
    if (hbuf.length < len * 8) hbuf = Buffer.allocUnsafe(len * 8);
    for (let j = 0; j < len; j++) {
      hbuf.writeUInt32LE(sLo[i + j], j * 8);
      hbuf.writeUInt32LE(sHi[i + j], j * 8 + 4);
    }
    await writeBuf(hbuf.subarray(0, len * 8));
    i = end;
  }
  // evals block: i16 LE
  let ebuf = Buffer.allocUnsafe(Math.min(CHUNK, n || 1) * 2);
  for (let i = 0; i < n; ) {
    const end = Math.min(i + CHUNK, n);
    const len = end - i;
    if (ebuf.length < len * 2) ebuf = Buffer.allocUnsafe(len * 2);
    for (let j = 0; j < len; j++) ebuf.writeInt16LE(sEv[i + j], j * 2);
    await writeBuf(ebuf.subarray(0, len * 2));
    i = end;
  }
  await new Promise((res) => ws.end(res));

  const bytes = 16 + n * 10;
  console.log(`Wrote ${output} (${(bytes / 1e9).toFixed(3)} GB) in ${fmtDuration(Date.now() - writeStart)}`);
  console.log(`Done in ${fmtDuration(Date.now() - startTime)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
