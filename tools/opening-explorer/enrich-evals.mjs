/**
 * Enriches the opening tree with engine evaluations from the Lichess Cloud Eval DB,
 * and merges opening names from Lichess TSV files (a–e.tsv).
 *
 * Usage:
 *   node enrich-evals.mjs <opening-tree.json> --eval-db <path-to-zst> --openings <dir> --output <path>
 *
 *   <opening-tree.json>  — path to the opening tree JSON (required)
 *   --eval-db <path>     — path to Lichess cloud eval .jsonl.zst (required)
 *   --openings <dir>     — directory containing a.tsv … e.tsv (required)
 *   --output <path>      — output JSON file path (required)
 *
 * Streams the .jsonl.zst through zstd, matches positions against the opening
 * tree AND named-opening FENs, and writes the public artifact JSON.
 *
 * Output format: { "<compact FEN>": [cp1, cp2] }
 *   - Array of up to 2 centipawn evals from the 2 deepest Stockfish entries.
 *   - Evals: centipawns (integer), or 100000+N for white mate-in-N, -100000-N for black mate-in-N.
 */
import { spawn } from "child_process";
import { createInterface } from "readline";
import { readFileSync, existsSync } from "fs";
import { writeFile } from "fs/promises";
import path from "path";
import { Chess } from "chess.js";

const DATA_DIR = path.resolve(import.meta.dirname, "data");
const PROGRESS_INTERVAL_MS = 10_000;
const ESTIMATED_TOTAL_LINES = 369_000_000;

// ── Arg parsing ──
const TSV_FILES = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"];

function parseArgs(argv) {
  let treePath = null;
  let evalDb = null;
  let openingsDir = null;
  let output = null;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--eval-db" && argv[i + 1]) {
      evalDb = argv[++i];
    } else if (argv[i].startsWith("--eval-db=")) {
      evalDb = argv[i].slice("--eval-db=".length);
    } else if (argv[i] === "--openings" && argv[i + 1]) {
      openingsDir = argv[++i];
    } else if (argv[i].startsWith("--openings=")) {
      openingsDir = argv[i].slice("--openings=".length);
    } else if (argv[i] === "--output" && argv[i + 1]) {
      output = argv[++i];
    } else if (argv[i].startsWith("--output=")) {
      output = argv[i].slice("--output=".length);
    } else if (!argv[i].startsWith("--")) {
      treePath = argv[i];
    }
  }

  const errors = [];
  if (!treePath) errors.push("  <opening-tree.json> is required (positional arg)");
  if (!evalDb) errors.push("  --eval-db <path> is required (Lichess cloud eval .jsonl.zst)");
  if (!openingsDir) errors.push("  --openings <dir> is required (directory with a.tsv … e.tsv)");
  if (!output) errors.push("  --output <path> is required (output JSON file)");

  if (errors.length) {
    console.error("Missing required arguments:\n" + errors.join("\n"));
    console.error("\nUsage: node enrich-evals.mjs <tree.json> --eval-db <path> --openings <dir> --output <path>");
    process.exit(1);
  }

  // Validate files exist
  if (!existsSync(treePath)) {
    console.error(`Error: opening tree not found: ${treePath}`);
    process.exit(1);
  }
  if (!existsSync(evalDb)) {
    console.error(`Error: eval DB not found: ${evalDb}`);
    process.exit(1);
  }
  if (!existsSync(openingsDir)) {
    console.error(`Error: openings directory not found: ${openingsDir}`);
    process.exit(1);
  }
  for (const f of TSV_FILES) {
    const p = path.join(openingsDir, f);
    if (!existsSync(p)) {
      console.error(`Error: missing TSV file: ${p}`);
      process.exit(1);
    }
  }

  return { treePath, evalDb, openingsDir, output };
}

// ── Compact FEN helpers ──
function toCompactFen(fen) {
  const parts = fen.split(" ");
  return `${parts[0]} ${parts[1]} ${parts[2]}`;
}

// ── Load TSV opening FENs via chess.js ──
function loadTsvFens(openingsDir) {
  const fens = new Set();

  for (const file of TSV_FILES) {
    const tsvPath = path.join(openingsDir, file);
    const lines = readFileSync(tsvPath, "utf-8").split("\n");
    let count = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = line.split("\t");
      if (cols.length < 3) continue;

      const pgn = cols[2];

      try {
        const chess = new Chess();
        const moves = pgn.replace(/\d+\.\s*/g, "").trim().split(/\s+/);
        for (const move of moves) {
          chess.move(move);
          fens.add(toCompactFen(chess.fen()));
        }
        count++;
      } catch {
        // skip unparseable lines
      }
    }

    console.log(`  ${file}: ${count} lines → ${fens.size} positions so far`);
  }

  console.log(`  Total unique positions from TSV: ${fens.size}\n`);
  return fens;
}

// ── Extract top 2 evals from a record ──
function extractTopEvals(evals) {
  // Sort entries by depth descending, take top 2
  const sorted = evals
    .filter((e) => e.pvs && e.pvs.length > 0)
    .sort((a, b) => b.depth - a.depth)
    .slice(0, 2);

  if (sorted.length === 0) return null;

  const cpValues = [];
  let maxDepth = 0;
  for (const entry of sorted) {
    const pv = entry.pvs[0];
    let evalScore;
    if (pv.mate !== undefined) {
      evalScore = pv.mate > 0 ? 100000 + pv.mate : -100000 + pv.mate;
    } else if (pv.cp !== undefined) {
      evalScore = pv.cp;
    } else {
      continue;
    }
    cpValues.push(evalScore);
    if (entry.depth > maxDepth) maxDepth = entry.depth;
  }

  if (cpValues.length === 0) return null;
  return { cpValues, maxDepth };
}

