import { Chess } from 'chess.js';

export function normalizeFenResetHalfmoveClock(fen: string): string {
    const parts = fen.split(' ');
    
    // We use FEN as a key. And in order to be able to jump from one variant to another, we need to reset halfmove clock.
    // This clock is used to determine if a draw can be claimed by the fifty-move rule. Since this app focuses on openings - it is not relevant.
    // Example:
    // 1. e4 c5 2. Nf3 e6  3. d4 cxd4 4. Nxd4 Nc6 => r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 1 5
    // 1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e6  => r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 0 5
    // Reset halfmove clock so transpositions match despite 50-move counter differences.
    parts[4] = "0"; // parts[4] is the halfmove clock field

    // We also use FEN to find a position. Another variance - we can reach the same position using different move order resulting in different number of moves.
    // Example:
    // 1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 e5 6. Ndb5 d6 7. Bg5 a6 8. Na3 b5 9. Nd5 Be7 10. Bxf6 Bxf6 11. c3
    //      => r1bqk2r/5ppp/p1np1b2/1p1Np3/4P3/N1P5/PP3PPP/R2QKB1R b KQkq - 0 11
    // 1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 e6 6. Ndb5 d6 7. Bf4 e5 8. Bg5 a6 9. Na3 b5 10. Nd5 Be7 11. Bxf6 Bxf6 12. c3
    //      => r1bqk2r/5ppp/p1np1b2/1p1Np3/4P3/N1P5/PP3PPP/R2QKB1R b KQkq - 0 12
    // Reset fullmove clock so it would be possible to find both variants using either FEN
    parts[5] = "1"; // parts[5] is the fullmove clock field

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
