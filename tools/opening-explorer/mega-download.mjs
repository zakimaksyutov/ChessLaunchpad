/**
 * Downloads the Lumbra's Giga Base OTB Elite PGN from MEGA.
 * See precomputed-opening-explorer-spec.md for source details and URL.
 *
 * Usage: node mega-download.mjs [mega-url] [output-path]
 */
import { File } from "megajs";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

const DEFAULT_URL = "https://mega.nz/file/stQXSSDC#VEsidq2EvEgzhJki9ZQJgve3s_6xu7uOYbmS5SD0mw4";
const url = process.argv[2] || DEFAULT_URL;
const outPath = process.argv[3] || "data/elite.7z";

console.log(`Downloading from MEGA...`);
console.log(`URL: ${url}`);
console.log(`Output: ${outPath}`);

const file = File.fromURL(url);
await file.loadAttributes();
console.log(`File: ${file.name} (${(file.size / 1e6).toFixed(1)} MB)`);

const stream = file.download();
let downloaded = 0;
stream.on("data", (chunk) => {
  downloaded += chunk.length;
  const pct = ((downloaded / file.size) * 100).toFixed(1);
  process.stdout.write(`\r  ${pct}% (${(downloaded / 1e6).toFixed(1)} / ${(file.size / 1e6).toFixed(1)} MB)`);
});

await pipeline(stream, createWriteStream(outPath));
console.log("\nDone!");