// ── Format helpers ──
function formatCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ── Main ──
async function main() {
  const { treePath, evalDb, openingsDir, output } = parseArgs(process.argv);

  // ── Configuration banner ──
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║         Opening Explorer — Enrich Evals         ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log(`Eval DB      : ${evalDb}`);
  console.log(`Opening tree : ${treePath}`);
  for (const f of TSV_FILES) {
    console.log(`Opening names: ${path.join(openingsDir, f)}`);
  }
  console.log(`Output       : ${output}`);
  console.log();

  // Load opening tree keys
  console.log(`Loading opening tree…`);
  const tree = JSON.parse(readFileSync(treePath, "utf-8"));
  const treeKeys = new Set(Object.keys(tree));
  console.log(`  ${treeKeys.size} positions\n`);

  // Load TSV opening FENs
  console.log(`Loading Lichess named openings:`);
  const tsvFens = loadTsvFens(openingsDir);

  // Merge TSV FENs into lookup set
  const lookupKeys = new Set(treeKeys);
  let tsvOnlyCount = 0;
  for (const fen of tsvFens) {
    if (!lookupKeys.has(fen)) {
      lookupKeys.add(fen);
      tsvOnlyCount++;
    }
  }
  console.log(`Total lookup positions: ${lookupKeys.size} (${treeKeys.size} from tree + ${tsvOnlyCount} TSV-only)\n`);

  console.log(`Lichess eval DB: ${evalDb}`);
  console.log(`Estimated ~${formatCount(ESTIMATED_TOTAL_LINES)} lines. Streaming via zstd...\n`);

  // Spawn zstd decompression
  const zstd = spawn("zstd", ["-d", "-c", evalDb], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  const rl = createInterface({
    input: zstd.stdout,
    crlfDelay: Infinity,
  });

  // Track raw evals: { cpValues, maxDepth } per FEN for dedup
  const rawEvals = {};
  let lineCount = 0;
  let matchCount = 0;
  let parseErrors = 0;
  let twoEvalCount = 0;
  let oneEvalCount = 0;
  const startTime = Date.now();
  let lastProgressTime = startTime;

  function printProgress(force = false) {
    const now = Date.now();
    if (!force && now - lastProgressTime < PROGRESS_INTERVAL_MS) return;
    lastProgressTime = now;

    const elapsed = now - startTime;
    const pct = ((lineCount / ESTIMATED_TOTAL_LINES) * 100).toFixed(1) + "%";

    process.stderr.write(
      `${pct} | ${formatCount(lineCount)}/${formatCount(ESTIMATED_TOTAL_LINES)} lines | ${formatCount(matchCount)} matches | ${parseErrors} errors | ${formatElapsed(elapsed)}\n`
    );
  }

  for await (const line of rl) {
    lineCount++;

    if (lineCount % 100_000 === 0) {
      printProgress();
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      parseErrors++;
      const snippet = line.length > 120 ? line.slice(0, 120) + "..." : line;
      console.error(`\nParse error at line ${lineCount}: ${err.message}`);
      console.error(`  Content: ${snippet}`);
      continue;
    }

    if (!record.fen || !record.evals) continue;

    const compactFen = toCompactFen(record.fen);
    if (!lookupKeys.has(compactFen)) continue;

    const evalData = extractTopEvals(record.evals);
    if (!evalData) continue;

    // Keep the record with higher max depth
    if (rawEvals[compactFen]) {
      if (evalData.maxDepth <= rawEvals[compactFen].maxDepth) continue;
    }

    rawEvals[compactFen] = evalData;
    matchCount++;
  }

  // Wait for zstd to exit
  const zstdExitCode = await new Promise((resolve) => zstd.on("close", resolve));

  // Final progress
  printProgress(true);
  const elapsed = Date.now() - startTime;

  console.log(`\n\nDone in ${formatElapsed(elapsed)}`);
  console.log(`Lines processed: ${formatCount(lineCount)}`);
  console.log(`Matches found: ${Object.keys(rawEvals).length} / ${lookupKeys.size} positions`);
  if (parseErrors > 0) console.log(`Parse errors: ${parseErrors}`);
  if (zstdExitCode !== 0) console.log(`Warning: zstd exited with code ${zstdExitCode} (possible data corruption in source file)`);

  // Build output: compactFen → [cp1, cp2] or [cp]
  const results = {};
  for (const [fen, { cpValues }] of Object.entries(rawEvals)) {
    results[fen] = cpValues;
    if (cpValues.length >= 2) twoEvalCount++;
    else oneEvalCount++;
  }

  console.log(`\nEval coverage:`);
  console.log(`  Positions with 2 evals: ${twoEvalCount}`);
  console.log(`  Positions with 1 eval:  ${oneEvalCount}`);

  // Write output
  const json = JSON.stringify(results);
  await writeFile(output, json);
  console.log(`\nWritten: ${output} (${(Buffer.byteLength(json) / 1e6).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
