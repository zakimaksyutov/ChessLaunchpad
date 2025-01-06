// filepath: src/Chessboard.tsx
import React, { useEffect, useRef, useState } from 'react';
import { Chessground } from 'chessground';
import { Config } from 'chessground/config';
import { Api } from 'chessground/api';
import { Key } from 'chessground/types';
import { Chess, Square, Move } from "chess.js";
import { OpeningVariant } from './OpeningVariant';
import { LaunchpadLogic } from './LaunchpadLogic';
import './Chessboard.css';

// Copied from chessground/assets, version 9.1.1. Must be updated upon version upgrade.
import './styles/chessground.base.css';
import './styles/chessground.brown.css';
import './styles/chessground.cburnett.css';

// Create Audio objects for move/capture/error/success sounds
const soundMove = new Audio('./sound/move.mp3');
const soundCapture = new Audio('./sound/capture.mp3');
const soundError = new Audio('./sound/error.mp3');
const soundSuccess = new Audio('./sound/energy.mp3');

interface ChessboardProps {
    variants: OpeningVariant[];
    onCompletion: () => void;
    orientation: 'white' | 'black';
}

const Chessboard: React.FC<ChessboardProps> = ({ variants, onCompletion, orientation }) => {

    // We'll reference the HTML container via a ref
    const boardRef = useRef<HTMLDivElement | null>(null);

    // Store a reference to the chessground instance (optional)
    const chessgroundInstance = useRef<Api | null>(null);

    // Stores a current state of the chessboard
    const chess = new Chess();

    // State to store the current PGN
    const [pgn, setPgn] = useState<string>('');

    const logic = new LaunchpadLogic(variants);

    // This ref will help us prevent running the effect twice in Strict Mode
    const didInit = useRef(false);

    const [applicableVariants, setApplicableVariants] = useState<OpeningVariant[]>([]);

    /* eslint-disable react-hooks/exhaustive-deps */
    useEffect(() => {
        if (!boardRef.current) {
            return;
        }

        // Only run if we haven't already
        if (didInit.current) {
            return;
        }
        didInit.current = true;

        // Configuration object for Chessground (strongly typed!)
        const config: Config = {
            orientation: orientation,
            turnColor: chess.turn() === 'w' ? 'white' : 'black',
            highlight: {
                lastMove: true,
                check: true,
            },
            movable: {
                free: false,
                color: chess.turn() === 'w' ? 'white' : 'black',
                dests: generateMovesMap(chess),
                events: {
                    after: (orig: string, dest: string, metadata: any) => {
                        movePlayed(orig, dest, metadata, false);
                    }
                }
            },
        };

        // Initialize Chessground
        chessgroundInstance.current = Chessground(boardRef.current, config);
    
        // If we're playing black - then auto-play the first white move.
        if (orientation === 'black') {
            scheduleToPlayNextMove(chess);
        }

        return () => {
            // Register cleanup logic here if needed
        };
    }, []);
    /* eslint-enable react-hooks/exhaustive-deps */

    const movePlayed = (orig: string, dest: string, metadata: any, isLastMoveAutoplayed: boolean) => {

        const chessTestMove = new Chess();
        chessTestMove.loadPgn(chess.pgn());
        const move: Move = chessTestMove.move({ from: orig, to: dest })!;

        if (!logic.isValidVariant(chessTestMove.fen())) {
            // There is no such variant. Play an error sound and revert the move.
            playSound(soundError);
            updateChessground(chess);
            logic.markError(chess.fen());
            return;
        }

        var isEndOfVariant = logic.isEndOfVariant(chessTestMove.fen(), chessTestMove.history().length);

        // Play a corresponding sound.
        if (isEndOfVariant) {
            playSound(soundSuccess);
        } else if (move.captured) {
            playSound(soundCapture);
        } else {
            playSound(soundMove);
        }

        // Update internal position
        chess.move({ from: orig, to: dest });

        // Update the PGN state
        setPgn(chess.pgn());
        updateChessground(chess);

        if (isEndOfVariant) {
            logic.completeVariant(chess.fen());

            // Notify parent component that the variant is complete
            onCompletion();
        } else if (!isLastMoveAutoplayed) {
            // Auto-play next move
            scheduleToPlayNextMove(chess);
        }
    }

    const playSound = (sound: HTMLAudioElement): void => {
        sound.play().catch((error) => {
            if (error.name === 'NotAllowedError') {
                console.warn('Sound playback was blocked by the browser. This is expected if the sound is not triggered by a user action.');
                return;
            } else if (error.name === 'NotSupportedError') {
                console.warn('Playing sound is not supported.');
                return;
            }
            throw error;
        });
    }

    const scheduleToPlayNextMove = (chess: Chess) => {
        setTimeout(() => {
            playNextMove(chess);
        }, 750); // Delay before playing the next move
    }

    const playNextMove = (chess: Chess) => {
        const move = logic.getNextMove(chess.fen(), chess.history().length);

        setApplicableVariants(logic.getApplicableVariants(chess.fen(), chess.history().length));

        movePlayed(move.from, move.to, {}, true);
    }

    const updateChessground = (chess: Chess) => {
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
        <div>
            <div
                ref={boardRef}
                style={{
                    width: '100%',
                    maxWidth: 800,
                    height: 'auto',
                    aspectRatio: '1 / 1',
                    border: '1px solid #ccc'
                }}
            />
            <div style={{ marginTop: '10px' }}>
                <strong>{pgn}</strong>
            </div>
            <div style={{ marginLeft: '20px' }}>
                <table className="table">
                    <thead>
                        <tr>
                            <th className="th">pgn</th>
                            <th className="th">#</th>
                            <th className="th">EMA</th>
                            <th className="th">last</th>
                            <th className="th">rf</th>
                            <th className="th">ff</th>
                            <th className="th">ef</th>
                            <th className="th">w</th>
                            <th className="th">wp</th>
                        </tr>
                    </thead>
                    <tbody>
                        {applicableVariants.map((variant, index) => (
                            <tr key={index} className={variant.isPicked ? 'highlight' : ''}>
                                <td className="td">{variant.pgn}</td>
                                <td className="td">{variant.numberOfTimesPlayed}</td>
                                <td className="td">{Math.round(variant.errorEMA * 100) / 100}</td>
                                <td className="td">{variant.lastSucceededEpoch}</td>
                                <td className="td">{Math.round(variant.recencyFactor * 100) / 100}</td>
                                <td className="td">{Math.round(variant.frequencyFactor * 100) / 100}</td>
                                <td className="td">{Math.round(variant.errorFactor * 100) / 100}</td>
                                <td className="td">{Math.round(variant.weight * 100) / 100}</td>
                                <td className="td">{Math.round(variant.weightedProbability * 10000) / 100}%</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default Chessboard;