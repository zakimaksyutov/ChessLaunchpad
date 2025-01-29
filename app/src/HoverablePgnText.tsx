import React, { useMemo } from 'react';
import { Chess, Move } from 'chess.js';

// Each halfmove token: "1. d4" or "d5" etc.
interface MoveToken {
    text: string;  // e.g. "1. d4" or "d5"
    fen: string;   // FEN after that move is played
}

interface HoverablePgnTextProps {
    pgn: string;
    onHoverMove?: (fen: string) => void; // Called when user hovers a particular halfmove
    onLeavePgn?: () => void; // Called when user leaves the PGN text entirely
}

/**
 * Parses a PGN using chess.js, then splits it into halfmove tokens with move numbers.
 * Example result for "1. d4 d5 2. e3 Nf6":
 *  tokens[0] = { text: "1. d4", fen: "<FEN after d4>" }
 *  tokens[1] = { text: "d5",     fen: "<FEN after d5>" }
 *  tokens[2] = { text: "2. e3",  fen: "<FEN after e3>" }
 *  tokens[3] = { text: "Nf6",    fen: "<FEN after Nf6>" }
 */
function parsePgnWithMoveNumbers(pgn: string): MoveToken[] {
    const tokens: MoveToken[] = [];

    const chess = new Chess();
    chess.loadPgn(pgn);

    // We'll gather the full move list from the loaded game
    const movesVerbose = chess.history({ verbose: true }) as Move[];

    // Another Chess instance to replay moves one by one:
    const temp = new Chess();
    let moveNumber = 1;

    for (let i = 0; i < movesVerbose.length; i++) {
        const isWhiteMove = i % 2 === 0;
        const move = movesVerbose[i];

        // Build label: "1. d4" for white, "d5" for black
        let label = '';
        if (isWhiteMove) {
            label = `${moveNumber}. ${move.san}`;
        } else {
            label = move.san;
            moveNumber++;
        }

        // Rebuild up to this move to get its resulting FEN
        temp.reset();
        for (let j = 0; j <= i; j++) {
            temp.move(movesVerbose[j]);
        }

        tokens.push({ text: label, fen: temp.fen() });
    }

    return tokens;
}

const HoverablePgnText: React.FC<HoverablePgnTextProps> = ({
    pgn,
    onHoverMove,
    onLeavePgn,
}) => {
    const moveTokens: MoveToken[] = useMemo(() => parsePgnWithMoveNumbers(pgn), [pgn]);

    return (
        <span
            style={{ cursor: 'default' }}
            onMouseLeave={() => {
                // Once the mouse leaves the entire PGN area:
                if (onLeavePgn) onLeavePgn();
            }}
        >
            {moveTokens.length === 0
                ? pgn // fallback if parse failed
                : moveTokens.map((token, idx) => (
                    <span
                        key={idx}
                        style={{ marginRight: 6 }}
                        onMouseEnter={() => {
                            // on hover, notify parent with the FEN
                            if (onHoverMove) onHoverMove(token.fen);
                        }}
                    >
                        {token.text}{' '}
                    </span>
                ))}
        </span>
    );
};

export default HoverablePgnText;