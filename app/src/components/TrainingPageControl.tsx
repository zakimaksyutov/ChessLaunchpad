import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import ChessboardControl from './ChessboardControl';
import { Chess } from "chess.js";
import { OpeningVariant } from '../models/OpeningVariant';
import { FSRSCardData } from '../models/FSRSCardData';
import { TrainingEngine, EnginePhase } from '../services/TrainingEngine';
import { TraversalStep } from '../services/PathPlanner';
import { Annotation } from '../models/Annotation';
import { TraversalStats } from '../services/ActivityService';
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
    onTraversalComplete: (cardsRated: number, updatedCards: Record<string, FSRSCardData>, traversalStats: TraversalStats, elapsedSeconds: number) => Promise<void>;
    onQueueStats: (stats: { dueCount: number; newCount: number; reviewCount: number; learningCount: number; totalCards: number }) => void;
    onCardRated: () => void;
    reviewedToday: number;
    onDone: () => void;
}

const AUTOPLAY_MOVE_DELAY_MS = 250;
const OPPONENT_MOVE_DELAY_MS = 500;
const ANNOTATION_DELAY_BASE_IN_MS = 200;
const ANNOTATION_DELAY_GROWTH = 1.26;
// Beat held at the end of a teaching pass before the recall pass begins, so
// the user can register that they completed the new-moves phase before the
// banner/glow flip to recall and the board resets to replay the line.
const TEACHING_TO_RECALL_PAUSE_MS = 1200;

