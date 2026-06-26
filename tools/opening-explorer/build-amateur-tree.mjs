/**
 * Extracts the set of opening positions reached in amateur (all-rating) games,
 * stopping each game at the first mistake.
 *
 * Loads the in-memory eval index (evals.bin, produced by build-eval-index.mjs)
 * — ~3.7 GB of XXH64(FEN) → i16 eval. Streams a Lichess standard monthly PGN
 * dump (.pgn.zst), keeps only blitz/rapid/classical games (bullet, ultrabullet
 * and correspondence are skipped), and, for each game, replays half-moves
 * collecting the UNIQUE positions reached UNTIL (and including) the first
 * mistake. Positions after a mistake have no repertoire value and are discarded
 * — this prunes most of the amateur post-blunder noise the old two-stage
 * pipeline kept.
 *
 * "Mistake" matches the app's EvalDropService: an eval DROP of >= 50 cp
 * (MISTAKE_THRESHOLD) for the player who just moved, evals being White's
 * perspective (White move drop = before − after; Black move = after − before).
 *
 * Usage:
 *   node build-amateur-tree.mjs [input.pgn.zst] [options via env]
 *
 * Env vars:
 *   MAX_PLY      max half-moves to replay per game        (default 30)
 *   PROGRESS_MS  progress print interval in ms            (default 10000)
 *   CHECKPOINT_MS  min interval between incremental saves (default 60000)
 *   MAX_GAMES    stop after N games, 0 = unlimited        (default 0)
 *   INPUT        input .pgn.zst path (overrides argv[2])
 *   EVALS        eval index path (default data/evals.bin)
 *   OUTPUT       output path (default data/amateur-evals.bin)
 *
 * Output
 * ------
 * `amateur-evals.bin` is a SUBSET of evals.bin in the identical EVB1 format
 * (16-byte header + sorted u64 hashes + parallel i16 evals), containing only the
 * discovered positions. It loads and binary-searches exactly like evals.bin.
 *
 * Incremental progress / resume
 * -----------------------------
 * Discovered positions are tracked as a bit in a 46 MB bitset over evals.bin.
 * Every CHECKPOINT_MS the subset is rewritten (scanning the bitset in evals.bin
 * order keeps it sorted for free) followed by an atomic checkpoint
 * (<output>.checkpoint.json) with the last processed game index and counters.
 * The subset is written BEFORE the checkpoint, so a crash never loses positions
 * — at worst a few games are reprocessed (bit marking is idempotent). On
 * restart, a compatible checkpoint (same input, MAX_PLY, threshold, eval index)
 * is auto-resumed: amateur-evals.bin is reloaded (its bits re-marked) and the
 * already-processed games are skipped. An incompatible checkpoint starts fresh.
 *
 * For the full run, raise Node's heap so the dedup Set fits, e.g.:
 *   node --max-old-space-size=16000 build-amateur-tree.mjs
 *
 * FEN normalization
 * -----------------
 * Keys match the Lichess cloud eval DB native format: the first FOUR FEN fields
 * (piece placement, side to move, castling, en-passant), dropping only the
 * halfmove/fullmove counters. chess.js v1.x emits the en-passant square using
 * the same "legal ep only" convention Lichess uses, so these keys are matchable
 * against the eval DB byte-for-byte.
 */
import { spawn } from "child_process";
import { createInterface } from "readline";
import {
  createReadStream, statSync, readdirSync, openSync, readSync, writeSync, closeSync,
  existsSync, readFileSync, writeFileSync, renameSync, unlinkSync,
} from "fs";
import path from "path";
import { Chess } from "chess.js";
import { xxh64 } from "@node-rs/xxhash";

