export interface DatabaseOpening {
    eco: string;
    name: string;
    pgn: string;
}

export class DatabaseOpeningsUtils {

    public static async DownloadOpenings(): Promise<DatabaseOpening[]> {
        try {
            const response = await fetch('/openings.tsv');
            if (!response.ok) {
                throw new Error(`Failed to fetch openings.tsv: ${response.statusText}`);
            }

            // openings.tsv is a plain text TSV file
            const tsvText = await response.text();

            // Split by lines (handle Windows or Unix line endings)
            const lines = tsvText.split(/\r?\n/);

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

            console.log('Loaded database openings:', parsedOpenings.length);

            return parsedOpenings;

        } catch (error) {
            console.error('Error while downloading or parsing openings:', error);
            throw error;
        }
    }
}