const TrainingPageControl: React.FC<TrainingPageControlProps> = ({
    variants,
    fsrsCards,
    onTraversalComplete,
    onQueueStats,
    onCardRated,
    reviewedToday,
    onDone,
}) => {
    const [fen, setFen] = useState<string>(() => new Chess().fen());
    const [pgn, setPgn] = useState<string>('');
    const [orientation, setOrientation] = useState<'white' | 'black'>('white');
    const [phase, setPhase] = useState<EnginePhase>('idle');
    // Engine *mode* flags. Unlike `phase` (which flips to 'autoplay' during the
    // prefix replay and between user turns), these stay true for the entire
    // duration of a teach/recall pass. They drive the persistent banners so
    // they don't flicker every time an opponent autoplay move happens.
    const [isTeaching, setIsTeaching] = useState<boolean>(false);
    const [isRecalling, setIsRecalling] = useState<boolean>(false);
    const [roundId, setRoundId] = useState<string>('');
    const [statusMessage, setStatusMessage] = useState<string>('');
    const [hintAnnotations, setHintAnnotations] = useState<Annotation[]>([]);
    const [pgnAnnotations, setPgnAnnotations] = useState<Annotation[]>([]);
    // Mirrors pastPrefixRef so the Hint button can remain mounted across the
    // brief opponent-autoplay transitions between user turns (prevents the
    // button from flickering out of and back into the DOM).
    const [pastPrefix, setPastPrefix] = useState(false);

    const timeoutRef = useRef<NodeJS.Timeout | null>(null);
    const mountedRef = useRef(true);
    const chessRef = useRef<Chess>(new Chess());
    const engineRef = useRef<TrainingEngine | null>(null);
    const onTraversalCompleteRef = useRef(onTraversalComplete);
    const onQueueStatsRef = useRef(onQueueStats);
    const onCardRatedRef = useRef(onCardRated);
    const correctCardsCountRef = useRef(0);
    // Tracks whether the current traversal has left the initial autoplay prefix
    // (i.e. the engine has surfaced a non-autoplay phase that expects user input).
    // Opponent moves during the prefix play fast; once the user has been
    // engaged, subsequent opponent autoplay moves use the slower normal pace.
    const pastPrefixRef = useRef(false);

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

    // Reset all UI state at the start of a new traversal (called by both the
    // standard start and the ahead-of-schedule acceptance paths).
    const resetTraversalUiState = useCallback(() => {
        correctCardsCountRef.current = 0;
        pastPrefixRef.current = false;
        setPastPrefix(false);
        chessRef.current = new Chess();
        setFen(chessRef.current.fen());
        setPgn('');
        setStatusMessage('');
        setHintAnnotations([]);
        setPgnAnnotations([]);
        setRoundId(Math.random().toString(36).substring(7));
    }, []);

    // Start traversal on mount / engine change. Note: this function only ever
    // calls `eng.startTraversal()` (the default, no-confirm path). If all due
    // cards are reviewed the engine returns `'ahead_of_schedule_pending'` —
    // we surface the session-complete panel and wait for the user to either
    // exit or confirm via `acceptAheadOfSchedule`. We do NOT auto-roll into
    // ahead-of-schedule autoplay.
    const startNewTraversal = useCallback(() => {
        const eng = engineRef.current;
        if (!eng) return;

        resetTraversalUiState();

        const status = eng.startTraversal();
        if (!status) {
            setPhase('empty');
            setIsTeaching(false);
            setIsRecalling(false);
            setStatusMessage('No cards to train.');
            return;
        }

        setOrientation(status.orientation);
        setPhase(status.phase);
        setIsTeaching(status.isTeaching);
        setIsRecalling(status.isRecalling);
        onQueueStatsRef.current(eng.getQueueStats());

        if (status.phase === 'empty') {
            setStatusMessage('No cards to train.');
            return;
        }

        if (status.phase === 'ahead_of_schedule_pending') {
            // Render the session-complete panel and wait for user input.
            // Do NOT schedule any autoplay — the engine has not built a
            // live plan and getCurrentStep() returns null.
            return;
        }

        if (status.phase === 'ahead_of_schedule') {
            setStatusMessage('All due cards reviewed — practicing ahead of schedule');
        }

        scheduleNextAction(eng);
    }, [resetTraversalUiState]);

    // User confirmed they want to keep training past their due queue.
    // Adopts the engine's pre-staged ahead-of-schedule plan and resumes
    // normal scheduling.
    const acceptAhead = useCallback(() => {
        const eng = engineRef.current;
        if (!eng) return;

        resetTraversalUiState();

        const status = eng.acceptAheadOfSchedule();
        if (!status) {
            // Shouldn't happen if button is only shown in pending phase, but
            // be defensive: fall back to the regular start flow.
            startNewTraversal();
            return;
        }

        setOrientation(status.orientation);
        setPhase(status.phase);
        setIsTeaching(status.isTeaching);
        setIsRecalling(status.isRecalling);
        onQueueStatsRef.current(eng.getQueueStats());

        if (status.phase === 'ahead_of_schedule') {
            setStatusMessage('All due cards reviewed — practicing ahead of schedule');
        }

        scheduleNextAction(eng);
    }, [resetTraversalUiState, startNewTraversal]);

    useEffect(() => {
        mountedRef.current = true;
        startNewTraversal();

        return () => {
            mountedRef.current = false;
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
        setIsTeaching(status.isTeaching);
        setIsRecalling(status.isRecalling);

        if (status.phase === 'complete') {
            handleTraversalComplete(eng).catch(console.error);
            return;
        }

        if (status.phase === 'empty') {
            setStatusMessage('No cards to train.');
            return;
        }

        // Defensive: never schedule work in the pending phase. The session-
        // complete panel is rendered from the phase state and the user must
        // click a button to proceed.
        if (status.phase === 'ahead_of_schedule_pending') {
            return;
        }

        if (status.phase === 'autoplay') {
            const step = eng.getCurrentStep();
            if (!step) return;

            setHintAnnotations([]);
            setPgnAnnotations(status.annotations);

            const annotations = status.annotations;
            const baseDelay = pastPrefixRef.current ? OPPONENT_MOVE_DELAY_MS : AUTOPLAY_MOVE_DELAY_MS;
            const delay = baseDelay + getAnnotationDelayMs(annotations);

            timeoutRef.current = setTimeout(() => {
                timeoutRef.current = null;
                executeAutoplay(eng, step);
            }, delay);
            return;
        }

        // Any non-autoplay interactive phase marks the end of the prefix:
        // subsequent opponent autoplay moves should use the slower normal pace.
        pastPrefixRef.current = true;
        setPastPrefix(true);

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
                setIsTeaching(status.isTeaching);
                setIsRecalling(status.isRecalling);
                scheduleNextAction(eng);
            }
        } catch (e) {
            console.error('[TrainingEngine] Autoplay failed:', step.expectedMove, e);
        }
    };

    const handleMove = (orig: string, dest: string): boolean => {
        const eng = engineRef.current;
        if (!eng) return false;

        // Guard against clicks during autoplay (race condition) and during
        // the session-complete (pending) panel where no plan exists.
        if (phase === 'autoplay' || phase === 'complete' || phase === 'empty' || phase === 'ahead_of_schedule_pending') return false;

        const chess = chessRef.current;
        const result = eng.handleUserMove(orig, dest, chess);

        if (!result.accepted) {
            if (result.branchPointMessage) {
                // Valid repertoire move at branch point — rate it but revert board
                setStatusMessage(result.branchPointMessage);
                playSound(soundMove);
                if (result.ratingWasCorrect && result.isTargetCard) {
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

        // Count successful target-card interactions for the "today" badge.
        // Note: result.isTargetCard is only defined for regular traversals (not teach/recall)
        if (result.isTargetCard !== undefined) {
            if (result.isTargetCard) {
                if (result.ratingWasCorrect) {
                    correctCardsCountRef.current++;
                    onCardRatedRef.current();
                }
            }
        }

        if (result.isEndOfTraversal) {
            playSound(soundSuccess);
            onQueueStatsRef.current(eng.getQueueStats());

            // Show end-of-line annotations before transitioning
            const endAnnotations = eng.getEndOfTraversalAnnotations();
            setPgnAnnotations(endAnnotations);
            const delay = getAnnotationDelayMs(endAnnotations);

            if (delay > 0) {
                timeoutRef.current = setTimeout(() => {
                    timeoutRef.current = null;
                    handleTraversalComplete(eng).catch(console.error);
                }, delay);
            } else {
                handleTraversalComplete(eng).catch(console.error);
            }
            return true;
        }

        // Advance to next action
        const status = eng.getStatus();

        // Teaching → recall transition: hold the final teaching position
        // (with the green banner/glow still visible) for a brief pause so the
        // user can register that they completed the new-moves phase before
        // the orange recall pass takes over and the board resets. We detect
        // the transition by comparing the engine's new mode against the
        // stale `phase` from the current render.
        if (status.isRecalling && phase === 'teaching') {
            playSound(soundSuccess);
            timeoutRef.current = setTimeout(() => {
                timeoutRef.current = null;
                if (!mountedRef.current) return;
                setPhase(status.phase);
                setIsTeaching(status.isTeaching);
                setIsRecalling(status.isRecalling);
                chessRef.current = new Chess();
                setFen(chessRef.current.fen());
                setPgn('');
                // Recall conceptually starts a fresh prefix replay, so reset
                // the past-prefix flag — otherwise the recall prefix would
                // play at the slow opponent-reply cadence instead of the
                // fast prefix cadence used at the start of a traversal.
                pastPrefixRef.current = false;
                setPastPrefix(false);
                scheduleNextAction(eng);
                onQueueStatsRef.current(eng.getQueueStats());
            }, TEACHING_TO_RECALL_PAUSE_MS);
            return true;
        }

        setPhase(status.phase);
        setIsTeaching(status.isTeaching);
        setIsRecalling(status.isRecalling);

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
        const stats = eng.getTraversalStats();
        const elapsed = eng.getTraversalElapsedSeconds();

        // Await save completion before starting next traversal (prevents ETag race)
        await onTraversalCompleteRef.current(correctCount, updatedCards, stats, elapsed);

        // Guard against scheduling after unmount (save was in-flight when component unmounted)
        if (!mountedRef.current) return;

        // Start next traversal after save completes (tracked timeout for cleanup)
        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = null;
            startNewTraversal();
        }, 500); // delay for the success sound to be heard
    };

    const handleHintRequest = () => {
        const eng = engineRef.current;
        if (!eng) return;
        // Silently ignore clicks during opponent autoplay between user turns:
        // the engine's "current step" is the opponent's move, so requesting a
        // hint here would surface the opponent's move and is meaningless.
        // We avoid disabling the button visually (which would flicker on every
        // opponent reply) and instead just drop the click.
        if (eng.getStatus().phase === 'autoplay') return;
        // Defensive: hint button shouldn't be rendered in pending, but guard
        // against any leaked invocation.
        if (eng.getStatus().phase === 'ahead_of_schedule_pending') return;

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

    // Glow priority: the persistent mode glows (teaching / recall) win over
    // the per-step autoplay glow so the board stays a constant color for the
    // entire duration of a teach or recall pass, matching the banner.
    const boardContainerClass = isTeaching
        ? 'board-wrapper board-glow-teaching'
        : isRecalling
            ? 'board-wrapper board-glow-recall'
            : phase === 'autoplay'
                ? 'board-wrapper board-glow-autoplay'
                : 'board-wrapper';

    const isInteractive = phase !== 'autoplay' && phase !== 'complete' && phase !== 'empty' && phase !== 'ahead_of_schedule_pending';

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

            {/* Status messages.
                The teaching/recall banners are driven by the engine *mode*
                flags (not by `phase`) so they remain stable through the
                initial autoplay prefix and through each opponent autoplay
                between user turns, rather than flickering in and out. */}
            {isTeaching && (
                <div className="status-bar status-bar-teaching">
                    📖 New moves — play the highlighted move
                </div>
            )}
            {isRecalling && (
                <div className="status-bar status-bar-recall">
                    🔁 Recall pass — try to remember the moves
                </div>
            )}
            {phase === 'ahead_of_schedule_pending' && (
                <div className="session-complete-panel">
                    <h3 className="session-complete-title">✅ All due cards reviewed!</h3>
                    <p className="session-complete-stats">
                        {reviewedToday === 1
                            ? '1 card reviewed today'
                            : `${reviewedToday} cards reviewed today`}
                    </p>
                    <p className="session-complete-prompt">
                        You can stop here or keep practicing your weakest cards ahead of schedule.
                    </p>
                    <div className="session-complete-actions">
                        <button
                            type="button"
                            className="session-complete-primary"
                            onClick={onDone}
                        >
                            Done for today
                        </button>
                        <button
                            type="button"
                            className="session-complete-secondary"
                            onClick={acceptAhead}
                        >
                            Practice ahead of schedule
                        </button>
                    </div>
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

            {/* Hint button — stays mounted throughout active training so it
                never flickers in and out of the DOM. Hidden entirely during
                the teaching pass (including its prefix, opponent replies,
                and the teach→recall pause) because the green hint arrow is
                shown automatically during teaching. Disabled (and dimmed)
                during the initial autoplay prefix of regular/recall passes;
                once the user has had their first turn the button stays
                visually enabled across opponent-autoplay transitions to
                avoid a dim/un-dim flicker on every opponent reply. Clicks
                during opponent autoplay are silently ignored by
                handleHintRequest. */}
            {!isTeaching && (phase === 'awaiting_user' ||
              phase === 'recalling' ||
              phase === 'ahead_of_schedule' ||
              phase === 'autoplay') && (
                <button
                    className="hint-button"
                    onClick={handleHintRequest}
                    disabled={phase === 'autoplay' && !pastPrefix}
                    style={{
                        marginTop: '0.3rem',
                        padding: '0.3rem 1rem',
                        fontSize: '0.85rem',
                        cursor: (phase === 'autoplay' && !pastPrefix) ? 'default' : 'pointer',
                        border: '1px solid #ccc',
                        borderRadius: '4px',
                        background: '#f9f9f9',
                        opacity: (phase === 'autoplay' && !pastPrefix) ? 0.5 : 1,
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