const DATA_DIR = path.resolve(import.meta.dirname, "data");
const MAX_PLY = parseInt(process.env.MAX_PLY || "30");
const PROGRESS_MS = parseInt(process.env.PROGRESS_MS || "10000");
// Flush discovered FENs + checkpoint at least this often (ms).
const CHECKPOINT_MS = parseInt(process.env.CHECKPOINT_MS || "60000");
const MAX_GAMES = parseInt(process.env.MAX_GAMES || "0");

// Mistake threshold in centipawns — mirrors app/src/services/EvalDropService.ts.
const MISTAKE_THRESHOLD = 50;
// Mate band in evals.bin is |v| >= 30000; clamp mates to ±MATE_BOUND for drop math.
const MATE_BOUND = 30000;

// ── Normalize to the eval DB native key: pieces + side + castling + en-passant ──
function normalizeFen(fen) {
  const p = fen.split(" ");
  return `${p[0]} ${p[1]} ${p[2]} ${p[3]}`;
}

// ── Load evals.bin (header + sorted u64 hashes + parallel i16 evals) ──
function loadEvalIndex(file) {
  const size = statSync(file).size;
  const ab = new ArrayBuffer(size);
  const view = Buffer.from(ab);
  const fd = openSync(file, "r");
  const CHUNK = 256 * 1024 * 1024; // readFileSync caps at 2 GiB; read in chunks
  let pos = 0;
  while (pos < size) {
    const len = Math.min(CHUNK, size - pos);
    const r = readSync(fd, view, pos, len, pos);
    if (r <= 0) break;
    pos += r;
  }
  closeSync(fd);
  const magic = view.toString("latin1", 0, 4);
  if (magic !== "EVB1") throw new Error(`Bad eval index magic: ${magic}`);
  const N = view.readUInt32LE(8);
  const hashes = new BigUint64Array(ab, 16, N);
  const evals = new Int16Array(ab, 16 + N * 8, N);
  return { hashes, evals, N, bytes: size, view };
}

// ── Binary-search the eval index by hash; returns the entry index or -1 ──
function lookupIndex(idx, key) {
  const { hashes, N } = idx;
  let lo = 0, hi = N - 1;
  while (lo <= hi) {
    const m = (lo + hi) >>> 1;
    const v = hashes[m];
    if (v === key) return m;
    if (v < key) lo = m + 1; else hi = m - 1;
  }
  return -1;
}

// XXH64 of the normalized FEN (matches build-eval-index.mjs).
function hashFen(normFen) {
  return xxh64(Buffer.from(normFen, "latin1"), 0n);
}

// Decode an i16 eval to a score for drop math: clamp mates to ±MATE_BOUND.
function decodeScore(e) {
  if (e >= MATE_BOUND) return MATE_BOUND;
  if (e <= -MATE_BOUND) return -MATE_BOUND;
  return e;
}

// ── Extract SAN tokens from movetext (strips clk comments, variations, NAGs) ──
function extractMoves(moveText) {
  const cleaned = moveText
    .replace(/\{[^}]*\}/g, "")            // {comments} incl. [%clk ...]
    .replace(/\([^)]*\)/g, "")            // (variations) — single level
    .replace(/\$\d+/g, "")                // $nag
    .replace(/\d+\.\.\./g, "")            // "1..."
    .replace(/\d+\./g, "")                // "1."
    .replace(/1-0|0-1|1\/2-1\/2|\*/g, "") // results
    .trim();
  return cleaned.split(/\s+/).filter((t) => t.length > 0);
}

// ── Yield { headers, moveText } per game from a line stream ──
async function* parsePgnLines(rl) {
  let headers = {};
  let moveText = "";
  let inMoves = false;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      if (inMoves && moveText.trim()) {
        yield { headers, moveText: moveText.trim() };
        headers = {};
        moveText = "";
      }
      inMoves = false;
      const m = trimmed.match(/^\[(\w+)\s+"(.*)"\]$/);
      if (m) headers[m[1]] = m[2];
    } else if (trimmed === "") {
      if (Object.keys(headers).length > 0 && !inMoves) inMoves = true;
    } else {
      inMoves = true;
      moveText += " " + trimmed;
    }
  }
  if (moveText.trim()) yield { headers, moveText: moveText.trim() };
}

