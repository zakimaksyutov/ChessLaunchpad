import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import ChessboardControl from './ChessboardControl';
import { Chess } from "chess.js";
import { OpeningVariant } from '../models/OpeningVariant';
import { FSRSCardData } from '../models/FSRSCardData';
import { TrainingEngine, EnginePhase } from '../services/TrainingEngine';
import { TraversalStep } from '../services/PathPlanner';
import { Annotation } from '../models/Annotation';
import { extractAnnotations } from '../utils/AnnotationUtils';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import PgnControl from './PgnControl';
import './TrainingPageControl.css';

import soundMoveFile from '../assets/move.mp3';
import soundCaptureFile from '../assets/capture.mp3';
import soundErrorFile from '../assets/error.mp3';
import soundSuccessFile from '../assets/energy.mp3';

const soundMove = new Audio(soundMoveFile);
const soundCapture = new Audio(soundCaptureFile);
const soundError = new Audio(soundErrorFile);
const soundSuccess = new Audio(soundSuccessFile);

interface TrainingPageControlProps {
    variants: OpeningVariant[];
    fsrsCards: Record<string, FSRSCardData>;
    onTraversalComplete: (cardsRated: number, updatedCards: Record<string, FSRSCardData>) => Promise<void>;
    onQueueStats: (stats: { dueCount: number; newCount: number; totalCards: number }) => void;
    onCardRated: () => void;
}

const AUTOPLAY_MOVE_DELAY_MS = 250;
const ANNOTATION_DELAY_BASE_IN_MS = 200;
const ANNOTATION_DELAY_GROWTH = 1.26;

