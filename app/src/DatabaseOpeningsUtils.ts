import { Chess } from 'chess.js';

export interface DatabaseOpening {
    eco: string;
    name: string;
    pgn: string;
}

export class DatabaseOpeningsUtils {

    public static ParseOpeningsTsv(tsvContent: string): DatabaseOpening[] {
        // Split by lines (handle Windows or Unix line endings)
        const lines = tsvContent.split(/\r?\n/);

        // The first line is "eco<tab>name<tab>pgn"
        // We'll skip that by slicing from line index 1
        const parsedOpenings: DatabaseOpening[] = lines.slice(1).map((line) => {
            // Each line has 3 columns separated by tab
            const [eco, name, pgn] = line.split('\t');

            // In case some lines might be empty or malformed, handle that:
            if (!eco || !name || !pgn) {
                return null as any; // or skip or handle error
            }

            return { eco, name, pgn };
        }).filter(Boolean); // remove any null or empty lines

        return parsedOpenings;

    }

    public static async DownloadOpenings(): Promise<DatabaseOpening[]> {
        try {
            const response = await fetch(process.env.PUBLIC_URL + '/openings.tsv');
            if (!response.ok) {
                throw new Error(`Failed to fetch openings.tsv: ${response.statusText}`);
            }

            // openings.tsv is a plain text TSV file
            const tsvContent = await response.text();

            const parsedOpenings: DatabaseOpening[] = DatabaseOpeningsUtils.ParseOpeningsTsv(tsvContent);

            console.log('Loaded database openings:', parsedOpenings.length);

            return parsedOpenings;

        } catch (error) {
            console.error('Error while downloading or parsing openings:', error);
            throw error;
        }
    }

    // 1. Start from the full PGN.
    // 2. Check if we have an exact match in `openings`.
    //    - If found and not already in the result, add it as "{eco} {name}".
    // 3. Remove one half-move from the end of the PGN.
    // 4. Repeat until there are no moves left.
    // 
    // The result may contain multiple classifications if the line morphs
    // into a different recognized opening at some truncated point.
    public static ClassifyOpening(pgn: string, openings: DatabaseOpening[]): string[] {
        const results: DatabaseOpening[] = [];

        const chess = new Chess();
        chess.loadPgn(pgn);
        chess.deleteComments(); // We use pgn to match with database openings, need to remove comments first

        // We'll check from the longest line downward.
        // We'll ignore the first white's move since it doesn't add much value to classification.
        for (let i = chess.history().length; i > 1; i--) {
            const currentPgn = chess.pgn();

            // See if it's exactly in our "database"
            const found = openings.find(o => o.pgn === currentPgn);
            if (found) {
                results.push(found);
            }

            // Remove the last half-move
            chess.undo();
        }

        // Sort by name, ignore ECO code
        results.sort((a, b) => a.name.localeCompare(b.name));

        // Remove any entry that is a substring of another entry.
        // E.g., if "French Defense: Classical Variation" is a substring
        // of "French Defense: Classical Variation, Normal Variation", remove the shorter one.
        for (var i: number = results.length - 2; i >= 0; i--) {
            if (results[i + 1].name.startsWith(results[i].name)) {
                results.splice(i, 1);
            }
        }

        // Convert to {eco} {name} format
        return results.map(o => `${o.eco} ${o.name}`);
    }
}