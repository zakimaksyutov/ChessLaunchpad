import React, { useEffect, useRef } from 'react';
import { Chessground } from 'chessground';
import { Config } from 'chessground/config';
import { Api } from 'chessground/api';
import { Key } from 'chessground/types';
import { Chess, Square } from "chess.js";
import './ChessboardControl.css';

// Copied from chessground/assets, version 9.1.1. Must be updated upon version upgrade.
import './styles/chessground.base.css';
import './styles/chessground.brown.css';
import './styles/chessground.cburnett.css';

interface TrainingPageControlProps {
    roundId: string,
    fen: string;
    orientation: 'white' | 'black';
    movePlayed: (orig: string, dest: string) => boolean;
}

const ChessboardControl: React.FC<TrainingPageControlProps> = ({ roundId, fen, orientation, movePlayed }) => {

    ////////////////////////////////////////////
    // React References
    const boardRef = useRef<HTMLDivElement | null>(null); // Board container reference
    const chessgroundInstance = useRef<Api | null>(null); // Chessground instance reference
    const fenRef = useRef(fen);

    ////////////////////////////////////////////
    // React Effect: Update FEN reference
    useEffect(() => {
        fenRef.current = fen;
    }, [fen]);

    ////////////////////////////////////////////
    // React Effect: Creates Chessground instance
    /* eslint-disable react-hooks/exhaustive-deps */
    useEffect(() => {
        if (!boardRef.current) {
            return;
        }

        // If there was a previous Chessground, destroy it
        if (chessgroundInstance.current) {
            chessgroundInstance.current.destroy();
            chessgroundInstance.current = null;
        }

        // Configuration object for Chessground (strongly typed!)
        const config: Config = {
            orientation: orientation,
            highlight: {
                lastMove: true,
                check: true,
            },
            movable: {
                free: false,
                events: {
                    after: (orig: string, dest: string, _: any) => {
                        const wasValidMove = movePlayed(orig, dest);
                        if (!wasValidMove) {
                            updateChessground();
                        }
                    }
                }
            },
        };

        // Initialize Chessground
        chessgroundInstance.current = Chessground(boardRef.current, config);
        updateChessground();

        // Delay the resize by 0.5 seconds
        // On mobile devices, when user refreshes a training page, the board and touch coordinates are not aligned.
        // This is a workaround to fix the issue.
        setTimeout(() => {
            redrawChessGroundControl();
        }, 500);
        window.addEventListener('resize', redrawChessGroundControl);

        return () => {
            // Cleanup
            window.removeEventListener('resize', redrawChessGroundControl);
        };
    }, [orientation, roundId]);
    /* eslint-enable react-hooks/exhaustive-deps */

    ////////////////////////////////////////////
    // React Effect: Update chess position
    /* eslint-disable react-hooks/exhaustive-deps */
    useEffect(() => {
        updateChessground();
    }, [fen]);
    /* eslint-enable react-hooks/exhaustive-deps */

    const redrawChessGroundControl = () => {
        chessgroundInstance.current?.redrawAll();
    };

    const updateChessground = () => {
        const chess: Chess = new Chess(fenRef.current);
        chessgroundInstance.current?.set({
            fen: chess.fen(),
            turnColor: chess.turn() === 'w' ? 'white' : 'black',
            movable: {
                color: chess.turn() === 'w' ? 'white' : 'black',
                dests: generateMovesMap(chess),
            },
        });
    }

    // Generate a map of valid moves for Chessground
    const generateMovesMap = (chess: Chess): Map<Key, Key[]> => {
        const movesMap: Map<Key, Key[]> = new Map();

        // Loop through all squares of the board
        const squares: Key[] = [
            "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8",
            "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8",
            "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8",
            "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8",
            "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8",
            "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8",
            "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8",
            "h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8",
        ];

        for (const square of squares) {
            // Get legal moves starting from this square
            const moves = chess.moves({ square: square as Square, verbose: true });

            // Extract destination squares
            const destinations = moves.map((move) => move.to);

            // Add to the map if there are valid moves
            if (destinations.length > 0) {
                movesMap.set(square, destinations);
            }
        }

        return movesMap;
    };

    return (
        <div className="my-custom-board"
            ref={boardRef}
            style={{
                width: '100%',
                maxWidth: 700,
                height: 'auto',
                aspectRatio: '1 / 1',
                border: '1px solid #ccc'
            }} />
    );
};

export default ChessboardControl;