import { Chess } from 'chess.js';

export function normalizeFenResetHalfmoveClock(fen: string): string {
    // We use FEN as a key. And in order to be able to jump from one variant to another, we need to reset halfmove clock.
    // This clock is used to determine if a draw can be claimed by the fifty-move rule. Since this app focuses on openings - it is not relevant.
    // Example:
    // 1. e4 c5 2. Nf3 e6  3. d4 cxd4 4. Nxd4 Nc6 => r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 1 5
    // 1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e6  => r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 0 5
    // Reset halfmove clock so transpositions match despite 50-move counter differences.
    const parts = fen.split(' ');
    parts[4] = "0"; // parts[4] is the halfmove clock field
    return parts.join(' ');
}

export function isLikelyFen(value: string): boolean {
    // Heuristic check: FENs have 6 space-delimited fields and 8 ranks in the piece placement.
    // This avoids false positives on normal opening-name text while staying lightweight.
    const trimmed = value.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 6) {
        return false;
    }
    const ranks = parts[0].split('/');
    return ranks.length === 8;
}

export function buildNormalizedFensFromPgn(pgn: string): string[] {
    const chess = new Chess();
    try {
        chess.loadPgn(pgn);
    } catch {
        return [];
    }
    chess.deleteComments();

    const moves = chess.history({ verbose: true });
    const temp = new Chess();
    const fens: string[] = [normalizeFenResetHalfmoveClock(temp.fen())];

    for (const move of moves) {
        temp.move(move);
        fens.push(normalizeFenResetHalfmoveClock(temp.fen()));
    }

    return Array.from(new Set(fens));
}