const TrainingPageControl: React.FC<TrainingPageControlProps> = ({
    variants,
    fsrsCards,
    onTraversalComplete,
    onQueueStats,
    onCardRated,
}) => {
    const [fen, setFen] = useState<string>(() => new Chess().fen());
    const [pgn, setPgn] = useState<string>('');
    const [orientation, setOrientation] = useState<'white' | 'black'>('white');
    const [phase, setPhase] = useState<EnginePhase>('idle');
    const [roundId, setRoundId] = useState<string>('');
    const [statusMessage, setStatusMessage] = useState<string>('');
    const [hintAnnotations, setHintAnnotations] = useState<Annotation[]>([]);
    const [pgnAnnotations, setPgnAnnotations] = useState<Annotation[]>([]);

    const timeoutRef = useRef<NodeJS.Timeout | null>(null);
    const chessRef = useRef<Chess>(new Chess());
    const engineRef = useRef<TrainingEngine | null>(null);
    const onTraversalCompleteRef = useRef(onTraversalComplete);
    const onQueueStatsRef = useRef(onQueueStats);
    const onCardRatedRef = useRef(onCardRated);
    const correctCardsCountRef = useRef(0);

    useEffect(() => { onTraversalCompleteRef.current = onTraversalComplete; }, [onTraversalComplete]);
    useEffect(() => { onQueueStatsRef.current = onQueueStats; }, [onQueueStats]);
    useEffect(() => { onCardRatedRef.current = onCardRated; }, [onCardRated]);

    // Build engine once on mount or when variants change (not when fsrsCards changes from saves)
    const initialFsrsCardsRef = useRef(fsrsCards);
    useEffect(() => { initialFsrsCardsRef.current = fsrsCards; }, [fsrsCards]);
    const engine = useMemo<TrainingEngine>(() => {
        const pgns = variants.map(v => {
            const anns: Record<string, Annotation[]> = {};
            const tempChess = new Chess();
            try {
                tempChess.loadPgn(v.pgn);
                for (const comment of tempChess.getComments()) {
                    // Normalize FEN to match engine's normalized FENs
                    const normalizedFen = normalizeFenResetHalfmoveClock(comment.fen);
                    const existing = anns[normalizedFen] ?? [];
                    anns[normalizedFen] = [...existing, ...extractAnnotations(comment.comment)];
                }
            } catch { /* skip bad PGN */ }
            return {
                pgn: v.pgn,
                orientation: v.orientation,
                annotations: anns,
            };
        });
        return new TrainingEngine(pgns, initialFsrsCardsRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [variants]);

    useEffect(() => {
        engineRef.current = engine;
    }, [engine]);

    // Start traversal on mount / engine change
    const startNewTraversal = useCallback(() => {
        const eng = engineRef.current;
        if (!eng) return;

        correctCardsCountRef.current = 0;
        chessRef.current = new Chess();
        setFen(chessRef.current.fen());
        setPgn('');
        setStatusMessage('');
        setHintAnnotations([]);
        setPgnAnnotations([]);
        setRoundId(Math.random().toString(36).substring(7));

        const status = eng.startTraversal();
        if (!status) {
            setPhase('empty');
            setStatusMessage('No cards to train.');
            return;
        }

        setOrientation(status.orientation);
        setPhase(status.phase);
        onQueueStatsRef.current(eng.getQueueStats());

        if (status.phase === 'empty') {
            setStatusMessage('No cards to train.');
            return;
        }

        if (status.phase === 'ahead_of_schedule') {
            setStatusMessage('All due cards reviewed — practicing ahead of schedule');
        }

        scheduleNextAction(eng);
    }, []);

    useEffect(() => {
        startNewTraversal();

        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };
    }, [engine, startNewTraversal]);

    // ── Core flow ──────────────────────────────────────────────────────

    const scheduleNextAction = (eng: TrainingEngine) => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        const status = eng.getStatus();
        setPhase(status.phase);

        if (status.phase === 'complete') {
            handleTraversalComplete(eng);
            return;
        }

        if (status.phase === 'empty') {
            setStatusMessage('No cards to train.');
            return;
        }

        if (status.phase === 'autoplay') {
            const step = eng.getCurrentStep();
            if (!step) return;

            setHintAnnotations([]);
            setPgnAnnotations(status.annotations);

            const annotations = status.annotations;
            const delay = AUTOPLAY_MOVE_DELAY_MS + getAnnotationDelayMs(annotations);

            timeoutRef.current = setTimeout(() => {
                timeoutRef.current = null;
                executeAutoplay(eng, step);
            }, delay);
            return;
        }

        if (status.phase === 'teaching') {
            setPgnAnnotations([]);
            if (status.hintMove) {
                setHintAnnotations([{
                    brush: 'G',
                    orig: status.hintMove.from,
                    dest: status.hintMove.to,
                }]);
            }
            return;
        }

        if (status.phase === 'recalling' || status.phase === 'awaiting_user' || status.phase === 'ahead_of_schedule') {
            setHintAnnotations([]);
            setPgnAnnotations(status.annotations);
            return;
        }
    };

    const executeAutoplay = (eng: TrainingEngine, step: TraversalStep) => {
        const chess = chessRef.current;
        try {
            const move = chess.move(step.expectedMove);
            if (move) {
                if (move.captured) {
                    playSound(soundCapture);
                } else {
                    playSound(soundMove);
                }
                setFen(chess.fen());
                setPgn(chess.pgn());

                const status = eng.advanceAutoplay();
                setPhase(status.phase);
                scheduleNextAction(eng);
            }
        } catch (e) {
            console.error('[TrainingEngine] Autoplay failed:', step.expectedMove, e);
        }
    };

    const handleMove = (orig: string, dest: string): boolean => {
        const eng = engineRef.current;
        if (!eng) return false;

        // Guard against clicks during autoplay (race condition)
        if (phase === 'autoplay' || phase === 'complete' || phase === 'empty') return false;

        const chess = chessRef.current;
        const result = eng.handleUserMove(orig, dest, chess);

        if (!result.accepted) {
            if (result.branchPointMessage) {
                // Valid repertoire move at branch point — rate it but revert board
                setStatusMessage(result.branchPointMessage);
                playSound(soundMove);
                if (result.ratingWasCorrect) {
                    correctCardsCountRef.current++;
                    onCardRatedRef.current();
                }
                onQueueStatsRef.current(eng.getQueueStats());
                return false; // ChessboardControl will revert the move
            }
            // Invalid move — clear any branch point message
            setStatusMessage('');
            playSound(soundError);
            return false;
        }

        // Move accepted — apply to chess
        try {
            const move = chess.move({ from: orig, to: dest });
            if (!move) return false;

            if (move.captured) {
                playSound(soundCapture);
            } else {
                playSound(soundMove);
            }
            setFen(chess.fen());
            setPgn(chess.pgn());
            setStatusMessage('');
            setHintAnnotations([]);
        } catch {
            return false;
        }

        if (result.ratingWasCorrect) {
            correctCardsCountRef.current++;
            onCardRatedRef.current();
        }

        if (result.isEndOfTraversal) {
            playSound(soundSuccess);
            handleTraversalComplete(eng);
            return true;
        }

        // Advance to next action
        const status = eng.getStatus();
        setPhase(status.phase);
        scheduleNextAction(eng);
        onQueueStatsRef.current(eng.getQueueStats());

        return true;
    };

    const handleTraversalComplete = async (eng: TrainingEngine) => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        const correctCount = correctCardsCountRef.current;
        const updatedCards = eng.getFsrsCards();

        // Await save completion before starting next traversal (prevents ETag race)
        await onTraversalCompleteRef.current(correctCount, updatedCards);

        // Start next traversal after save completes (tracked timeout for cleanup)
        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = null;
            startNewTraversal();
        }, 300); // tiny delay for the success sound to be heard
    };

    const handleHintRequest = () => {
        const eng = engineRef.current;
        if (!eng) return;

        const hint = eng.requestHint();
        if (hint) {
            setHintAnnotations([{
                brush: 'B',
                orig: hint.from,
                dest: hint.to,
            }]);
        }
    };

    const playSound = (sound: HTMLAudioElement): void => {
        sound.play().catch((error) => {
            if (error.name === 'NotAllowedError' || error.name === 'NotSupportedError') {
                return;
            }
            throw error;
        });
    };

    const getAnnotationDelayMs = (annotations: { dest?: string }[]): number => {
        const count = annotations.reduce((c, a) => c + (a.dest ? 1 : 0), 0);
        if (count === 0) return 0;
        return ANNOTATION_DELAY_BASE_IN_MS * (Math.pow(ANNOTATION_DELAY_GROWTH, count) - 1) / (ANNOTATION_DELAY_GROWTH - 1);
    };

    // ── Render ─────────────────────────────────────────────────────────

    const allAnnotations = [...(pgnAnnotations || []), ...hintAnnotations];

    const boardContainerClass = phase === 'autoplay'
        ? 'board-wrapper board-glow-autoplay'
        : phase === 'teaching'
            ? 'board-wrapper board-glow-teaching'
            : 'board-wrapper';

    const isInteractive = phase !== 'autoplay' && phase !== 'complete' && phase !== 'empty';

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            width: '100%',
            maxWidth: '100%'
        }}>
            <div className={boardContainerClass}>
                <ChessboardControl
                    roundId={roundId}
                    fen={fen}
                    orientation={orientation}
                    movePlayed={(orig, dest) => handleMove(orig, dest)}
                    annotations={allAnnotations}
                    interactive={isInteractive}
                />
            </div>

            {/* Status messages */}
            {phase === 'autoplay' && (
                <div className="status-bar status-bar-autoplay">
                    ⏩ Auto-playing to target position…
                </div>
            )}
            {phase === 'teaching' && (
                <div className="status-bar status-bar-teaching">
                    📖 New moves — play the highlighted move
                </div>
            )}
            {phase === 'recalling' && (
                <div className="status-bar status-bar-recall">
                    🔁 Recall pass — try to remember the moves
                </div>
            )}
            {phase === 'ahead_of_schedule' && (
                <div className="status-bar status-bar-ahead">
                    ✅ All due cards reviewed — practicing ahead of schedule
                </div>
            )}
            {statusMessage && phase !== 'ahead_of_schedule' && (
                <div className="status-bar status-bar-info">
                    {statusMessage}
                </div>
            )}

            {/* Hint button — available during user play and recall */}
            {(phase === 'awaiting_user' || phase === 'recalling' || phase === 'ahead_of_schedule') && (
                <button
                    className="hint-button"
                    onClick={handleHintRequest}
                    style={{
                        marginTop: '0.3rem',
                        padding: '0.3rem 1rem',
                        fontSize: '0.85rem',
                        cursor: 'pointer',
                        border: '1px solid #ccc',
                        borderRadius: '4px',
                        background: '#f9f9f9',
                    }}
                >
                    💡 Hint
                </button>
            )}

            {/* PGN display */}
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
                <div style={{ padding: '0.5rem' }}>
                    <PgnControl pgn={pgn} />
                </div>
            </div>
        </div>
    );
};

export default TrainingPageControl;
