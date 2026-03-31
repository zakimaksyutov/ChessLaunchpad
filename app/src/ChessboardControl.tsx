import React, { useEffect, useMemo, useRef } from 'react';
import { ChessBoard } from 'chess-control';
import type { Annotation as ChessControlAnnotation, Square as CCSquare } from 'chess-control';
import { Chess, Square } from "chess.js";
import { Annotation } from './Annotation';
import { convertChessControlAnnotationsToInternal, convertInternalToChessControlAnnotations } from './AnnotationUtils';
import './ChessboardControl.css';

const ALL_SQUARES: Square[] = [
    "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8",
    "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8",
    "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8",
    "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8",
    "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8",
    "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8",
    "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8",
    "h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8",
];

interface ChessboardControlProps {
    roundId: string,
    fen: string;
    orientation: 'white' | 'black';
    movePlayed: (orig: string, dest: string) => boolean;
    annotationsChanged?: (fen: string, annotations: Annotation[]) => void;
    annotations?: Annotation[];
}

function getCheckSquare(chess: Chess): CCSquare | undefined {
    if (!chess.isCheck()) return undefined;
    const turn = chess.turn();
    const board = chess.board();
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = board[r][c];
            if (piece && piece.type === 'k' && piece.color === turn) {
                const file = String.fromCharCode(97 + c);
                const rank = String(8 - r);
                return `${file}${rank}` as CCSquare;
            }
        }
    }
    return undefined;
}

function generateLegalMoves(chess: Chess): Map<CCSquare, CCSquare[]> {
    const movesMap = new Map<CCSquare, CCSquare[]>();
    for (const square of ALL_SQUARES) {
        const moves = chess.moves({ square, verbose: true });
        if (moves.length > 0) {
            movesMap.set(square as CCSquare, moves.map(m => m.to as CCSquare));
        }
    }
    return movesMap;
}

function detectMove(prevFen: string, newFen: string): { from: CCSquare; to: CCSquare } | undefined {
    if (prevFen === newFen) return undefined;
    try {
        const prev = new Chess(prevFen);
        const moves = prev.moves({ verbose: true });
        for (const move of moves) {
            const test = new Chess(prevFen);
            test.move(move);
            if (test.fen() === newFen) {
                return { from: move.from as CCSquare, to: move.to as CCSquare };
            }
        }
    } catch {
        // Invalid FEN or position reset — no animation
    }
    return undefined;
}

const ChessboardControl: React.FC<ChessboardControlProps> = ({ roundId, fen, orientation, movePlayed, annotationsChanged, annotations }) => {

    // Refs for tracking state across renders
    const prevFenRef = useRef(fen);
    const prevRoundIdRef = useRef(roundId);
    const prevOrientationRef = useRef(orientation);
    const moveJustPlayedRef = useRef(false);
    const userLastMoveRef = useRef<{ from: CCSquare; to: CCSquare } | undefined>();
    const computedLastMoveRef = useRef<{ from: CCSquare; to: CCSquare } | undefined>();
    const fenRef = useRef(fen);

    const movePlayedRef = useRef(movePlayed);
    useEffect(() => {
        movePlayedRef.current = movePlayed;
    }, [movePlayed]);

    const annotationsChangedRef = useRef(annotationsChanged);
    useEffect(() => {
        annotationsChangedRef.current = annotationsChanged;
    }, [annotationsChanged]);

    useEffect(() => {
        fenRef.current = fen;
    }, [fen]);

    // Compute lastMove synchronously during render so it arrives
    // in the same render pass as the FEN change — prevents the
    // two-render gap that caused jump-back animation artifacts.
    if (prevRoundIdRef.current !== roundId || prevOrientationRef.current !== orientation) {
        prevRoundIdRef.current = roundId;
        prevOrientationRef.current = orientation;
        prevFenRef.current = fen;
        moveJustPlayedRef.current = false;
        userLastMoveRef.current = undefined;
        computedLastMoveRef.current = undefined;
    } else if (prevFenRef.current !== fen) {
        if (moveJustPlayedRef.current) {
            moveJustPlayedRef.current = false;
            computedLastMoveRef.current = userLastMoveRef.current;
        } else {
            computedLastMoveRef.current = detectMove(prevFenRef.current, fen);
        }
        prevFenRef.current = fen;
    }

    const lastMove = computedLastMoveRef.current;

    // Derive board state from FEN
    const chess = useMemo(() => new Chess(fen), [fen]);
    const turnColor = chess.turn() === 'w' ? 'white' : 'black';
    const legalMoves = useMemo(() => generateLegalMoves(chess), [chess]);
    const checkSquare = useMemo(() => getCheckSquare(chess), [chess]);
    const ccAnnotations = useMemo(
        () => convertInternalToChessControlAnnotations(annotations || []),
        [annotations]
    );

    const handleOnMove = (from: CCSquare, to: CCSquare) => {
        const valid = movePlayedRef.current(from, to);
        if (valid) {
            moveJustPlayedRef.current = true;
            userLastMoveRef.current = { from, to };
        }
    };

    const handleAnnotationsChange = (ccAnns: ChessControlAnnotation[]) => {
        if (annotationsChangedRef.current) {
            const internal = convertChessControlAnnotationsToInternal(ccAnns);
            annotationsChangedRef.current(fenRef.current, internal);
        }
    };

    return (
        <div className="chessboard-container"
            style={{
                width: '100%',
                maxWidth: 704,
                height: 'auto',
                aspectRatio: '1 / 1',
            }}>
            <ChessBoard
                fen={fen}
                orientation={orientation}
                turnColor={turnColor}
                legalMoves={legalMoves}
                lastMove={lastMove}
                check={checkSquare}
                onMove={handleOnMove}
                annotations={ccAnnotations}
                onAnnotationsChange={handleAnnotationsChange}
                clearAnnotationsOnClick={false}
                drawingMode="lichess"
            />
        </div>
    );
};

export default ChessboardControl;