// ── Formatting helpers ──
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

// ── Speed filter: keep blitz / rapid / classical, drop bullet / ultrabullet /
// correspondence. Uses Lichess's estimated-duration rule (base + 40*increment):
// bullet < 180s ≤ blitz < 480s ≤ rapid < 1500s ≤ classical. Correspondence has
// TimeControl "-". We keep estimated >= 180s.
function isWantedSpeed(headers) {
  const tc = headers.TimeControl;
  if (!tc || tc === "-") return false; // correspondence / unknown
  const m = tc.match(/^(\d+)\+(\d+)$/);
  if (!m) return false;
  const estimated = parseInt(m[1], 10) + 40 * parseInt(m[2], 10);
  return estimated >= 180;
}

// ── Write the discovered subset of evals.bin as an EVB1 file (same format as
// evals.bin). Scanning the bitset in index order keeps the output sorted by
// hash for free, since evals.bin is already sorted. Atomic via temp + rename. ──
function writeSubset(file, idx, discovered, count) {
  const { view, N } = idx;
  const hashesOff = 16;
  const evalsOff = 16 + N * 8;
  const tmp = file + ".tmp";
  const fd = openSync(tmp, "w");

  const header = Buffer.alloc(16);
  header.write("EVB1", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(count, 8);
  header.writeUInt32LE(0, 12);
  writeSync(fd, header);

  const CH = 1 << 20; // entries per buffer
  // hashes block (u64 LE), copied straight from evals.bin in sorted index order
  const hbuf = Buffer.allocUnsafe(CH * 8);
  let n = 0;
  for (let i = 0; i < N; i++) {
    if ((discovered[i >>> 3] >>> (i & 7)) & 1) {
      view.copy(hbuf, n * 8, hashesOff + i * 8, hashesOff + i * 8 + 8);
      if (++n === CH) { writeSync(fd, hbuf, 0, n * 8); n = 0; }
    }
  }
  if (n) writeSync(fd, hbuf, 0, n * 8);
  // evals block (i16 LE)
  const ebuf = Buffer.allocUnsafe(CH * 2);
  let m = 0;
  for (let i = 0; i < N; i++) {
    if ((discovered[i >>> 3] >>> (i & 7)) & 1) {
      view.copy(ebuf, m * 2, evalsOff + i * 2, evalsOff + i * 2 + 2);
      if (++m === CH) { writeSync(fd, ebuf, 0, m * 2); m = 0; }
    }
  }
  if (m) writeSync(fd, ebuf, 0, m * 2);

  closeSync(fd);
  renameSync(tmp, file);
}

// ── Reload a previously-written amateur subset, re-marking its positions in the
// discovered bitset by locating each hash in evals.bin. Returns the count. ──
function loadSubsetBits(file, idx, discovered) {
  if (!existsSync(file)) return 0;
  const size = statSync(file).size;
  const ab = new ArrayBuffer(size);
  const v = Buffer.from(ab);
  const fd = openSync(file, "r");
  const CHUNK = 256 * 1024 * 1024;
  let pos = 0;
  while (pos < size) {
    const r = readSync(fd, v, pos, Math.min(CHUNK, size - pos), pos);
    if (r <= 0) break;
    pos += r;
  }
  closeSync(fd);
  if (v.toString("latin1", 0, 4) !== "EVB1") throw new Error("Bad amateur subset magic");
  const M = v.readUInt32LE(8);
  const subHashes = new BigUint64Array(ab, 16, M);
  let count = 0;
  for (let j = 0; j < M; j++) {
    const ix = lookupIndex(idx, subHashes[j]);
    if (ix >= 0) {
      const byte = ix >>> 3, mask = 1 << (ix & 7);
      if (!(discovered[byte] & mask)) { discovered[byte] |= mask; count++; }
    }
  }
  return count;
}

async function main() {
  // Resolve input
  let input = process.env.INPUT || process.argv[2];
  if (!input) {
    const cands = readdirSync(DATA_DIR).filter(
      (f) => f.includes("standard") && f.endsWith(".pgn.zst")
    );
    if (cands.length === 0) {
      console.error("No *standard*.pgn.zst found in data/. Pass an input path.");
      process.exit(1);
    }
    input = path.join(DATA_DIR, cands.sort().reverse()[0]);
  }
  if (!input.includes("/")) input = path.join(DATA_DIR, input);

  const output =
    process.env.OUTPUT || path.join(DATA_DIR, "amateur-evals.bin");
  const evalsPath = process.env.EVALS || path.join(DATA_DIR, "evals.bin");
  const ckptPath = output + ".checkpoint.json";

  const compressedTotal = statSync(input).size;

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   Build Amateur Tree — extract until 1st mistake  ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`Input    : ${input} (${(compressedTotal / 1e9).toFixed(2)} GB compressed)`);
  console.log(`Evals    : ${evalsPath}`);
  console.log(`Output   : ${output}`);
  console.log(`MAX_PLY  : ${MAX_PLY}   MISTAKE_THRESHOLD: ${MISTAKE_THRESHOLD}cp   PROGRESS_MS: ${PROGRESS_MS}   CHECKPOINT_MS: ${CHECKPOINT_MS}   MAX_GAMES: ${MAX_GAMES || "∞"}`);
  console.log();

  // Load the in-memory eval index (~3.7 GB).
  console.log(`Loading eval index…`);
  const loadStart = Date.now();
  const idx = loadEvalIndex(evalsPath);
  console.log(`  ${fmtCount(idx.N)} positions (${(idx.bytes / 1e9).toFixed(2)} GB) in ${fmtDuration(Date.now() - loadStart)}\n`);

  // Discovered-position bitset over evals.bin (1 bit per entry, ~46 MB).
  const discovered = new Uint8Array((idx.N + 7) >>> 3);
  let discoveredCount = 0;
  function markBit(i) {
    const byte = i >>> 3, mask = 1 << (i & 7);
    if (discovered[byte] & mask) return false;
    discovered[byte] |= mask;
    return true;
  }

  let skipped = 0;
  let filteredOut = 0;    // games dropped by the speed filter (bullet/ultra/corr)
  // Early-stop accounting (restored from checkpoint on resume).
  let mistakeStops = 0;   // game truncated at first mistake (drop >= threshold)
  let gapStops = 0;       // game truncated at a position with no eval
  let maxPlyStops = 0;    // reached MAX_PLY with no mistake
  let endStops = 0;       // game ended (out of moves) before MAX_PLY/mistake
  let possiblePlies = 0;  // sum of min(moves, MAX_PLY)
  let walkedPlies = 0;    // sum of plies actually replayed

  // ── Resume from a compatible checkpoint, or start fresh ──
  let resumeFrom = 0;
  const ckpt = existsSync(ckptPath) ? JSON.parse(readFileSync(ckptPath, "utf8")) : null;
  const compatible =
    ckpt &&
    ckpt.input === input &&
    ckpt.maxPly === MAX_PLY &&
    ckpt.mistakeThreshold === MISTAKE_THRESHOLD &&
    ckpt.evalsBytes === idx.bytes;
  if (ckpt && !compatible) {
    console.log("Existing checkpoint is incompatible with this run — starting fresh.\n");
  }
  if (compatible) {
    console.log(`Resuming from checkpoint (game ${fmtCount(ckpt.gamesProcessed)})…`);
    const rLoad = Date.now();
    discoveredCount = loadSubsetBits(output, idx, discovered);
    resumeFrom = ckpt.gamesProcessed;
    skipped = ckpt.skipped || 0;
    filteredOut = ckpt.filteredOut || 0;
    mistakeStops = ckpt.mistakeStops || 0;
    gapStops = ckpt.gapStops || 0;
    maxPlyStops = ckpt.maxPlyStops || 0;
    endStops = ckpt.endStops || 0;
    possiblePlies = ckpt.possiblePlies || 0;
    walkedPlies = ckpt.walkedPlies || 0;
    console.log(`  loaded ${fmtCount(discoveredCount)} positions; will skip first ${fmtCount(resumeFrom)} games (${fmtDuration(Date.now() - rLoad)})\n`);
  } else {
    // Fresh start: remove any stale output / checkpoint.
    if (existsSync(output)) unlinkSync(output);
    if (existsSync(ckptPath)) unlinkSync(ckptPath);
  }

  // Stream the compressed file through zstd; count compressed bytes for ETA.
  let compressedRead = 0;
  const fileStream = createReadStream(input, { highWaterMark: 1 << 20 });
  fileStream.on("data", (c) => {
    compressedRead += c.length;
  });
  const zstd = spawn("zstd", ["-dc"], { stdio: ["pipe", "pipe", "inherit"] });
  fileStream.pipe(zstd.stdin);
  zstd.stdin.on("error", () => {}); // ignore EPIPE on early exit
  const rl = createInterface({ input: zstd.stdout, crlfDelay: Infinity });

  let games = 0;
  const startTime = Date.now();

  // ── Flush: write the EVB1 subset FIRST (atomic), then the checkpoint. This
  // ordering guarantees the checkpoint is never ahead of the persisted subset,
  // so a crash at worst reprocesses a few games (bit marking is idempotent).
  function flush() {
    writeSubset(output, idx, discovered, discoveredCount);
    const state = {
      version: 1,
      input,
      maxPly: MAX_PLY,
      mistakeThreshold: MISTAKE_THRESHOLD,
      evalsBytes: idx.bytes,
      gamesProcessed: games,
      discoveredCount,
      skipped,
      filteredOut,
      mistakeStops, gapStops, maxPlyStops, endStops,
      possiblePlies, walkedPlies,
      updatedAt: new Date().toISOString(),
    };
    const tmp = ckptPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, ckptPath);
  }
  let lastFlushTime = startTime;

  let lastTime = startTime;
  let lastGames = resumeFrom;
  let lastDiscovered = discoveredCount;

  function printProgress() {
    const now = Date.now();
    const elapsed = now - startTime;
    const frac = compressedTotal ? compressedRead / compressedTotal : 0;
    const pct = (frac * 100).toFixed(1);
    const eta =
      frac > 0.0001 ? fmtDuration((elapsed * (1 - frac)) / frac) : "…";
    const dGames = games - lastGames;
    const dPos = discoveredCount - lastDiscovered;
    const gps = dGames / ((now - lastTime) / 1000 || 1);
    const discarded = possiblePlies - walkedPlies;

    process.stderr.write(
      `${pct.padStart(5)}% | games ${fmtCount(games)} (+${fmtCount(dGames)}) | ` +
        `positions ${fmtCount(discoveredCount)} (+${fmtCount(dPos)}) | ` +
        `mistake-stop ${fmtCount(mistakeStops)} | gap-stop ${fmtCount(gapStops)} | ` +
        `discarded ${fmtCount(discarded)} plies | ${fmtCount(Math.round(gps))} g/s | ETA ${eta}\n`
    );

    lastTime = now;
    lastGames = games;
    lastDiscovered = discoveredCount;
  }

  const timer = setInterval(printProgress, PROGRESS_MS);

  if (resumeFrom > 0) console.log(`Skipping first ${fmtCount(resumeFrom)} already-processed games…`);

  for await (const { headers, moveText } of parsePgnLines(rl)) {
    games++;
    if (games <= resumeFrom) continue; // already processed in a prior run
    if (MAX_GAMES && games > MAX_GAMES) {
      games--;
      break;
    }

    // Periodic incremental save (top of loop so it runs regardless of filtering).
    if (Date.now() - lastFlushTime >= CHECKPOINT_MS) {
      flush();
      lastFlushTime = Date.now();
    }

    // Speed filter: only blitz / rapid / classical.
    if (!isWantedSpeed(headers)) {
      filteredOut++;
      continue;
    }

    const moves = extractMoves(moveText);
    if (moves.length === 0) {
      skipped++;
      continue;
    }

    const chess = new Chess();
    const startFen = normalizeFen(chess.fen());
    const startIx = lookupIndex(idx, hashFen(startFen));
    let beforeScore = null;
    if (startIx >= 0) {
      if (markBit(startIx)) discoveredCount++; // ply 0 (start position)
      beforeScore = decodeScore(idx.evals[startIx]);
    }

    const limit = Math.min(moves.length, MAX_PLY);
    possiblePlies += limit;
    let walked = 0;
    let stop = "end"; // ran out of moves within the ply limit

    for (let i = 0; i < limit; i++) {
      let mv;
      try {
        mv = chess.move(moves[i]);
      } catch {
        stop = "illegal";
        break;
      }
      if (!mv) {
        stop = "illegal";
        break;
      }
      walked++;
      const afterFen = normalizeFen(chess.fen());
      const afterIx = lookupIndex(idx, hashFen(afterFen));

      if (afterIx < 0) {
        // No eval for this position — not servable and we can't classify the
        // move. Stop here (don't record the gap position).
        stop = "gap";
        gapStops++;
        break;
      }

      if (markBit(afterIx)) discoveredCount++; // eval-backed position pre-mistake
      const afterScore = decodeScore(idx.evals[afterIx]);

      if (beforeScore !== null) {
        const isWhiteMove = (i % 2) === 0; // ply 0 = White's move
        const drop = isWhiteMove ? beforeScore - afterScore : afterScore - beforeScore;
        if (drop >= MISTAKE_THRESHOLD) {
          // First mistake — the resulting position is kept, then we stop.
          stop = "mistake";
          mistakeStops++;
          break;
        }
      }
      beforeScore = afterScore;
    }

    walkedPlies += walked;
    if (stop === "end") {
      if (limit === MAX_PLY) maxPlyStops++;
      else endStops++;
    }
  }

  clearInterval(timer);

  // Stop decompression early if we hit MAX_GAMES.
  try {
    fileStream.destroy();
    zstd.kill("SIGTERM");
  } catch {}

  // Final incremental save.
  flush();

  printProgress();

  const elapsed = Date.now() - startTime;
  const discarded = possiblePlies - walkedPlies;
  const discardPct = possiblePlies ? ((discarded / possiblePlies) * 100).toFixed(1) : "0";
  console.log(`\nDone in ${fmtDuration(elapsed)}`);
  console.log(`Games seen      : ${fmtCount(games)}`);
  console.log(`  filtered out (non blitz/rapid/classical): ${fmtCount(filteredOut)}`);
  console.log(`  skipped (no moves): ${fmtCount(skipped)}`);
  console.log(`Unique positions: ${fmtCount(discoveredCount)} (${discoveredCount})`);
  console.log(`Stop reasons    : mistake ${fmtCount(mistakeStops)}, gap ${fmtCount(gapStops)}, ` +
    `max-ply ${fmtCount(maxPlyStops)}, game-end ${fmtCount(endStops)}`);
  console.log(`Plies possible  : ${fmtCount(possiblePlies)}`);
  console.log(`Plies walked    : ${fmtCount(walkedPlies)}`);
  console.log(`Plies discarded by early-stop: ${fmtCount(discarded)} (${discardPct}%)`);
  console.log(`\nOutput: ${output} (${(statSync(output).size / 1e6).toFixed(2)} MB) | checkpoint: ${ckptPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
