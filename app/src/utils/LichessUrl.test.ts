import { describe, it, expect } from 'vitest';
import { buildLichessAnalysisUrl } from './LichessUrl';

describe('buildLichessAnalysisUrl', () => {
    it('encodes the PGN into the /analysis/pgn path and appends the orientation', () => {
        const url = buildLichessAnalysisUrl('1.e4 c6 2.d4 d5', 'black');
        expect(url).toBe(
            'https://lichess.org/analysis/pgn/1.e4%20c6%202.d4%20d5?color=black',
        );
    });

    it('uses the white color param for white orientation', () => {
        const url = buildLichessAnalysisUrl('1.e4 e5', 'white');
        expect(url).toBe('https://lichess.org/analysis/pgn/1.e4%20e5?color=white');
    });

    it('URL-encodes variation parentheses and ellipsis-free black prefixes', () => {
        const url = buildLichessAnalysisUrl('1.e4 (1.d4 d5 2.e4 c6) 1...c6 2.d4 d5', 'black');
        // Decoding the path segment must round-trip to the original PGN.
        const pgn = decodeURIComponent(
            url.replace('https://lichess.org/analysis/pgn/', '').replace('?color=black', ''),
        );
        expect(pgn).toBe('1.e4 (1.d4 d5 2.e4 c6) 1...c6 2.d4 d5');
    });
});
