import React, { useEffect, useRef, useState, useMemo } from 'react';
import ChessboardControl from './ChessboardControl';
import { Chess, Move } from "chess.js";
import { OpeningVariant } from './OpeningVariant';
import { LaunchpadLogic } from './LaunchpadLogic';
import PgnControl from './PgnControl';
import './TrainingPageControl.css';

const soundMoveFile = require('./assets/move.mp3');
const soundCaptureFile = require('./assets/capture.mp3');
const soundErrorFile = require('./assets/error.mp3');
const soundSuccessFile = require('./assets/energy.mp3');

// Create Audio objects for move/capture/error/success sounds
const soundMove = new Audio(soundMoveFile);
const soundCapture = new Audio(soundCaptureFile);
const soundError = new Audio(soundErrorFile);
const soundSuccess = new Audio(soundSuccessFile);

interface TrainingPageControlProps {
    variants: OpeningVariant[];
    onCompletion: () => void;
    onLoadNext: () => void;
    orientation: 'white' | 'black';
}

// Table visibility states
const TABLE_HIDDEN = 0;
const TABLE_SELECTED_ONLY = 1;
const TABLE_FULL = 2;

const TrainingPageControl: React.FC<TrainingPageControlProps> = ({ variants, onCompletion, onLoadNext, orientation }) => {

    const ANNOTATION_DELAY_BASE_IN_MS = 200;
    const ANNOTATION_DELAY_GROWTH = 1.35;

    ////////////////////////////////////////////
    // React References
    const timeoutRef = useRef<NodeJS.Timeout | null>(null); // Timeout reference for auto-play

    ////////////////////////////////////////////
    // React States
    const [pgn, setPgn] = useState<string>(''); // Game's PGN
    const [fen, setFen] = useState<string>(() => new Chess().fen()); // Game's FEN
    const [autoLoadNext, setAutoLoadNext] = useState<boolean>(false); // Whether to auto-load the next variant
    const [progress, setProgress] = useState<number>(0); // Progress bar till auto-loading
    const [applicableVariants, setApplicableVariants] = useState<OpeningVariant[]>([]); // Applicable variants for the position before the last move
    const [roundId, setRoundId] = useState<string>(''); // ID of the current round
    const [tableVisibility, setTableVisibility] = useState<number>(TABLE_HIDDEN); // Table visibility state

    ////////////////////////////////////////////
    // React Memory
    const logic = useMemo<LaunchpadLogic>(() => new LaunchpadLogic(variants), [variants]);
    const chess = useMemo(() => new Chess(), []);

    ////////////////////////////////////////////
    // React Effect: Handle keyboard shortcuts for debugging
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            // Check for Ctrl+Alt+D
            if (event.ctrlKey && event.altKey && event.key === 'd') {
                setTableVisibility(prev => (prev + 1) % 3); // Cycle through 0, 1, 2
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, []);

    ////////////////////////////////////////////
    // React Effect: Full reset when orientation or variants change
    /* eslint-disable react-hooks/exhaustive-deps */
    useEffect(() => {
        chess.reset();
        setPgn('');
        setFen(chess.fen());
        setAutoLoadNext(false);
        setProgress(0);
        setApplicableVariants([]);

        // Generate a new ID for the round
        setRoundId(Math.random().toString(36).substring(7));

        // If playing black, schedule the first white move automatically
        if (orientation === 'black') {
            scheduleToPlayNextMove(chess);
        }

        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        }
    }, [orientation, variants]);
    /* eslint-enable react-hooks/exhaustive-deps */

    ////////////////////////////////////////////
    // React Effect: Reacts to autoLoadNext state & progresses the progress bar
    useEffect(() => {
        let interval: NodeJS.Timeout | null = null;

        if (autoLoadNext) {
            // We auto-play in 5 seconds if there were errors, otherwise in 1 second
            let durationMilliseconds = logic.hadErrors() ? 5000 : 1000;

            // We also give extra time per annotation
            const annotations = logic.getAnnotations(chess.fen());
            durationMilliseconds += getAnnotationDelayMilliseconds(annotations);

            const stepMilliseconds = 100;
            const numberOfSteps = durationMilliseconds / stepMilliseconds;
            const progressBarStepSize = 100 / numberOfSteps;

            interval = setInterval(() => {
                setProgress(prev => {
                    const newVal = prev + progressBarStepSize;
                    if (newVal >= 100) {
                        clearInterval(interval!);
                        onLoadNext();
                        return 100;
                    }
                    return newVal;
                });
            }, stepMilliseconds);
        }

        return () => {
            if (interval) {
                clearInterval(interval);
            }
        };
    }, [autoLoadNext, onLoadNext, logic, chess]);

    const handleMove = (orig: string, dest: string, isLastMoveAutoplayed: boolean): boolean => {

        const chessTestMove = new Chess();
        chessTestMove.loadPgn(chess.pgn());
        const move: Move = chessTestMove.move({ from: orig, to: dest })!;

        if (!logic.isValidVariant(chessTestMove.fen())) {
            // There is no such variant. Play an error sound and return false to revert the move.
            playSound(soundError);
            logic.markError(chess.fen());
            return false;
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

        // Update the PGN and FEN states
        setPgn(chess.pgn());
        setFen(chess.fen());

        if (isEndOfVariant) {
            handleCompletion();
        } else if (!isLastMoveAutoplayed) {
            // Auto-play next move
            scheduleToPlayNextMove(chess);
        }

        return true;
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

        // If there are annotations then we delay auto-play by extra time per annotation.
        // The idea is that we want to give the user time to follow annotations.
        const annotations = logic.getAnnotations(chess.fen());

        timeoutRef.current = setTimeout(() => {
            playNextMove(chess);
            timeoutRef.current = null; // Reset after execution
        }, 750 + getAnnotationDelayMilliseconds(annotations)); // Delay before playing the next move
    }

    const getAnnotationDelayMilliseconds = (annotations: { dest?: string }[]): number => {
        const annotationCount = annotations.reduce((count, annotation) => count + (annotation.dest ? 1 : 0), 0);
        if (annotationCount === 0) {
            return 0;
        }

        // Geometric series: base * (growth^n - 1) / (growth - 1)
        return ANNOTATION_DELAY_BASE_IN_MS * (Math.pow(ANNOTATION_DELAY_GROWTH, annotationCount) - 1) / (ANNOTATION_DELAY_GROWTH - 1);
    }

    const playNextMove = (chess: Chess) => {
        const move = logic.getNextMove(chess.fen(), chess.history().length);

        setApplicableVariants(logic.getAllVariants().filter(variant => variant.move !== null));

        handleMove(move.from, move.to, true);
    }

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            width: '100%',
            maxWidth: '100%'
        }}>
            {(() => {
                const annotations = logic.getAnnotations(fen);

                return (
                    <ChessboardControl
                        roundId={roundId}
                        fen={fen}
                        orientation={orientation}
                        movePlayed={(orig, dest) => handleMove(orig, dest, false)}
                        annotations={annotations}
                    />
                );
            })()}
            <div className="pgn-container"
                style={{
                    width: '100%',
                    maxWidth: '704px',
                    height: '100px',
                    position: 'relative',
                    overflowY: 'auto',
                    backgroundColor: '#f5f5f5',
                    margin: '10px auto'
                }}
            >
                {/* PGN text in the background */}
                <div style={{ padding: '0.5rem', opacity: autoLoadNext ? 0.4 : 1 }}>
                    <PgnControl pgn={pgn} />
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
            {tableVisibility !== TABLE_HIDDEN && (
                <div className="table-container">
                    <table className="table">
                        <thead>
                            <tr>
                                <th className="th">pgn</th>
                                <th className="th">#</th>
                                <th className="th">_nf</th>
                                <th className="th">_rf</th>
                                <th className="th">_ff</th>
                                <th className="th">_ef</th>
                                <th className="th">_w</th>
                                <th className="th">_wp</th>
                            </tr>
                        </thead>
                        <tbody>
                            {applicableVariants
                                .filter(variant => tableVisibility === TABLE_FULL || 
                                                 (tableVisibility === TABLE_SELECTED_ONLY && variant.isPicked))
                                .map((variant, index) => (
                                    <tr key={index} className={variant.isPicked ? 'highlight' : ''}>
                                        <td className="td">{variant.pgnWithoutAnnotations}</td>
                                        <td className="td">{variant.numberOfTimesPlayed}</td>
                                        <td className="td">{Math.round(variant.newnessFactor * 100) / 100}</td>
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
            )}
        </div>
    );
};

export default TrainingPageControl;
