// filepath: src/Chessboard.tsx
import React, { useEffect, useRef, useState, useMemo } from 'react';
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

const soundMoveFile = require('./assets/move.mp3');
const soundCaptureFile = require('./assets/capture.mp3');
const soundErrorFile = require('./assets/error.mp3');
const soundSuccessFile = require('./assets/energy.mp3');

// Create Audio objects for move/capture/error/success sounds
const soundMove = new Audio(soundMoveFile);
const soundCapture = new Audio(soundCaptureFile);
const soundError = new Audio(soundErrorFile);
const soundSuccess = new Audio(soundSuccessFile);

interface ChessboardProps {
    variants: OpeningVariant[];
    onCompletion: () => void;
    onLoadNext: () => void;
    orientation: 'white' | 'black';
}

const Chessboard: React.FC<ChessboardProps> = ({ variants, onCompletion, onLoadNext, orientation }) => {

    ////////////////////////////////////////////
    // React References
    const boardRef = useRef<HTMLDivElement | null>(null); // Board container reference
    const chessgroundInstance = useRef<Api | null>(null); // Chessground instance reference
    const timeoutRef = useRef<NodeJS.Timeout | null>(null); // Timeout reference for auto-play

    ////////////////////////////////////////////
    // React States
    const [chess, setChess] = useState(() => new Chess()); // Stores a current state of the chessboard
    const [pgn, setPgn] = useState<string>(''); // Game's PGN
    const [autoLoadNext, setAutoLoadNext] = useState<boolean>(false); // Whether to auto-load the next variant
    const [progress, setProgress] = useState<number>(0); // Progress bar till auto-loading
    const [applicableVariants, setApplicableVariants] = useState<OpeningVariant[]>([]); // Applicable variants for the position before the last move

    ////////////////////////////////////////////
    // React Memory
    const logic = useMemo<LaunchpadLogic>(() => new LaunchpadLogic(variants), [variants]);

    ////////////////////////////////////////////
    // React Effect: Full reset when orientation or variants change
    useEffect(() => {
        setChess(new Chess());
        setPgn('');
        setAutoLoadNext(false);
        setProgress(0);
        setApplicableVariants([]);
    }, [orientation, variants]);

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
    }, [chess, orientation]);
    /* eslint-enable react-hooks/exhaustive-deps */

    ////////////////////////////////////////////
    // React Effect: Reacts to autoLoadNext state & progresses the progress bar
    useEffect(() => {
        let interval: NodeJS.Timeout | null = null;

        if (autoLoadNext) {
            interval = setInterval(() => {
                setProgress(prev => {
                    const newVal = prev + 5; // e.g. increment by 5% every 100ms for 2s total
                    if (newVal >= 100) {
                        clearInterval(interval!);
                        onLoadNext();
                        return 100;
                    }
                    return newVal;
                });
            }, 100);
        }

        return () => {
            if (interval) {
                clearInterval(interval);
            }
        };
    }, [autoLoadNext, onLoadNext]);

    const redrawChessGroundControl = () => {
        chessgroundInstance.current?.redrawAll();
    };

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
            handleCompletion();
        } else if (!isLastMoveAutoplayed) {
            // Auto-play next move
            scheduleToPlayNextMove(chess);
        }
    }

    const handleCompletion = () => {
        logic.completeVariant(chess.fen());

        // Notify parent component that the variant is complete
        onCompletion();

        // Set the progress bar for auto-reload
        setAutoLoadNext(true);
        setProgress(0);
    };

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
        // Clear any existing timeout before setting a new one.
        // This is needed because it is run from useEffect and it can run multiple times (strict mode in development)
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }

        timeoutRef.current = setTimeout(() => {
            playNextMove(chess);
            timeoutRef.current = null; // Reset after execution
        }, 750); // Delay before playing the next move
    }

    const playNextMove = (chess: Chess) => {
        const move = logic.getNextMove(chess.fen(), chess.history().length);

        setApplicableVariants(logic.getAllVariants().filter(variant => variant.move !== null));

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
            <div className="my-custom-board"
                ref={boardRef}
                style={{
                    width: '100%',
                    maxWidth: 800,
                    height: 'auto',
                    aspectRatio: '1 / 1',
                    border: '1px solid #ccc'
                }}
            />
            <div className="pgn-container"
                style={{
                    width: '100%',
                    maxWidth: '800px',
                    height: '100px',
                    position: 'relative',
                    overflowY: 'auto',
                    backgroundColor: '#f5f5f5',
                    marginTop: '10px'
                }}
            >
                {/* PGN text in the background */}
                <div style={{ padding: '0.5rem', opacity: autoLoadNext ? 0.4 : 1 }}>
                    <strong>{pgn}</strong>
                </div>

                {/* If auto-loading is active, show a semi-transparent overlay with progress bar */}
                {autoLoadNext && (
                    <div
                        style={{
                            position: 'absolute',
                            top: 0, left: 0, right: 0, bottom: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: 'rgba(0,0,0,0.3)'
                        }}
                    >
                        <div
                            style={{
                                width: '80%',
                                backgroundColor: '#ccc',
                                height: '10px',
                                marginBottom: '1rem',
                                borderRadius: '5px',
                                overflow: 'hidden'
                            }}
                        >
                            <div
                                style={{
                                    width: `${progress}%`,
                                    backgroundColor: 'green',
                                    height: '100%'
                                }}
                            />
                        </div>
                        <button onClick={() => setAutoLoadNext(false)}>
                            Stop Auto-Load
                        </button>
                    </div>
                )}
            </div>
            <div style={{ marginTop: '10px' }}>
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