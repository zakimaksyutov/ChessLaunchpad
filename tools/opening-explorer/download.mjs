/**
 * Extracts the Lumbra's Giga Base OTB Elite .7z archive.
 * Run mega-download.mjs first to fetch data/elite.7z.
 * See precomputed-opening-explorer-spec.md for source details.
 *
 * Output: data/<extracted>.pgn
 */
import { existsSync, mkdirSync, readdirSync, chmodSync } from "fs";
import Seven from "node-7z";
import sevenBin from "7zip-bin";
import path from "path";

const DATA_DIR = path.resolve(import.meta.dirname, "data");
const ARCHIVE_PATH = path.join(DATA_DIR, "elite.7z");

async function download() {
  if (existsSync(ARCHIVE_PATH)) {
    console.log("Archive already present, skipping download.");
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  console.error(
    "ERROR: elite.7z not found in data/.\n" +
    "Run mega-download.mjs first to fetch from MEGA:\n\n" +
    "  node mega-download.mjs\n"
  );
  process.exit(1);
}

async function extract() {
  // Check if we already have a .pgn
  const existing = readdirSync(DATA_DIR).filter((f) => f.endsWith(".pgn"));
  if (existing.length > 0) {
    console.log(`PGN already extracted: ${existing[0]}`);
    return path.join(DATA_DIR, existing[0]);
  }

  console.log("Extracting archive...");
  chmodSync(sevenBin.path7za, 0o755);
  return new Promise((resolve, reject) => {
    const stream = Seven.extractFull(ARCHIVE_PATH, DATA_DIR, {
      $bin: sevenBin.path7za,
    });
    stream.on("end", () => {
      const pgns = readdirSync(DATA_DIR).filter((f) => f.endsWith(".pgn"));
      if (pgns.length === 0) reject(new Error("No PGN found after extraction"));
      else {
        console.log(`Extracted: ${pgns[0]}`);
        resolve(path.join(DATA_DIR, pgns[0]));
      }
    });
    stream.on("error", reject);
  });
}

async function main() {
  await download();
  const pgnPath = await extract();
  console.log(`\nPGN ready at: ${pgnPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
