import React, { useMemo, useState } from 'react';
import { Chess, Move } from 'chess.js';
import { EvalDrop, EvalDropCategory } from './EvalDropService';

// Each halfmove token: "1. d4" or "d5" etc.
interface MoveToken {
    text: string;       // e.g. "1. d4" or "d5"
    fen: string;        // FEN after that move is played
    previousFen: string; // FEN before that move is played
    san: string;        // SAN of the move (e.g. "d4")
}

interface PgnControlProps {
    pgn: string;
    onLeavePgn?: () => void; // Called when user leaves the PGN text entirely
    onClickMove?: (fen: string, previousFen: string, moveSan: string, anchorRect: DOMRect) => void;
    onRightClickMove?: (fen: string, event: React.MouseEvent) => void; // Called when user right-clicks a particular halfmove
    selectedFen?: string | null; // If this half-move is selected
    evalDrops?: Map<string, EvalDrop>; // Optional eval-drop data for move highlighting
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
    chess.deleteComments(); // This control only visualizes moves, comments will break the logic.

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

        const previousFen = temp.fen();
        // Rebuild up to this move to get its resulting FEN
        temp.move(movesVerbose[i]);

        tokens.push({ text: label, fen: temp.fen(), previousFen, san: move.san });
    }

    return tokens;
}

const EVAL_DROP_COLORS: Record<EvalDropCategory, string> = {
    ok: 'transparent',
    inaccuracy: '#fff3cd',   // soft yellow
    mistake: '#f8d7da',      // soft red
    blunder: '#e2d4f0',      // soft purple
};

const PgnControl: React.FC<PgnControlProps> = ({
    pgn,
    onLeavePgn,
    onClickMove,
    selectedFen,
    onRightClickMove,
    evalDrops
}) => {
    const moveTokens: MoveToken[] = useMemo(() => parsePgnWithMoveNumbers(pgn), [pgn]);
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

    return (
        <span
            style={{ cursor: 'default' }}
        >
            {moveTokens.length === 0
                ? pgn // fallback if parse failed
                : moveTokens.map((token, idx) => {
                    const isHovered = (hoveredIndex === idx);
                    const isSelected = (selectedFen === token.fen);

                    // Eval-drop background (if data available)
                    const evalDrop = evalDrops?.get(token.fen);
                    const evalBg = evalDrop ? EVAL_DROP_COLORS[evalDrop.category] : 'transparent';

                    const backgroundColor = isHovered ? 'blue' : (isSelected ? 'lightblue' : evalBg);
                    const color = isHovered ? 'white' : 'black';

                    return (
                        <span
                            key={idx}
                            style={{
                                cursor: 'pointer',
                                backgroundColor,
                                color,
                                borderRadius: evalDrop && evalDrop.category !== 'ok' ? '3px' : undefined,
                                padding: evalDrop && evalDrop.category !== 'ok' ? '1px 2px' : undefined,
                            }}
                            onMouseEnter={() => {
                                setHoveredIndex(idx);
                            }}
                            onMouseLeave={() => {
                                setHoveredIndex(null)
                                if (onLeavePgn) onLeavePgn();
                            }}
                            onClick={(e) => {
                                if (onClickMove) {
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    onClickMove(token.fen, token.previousFen, token.san, rect);
                                }
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                onRightClickMove?.(token.fen, e);
                            }}
                        >
                            {token.text}{' '}
                        </span>
                    );
                })}
        </span>
    );
};

export default PgnControl;