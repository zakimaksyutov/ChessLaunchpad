/**
 * Look up raw eval data for a specific FEN from the Lichess cloud eval DB.
 *
 * Streams the compressed JSONL through zstd, matching against the target FEN.
 * Uses compact FEN (3 fields) for matching, same as the artifact pipeline.
 *
 * Usage:
 *   node lookup-fen.mjs "<FEN>"
 *   node lookup-fen.mjs --db <path-to-zst> "<FEN>"
 *
 * Examples:
 *   node lookup-fen.mjs "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
 *   node lookup-fen.mjs "1k1r3r/3bbp1p/pqnppp2/1p6/4PP2/2NB1N2/PPPQ2PP/1K1RR3 w - - 6 15"
 */
import { spawn } from "child_process";
import { createInterface } from "readline";
import { existsSync, readdirSync } from "fs";
import path from "path";

const DATA_DIR = path.resolve(import.meta.dirname, "data");

function toCompactFen(fen) {
  return fen.split(" ").slice(0, 3).join(" ");
}

function parseArgs(argv) {
  let dbPath = null;
  let fen = null;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--db" && argv[i + 1]) {
      dbPath = argv[++i];
    } else if (argv[i].startsWith("--db=")) {
      dbPath = argv[i].slice("--db=".length);
    } else if (!argv[i].startsWith("--")) {
      fen = argv[i];
    }
  }

  if (!dbPath) {
    // Auto-detect .zst file in data/
    const zstFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith(".jsonl.zst"));
    if (zstFiles.length === 1) {
      dbPath = path.join(DATA_DIR, zstFiles[0]);
    } else if (zstFiles.length > 1) {
      console.error("Multiple .jsonl.zst files found in data/. Use --db to specify one.");
      process.exit(1);
    } else {
      console.error("No .jsonl.zst file found in data/. Use --db to specify the path.");
      process.exit(1);
    }
  }

  if (!fen) {
    console.error('Usage: node lookup-fen.mjs [--db <path>] "<FEN>"');
    process.exit(1);
  }

  if (!existsSync(dbPath)) {
    console.error(`Error: eval DB not found: ${dbPath}`);
    process.exit(1);
  }

  return { dbPath, fen };
}

async function main() {
  const { dbPath, fen } = parseArgs(process.argv);
  const targetCompact = toCompactFen(fen);

  console.log(`Target FEN:     ${fen}`);
  console.log(`Compact FEN:    ${targetCompact}`);
  console.log(`Eval DB:        ${dbPath}`);
  console.log(`\nStreaming... (this may take a while)\n`);

  const zstd = spawn("zstd", ["-d", "-c", dbPath], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  const rl = createInterface({
    input: zstd.stdout,
    crlfDelay: Infinity,
  });

  let lineCount = 0;
  let found = false;
  const startTime = Date.now();

  for await (const line of rl) {
    lineCount++;

    if (lineCount % 5_000_000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      process.stderr.write(`\r  ${(lineCount / 1e6).toFixed(0)}M lines scanned, ${elapsed}s`);
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (!record.fen) continue;

    const recordCompact = toCompactFen(record.fen);
    if (recordCompact !== targetCompact) continue;

    found = true;
    process.stderr.write(`\r  Found at line ${lineCount}\n\n`);

    console.log(`DB FEN:         ${record.fen}`);
    console.log(`Eval entries:   ${record.evals?.length || 0}\n`);

    if (record.evals) {
      // Sort by depth descending
      const sorted = [...record.evals].sort((a, b) => b.depth - a.depth);
      for (const entry of sorted) {
        console.log(`── Depth ${entry.depth} (${entry.knodes?.toLocaleString() || "?"} knodes) ──`);
        if (entry.pvs) {
          for (let j = 0; j < entry.pvs.length; j++) {
            const pv = entry.pvs[j];
            const evalStr = pv.mate !== undefined
              ? `mate ${pv.mate}`
              : `${pv.cp} cp`;
            console.log(`  PV${j + 1}: ${evalStr}  ${pv.line || ""}`);
          }
        }
        console.log();
      }
    }

    // Kill zstd since we found the match
    zstd.kill();
    break;
  }

  if (!found) {
    process.stderr.write(`\n`);
    console.log(`Position not found after scanning ${lineCount.toLocaleString()} lines.`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Time: ${elapsed}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
