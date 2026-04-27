/**
 * Builds an opening tree from master PGN games.
 *
 * Usage: node build-tree.mjs [path-to-pgn]
 *
 * Output: data/opening-tree.json
 *
 * Tree structure (flat map keyed by compact FEN):
 * {
 *   "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq": {
 *     "moves": {
 *       "e5": { "count": 12345, "white": 4100, "draw": 4200, "black": 4045, "eloSum": 30000000 }
 *     }
 *   }
 * }
 *
 * At query time: avgElo = eloSum / count
 */
import { createReadStream } from "fs";
import { writeFile, stat } from "fs/promises";
import { createInterface } from "readline";
import { Chess } from "chess.js";
import path from "path";
import { readdirSync } from "fs";

const MAX_PLY = 30; // 15 moves = 30 half-moves
const MIN_GAMES = parseInt(process.env.MIN_GAMES || "3");
const DATA_DIR = path.resolve(import.meta.dirname, "data");

// ── Compact FEN: strip move counters, en-passant when irrelevant ──
function compactFen(fen) {
  // Full FEN: "pieces side castling ep halfmove fullmove"
  // We keep: pieces, side, castling (skip ep if "-", halfmove, fullmove)
  const parts = fen.split(" ");
  // Keep pieces + side + castling only (ep is positional but rare impact on openings)
  return `${parts[0]} ${parts[1]} ${parts[2]}`;
}

// ── PGN streaming parser ──
// Parses a multi-game PGN file, yielding { headers, moves } per game.
async function* parsePgnStream(filePath) {
  const fileStream = createReadStream(filePath, { encoding: "utf-8", highWaterMark: 256 * 1024 });
  let bytesRead = 0;
  fileStream.on("data", (chunk) => { bytesRead += Buffer.byteLength(chunk); });

  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let headers = {};
  let moveText = "";
  let inMoves = false;

  for await (const line of rl) {
    const trimmed = line.trim();

    if (trimmed.startsWith("[")) {
      if (inMoves && moveText.trim()) {
        yield { headers, moveText: moveText.trim(), bytesRead };
        headers = {};
        moveText = "";
      }
      inMoves = false;
      // Parse header: [Key "Value"]
      const m = trimmed.match(/^\[(\w+)\s+"(.*)"\]$/);
      if (m) headers[m[1]] = m[2];
    } else if (trimmed === "") {
      if (Object.keys(headers).length > 0 && !inMoves) {
        inMoves = true;
      }
    } else {
      inMoves = true;
      moveText += " " + trimmed;
    }
  }

  if (moveText.trim()) {
    yield { headers, moveText: moveText.trim(), bytesRead };
  }
}

// ── Extract SAN moves from movetext ──
function extractMoves(moveText) {
  // Remove comments, variations, NAGs, and result
  let cleaned = moveText
    .replace(/\{[^}]*\}/g, "")       // {comments}
    .replace(/\([^)]*\)/g, "")       // (variations) - single level
    .replace(/\$\d+/g, "")           // $nag
    .replace(/\d+\.\.\./g, "")       // "1..."
    .replace(/\d+\./g, "")           // "1."
    .replace(/1-0|0-1|1\/2-1\/2|\*/g, "") // results
    .trim();

  return cleaned.split(/\s+/).filter((t) => t.length > 0);
}

// ── Parse result ──
function parseResult(result) {
  if (result === "1-0") return "white";
  if (result === "0-1") return "black";
  if (result === "1/2-1/2") return "draw";
  return null;
}

// ── Main ──
async function main() {
  // Find PGN file
  let pgnPath = process.argv[2];
  if (!pgnPath) {
    const pgns = readdirSync(DATA_DIR).filter((f) => f.endsWith(".pgn"));
    if (pgns.length === 0) {
      console.error("No PGN found in data/. Run download.mjs first.");
      process.exit(1);
    }
    pgnPath = path.join(DATA_DIR, pgns[0]);
  }

  const fileSize = (await stat(pgnPath)).size;
  console.log(`Parsing: ${pgnPath} (${(fileSize / 1e6).toFixed(1)} MB)`);

  const tree = new Map();
  let gameCount = 0;
  let skipped = 0;
  const startTime = Date.now();

  for await (const { headers, moveText, bytesRead } of parsePgnStream(pgnPath)) {
    gameCount++;

    if (gameCount % 10000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const posCount = tree.size;
      const pct = ((bytesRead / fileSize) * 100).toFixed(1);
      process.stdout.write(
        `\r  ${pct}% | ${gameCount} games, ${posCount} positions, ${elapsed}s`
      );
    }

    const result = parseResult(headers.Result);
    if (!result) {
      skipped++;
      continue;
    }

    // Average Elo from WhiteElo/BlackElo headers
    const wElo = parseInt(headers.WhiteElo) || 0;
    const bElo = parseInt(headers.BlackElo) || 0;
    const avgElo = wElo && bElo ? Math.round((wElo + bElo) / 2) : 0;

    const moves = extractMoves(moveText);
    const chess = new Chess();

    for (let i = 0; i < moves.length && i < MAX_PLY; i++) {
      const fen = compactFen(chess.fen());

      try {
        const move = chess.move(moves[i]);
        if (!move) break;

        const san = move.san;

        if (!tree.has(fen)) {
          tree.set(fen, { moves: {} });
        }
        const node = tree.get(fen);
        if (!node.moves[san]) {
          node.moves[san] = { count: 0, white: 0, draw: 0, black: 0, eloSum: 0 };
        }
        const stats = node.moves[san];
        stats.count++;
        stats[result]++;
        stats.eloSum += avgElo;
      } catch {
        break; // Invalid move, stop processing this game
      }
    }
  }

  console.log(
    `\n\nDone: ${gameCount} games (${skipped} skipped), ${tree.size} positions`
  );

  // ── Prune positions with < MIN_GAMES ──
  console.log(`Pruning moves with < ${MIN_GAMES} games...`);
  let pruned = 0;
  let removedPositions = 0;

  for (const [fen, node] of tree) {
    for (const [san, stats] of Object.entries(node.moves)) {
      if (stats.count < MIN_GAMES) {
        delete node.moves[san];
        pruned++;
      }
    }
    if (Object.keys(node.moves).length === 0) {
      tree.delete(fen);
      removedPositions++;
    }
  }

  console.log(
    `Pruned ${pruned} moves, removed ${removedPositions} empty positions. Remaining: ${tree.size} positions`
  );

  // ── Serialize (compact format) ──
  // Format: { [fen]: { [san]: [count, white, draw, black, eloSum] } }
  // This saves ~40% vs the verbose { moves: { san: { count, ... } } } format
  const outPath = path.join(DATA_DIR, `opening-tree_${MIN_GAMES}.json`);
  const compact = {};
  for (const [fen, node] of tree) {
    const moves = {};
    for (const [san, s] of Object.entries(node.moves)) {
      moves[san] = [s.count, s.white, s.draw, s.black, s.eloSum];
    }
    compact[fen] = moves;
  }
  const json = JSON.stringify(compact);
  await writeFile(outPath, json);

  const outSize = Buffer.byteLength(json);
  console.log(
    `\nWritten: ${outPath} (${(outSize / 1e6).toFixed(2)} MB)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
