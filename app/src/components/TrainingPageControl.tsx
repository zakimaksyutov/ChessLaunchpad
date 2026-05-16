import React, { useEffect, useRef, useState, useMemo } from 'react';
import ChessboardControl from './ChessboardControl';
import { Chess, Move } from "chess.js";
import { OpeningVariant } from '../models/OpeningVariant';
import { LaunchpadLogic } from '../utils/LaunchpadLogic';
import PgnControl from './PgnControl';
import { FSRSCardData } from '../models/FSRSCardData';
import './TrainingPageControl.css';

import soundMoveFile from '../assets/move.mp3';
import soundCaptureFile from '../assets/capture.mp3';
import soundErrorFile from '../assets/error.mp3';
import soundSuccessFile from '../assets/energy.mp3';

// Create Audio objects for move/capture/error/success sounds
const soundMove = new Audio(soundMoveFile);
const soundCapture = new Audio(soundCaptureFile);
const soundError = new Audio(soundErrorFile);
const soundSuccess = new Audio(soundSuccessFile);

const FSRS_STATE_NAMES = ['New', 'Learning', 'Review', 'Relearning'];

type AutoPlayPhase = 'autoplay' | 'idle';

function formatCardForLog(card: FSRSCardData) {
    return {
        state: FSRS_STATE_NAMES[card.st] ?? card.st,
        stability: card.s,
        difficulty: card.di,
        elapsed_days: card.e,
        scheduled_days: card.sd,
        learning_steps: card.ls,
        reps: card.r,
        lapses: card.l,
        due: card.d,
        last_review: card.lr ?? '—',
    };
}

interface TrainingPageControlProps {
    variants: OpeningVariant[];
    fsrsCards: Record<string, FSRSCardData>;
    onCompletion: () => void;
    onLoadNext: () => void;
    orientation: 'white' | 'black';
}

// Table visibility states
const TABLE_HIDDEN = 0;
const TABLE_SELECTED_ONLY = 1;
const TABLE_FULL = 2;

const TrainingPageControl: React.FC<TrainingPageControlProps> = ({ variants, fsrsCards, onCompletion, onLoadNext, orientation }) => {

    const ANNOTATION_DELAY_BASE_IN_MS = 200;
    const ANNOTATION_DELAY_GROWTH = 1.26;
    const AUTOPLAY_MOVE_DELAY_MS = 250;
    const NORMAL_MOVE_DELAY_MS = 750;

    ////////////////////////////////////////////
    // React References
    const timeoutRef = useRef<NodeJS.Timeout | null>(null); // Timeout reference for auto-play
    const loadNextTriggeredRef = useRef(false); // Guards against double-calling onLoadNext
    const onLoadNextRef = useRef(onLoadNext);
    useEffect(() => { onLoadNextRef.current = onLoadNext; }, [onLoadNext]);

    ////////////////////////////////////////////
    // React States
    const [pgn, setPgn] = useState<string>(''); // Game's PGN
    const [fen, setFen] = useState<string>(() => new Chess().fen()); // Game's FEN
    const [autoLoadNext, setAutoLoadNext] = useState<boolean>(false); // Whether to auto-load the next variant
    const [progress, setProgress] = useState<number>(0); // Progress bar till auto-loading
    const [applicableVariants, setApplicableVariants] = useState<OpeningVariant[]>([]); // Applicable variants for the position before the last move
    const [roundId, setRoundId] = useState<string>(''); // ID of the current round
    const [tableVisibility, setTableVisibility] = useState<number>(TABLE_HIDDEN); // Table visibility state
    const [autoPlayPhase, setAutoPlayPhase] = useState<AutoPlayPhase>('idle'); // FSRS autoplay visual state

    ////////////////////////////////////////////
    // React Memory
    const logic = useMemo<LaunchpadLogic>(() => new LaunchpadLogic(variants, fsrsCards), [variants, fsrsCards]);
    const chess = useMemo(() => new Chess(), []);

    ////////////////////////////////////////////
    // React References — FSRS autoplay prefix tracking
    const userHasPlayedManuallyRef = useRef<boolean>(false);

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
        setAutoPlayPhase('idle');
        userHasPlayedManuallyRef.current = false;

        // Generate a new ID for the round
        setRoundId(Math.random().toString(36).substring(7));

        // Schedule the first action based on whose turn it is
        decideNextAction(chess);

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
            loadNextTriggeredRef.current = false;

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
    }, [autoLoadNext, logic, chess]);

    // Trigger onLoadNext when the progress bar completes.
    // Separated from the progress effect to keep the state updater pure
    // (StrictMode calls updaters twice, which was causing double onLoadNext calls).
    useEffect(() => {
        if (autoLoadNext && progress >= 100 && !loadNextTriggeredRef.current) {
            loadNextTriggeredRef.current = true;
            onLoadNextRef.current();
        }
    }, [autoLoadNext, progress]);

    const handleMove = (orig: string, dest: string, isAutoplay: boolean): boolean => {

        const chessTestMove = new Chess();
        chessTestMove.loadPgn(chess.pgn());
        const move: Move = chessTestMove.move({ from: orig, to: dest })!;

        if (!logic.isValidVariant(chessTestMove.fen())) {
            // There is no such variant. Play an error sound and return false to revert the move.
            playSound(soundError);
            logic.markError(chess.fen());
            return false;
        }

        // Rate FSRS card if user played manually (not autoplayed)
        if (!isAutoplay) {
            const currentFen = chess.fen();
            const hadError = logic.hasErrorAtPosition(currentFen);
            const cardBefore = logic.getCardDataForMove(currentFen, move.san);

            userHasPlayedManuallyRef.current = true;
            setAutoPlayPhase('idle');
            logic.rateUserMove(currentFen, move.san);

            const cardAfter = logic.getCardDataForMove(currentFen, move.san);
            console.log(`[FSRS] Played ${move.san}: correct=${!hadError}`);
            console.table([{
                label: 'before',
                ...(cardBefore ? formatCardForLog(cardBefore) : { state: '(new card)' }),
            }, {
                label: 'after',
                ...(cardAfter ? formatCardForLog(cardAfter) : {}),
            }]);
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
        } else {
            decideNextAction(chess);
        }

        return true;
    }

    const handleCompletion = () => {
        logic.completeVariant(chess.fen());

        // Defensive: clear any pending autoplay timeout
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        // Reset autoplay phase so status bar doesn't persist during countdown
        setAutoPlayPhase('idle');

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

    const scheduleToPlayNextMove = (chess: Chess, fastAutoplay: boolean = false) => {
        // Clear any existing timeout before setting a new one.
        // This is needed because it is run from useEffect and it can run multiple times (strict mode in development)
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }

        const baseDelay = fastAutoplay ? AUTOPLAY_MOVE_DELAY_MS : NORMAL_MOVE_DELAY_MS;

        // If there are annotations then we delay auto-play by extra time per annotation.
        // The idea is that we want to give the user time to follow annotations.
        const annotations = logic.getAnnotations(chess.fen());

        timeoutRef.current = setTimeout(() => {
            // Clear ref BEFORE executing: playNextMove may schedule a new
            // timeout via decideNextAction → scheduleToPlayNextMove, and we
            // must not overwrite that new reference afterwards.
            timeoutRef.current = null;
            playNextMove(chess);
        }, baseDelay + getAnnotationDelayMilliseconds(annotations));
    }

    const getAnnotationDelayMilliseconds = (annotations: { dest?: string }[]): number => {
        const annotationCount = annotations.reduce((count, annotation) => count + (annotation.dest ? 1 : 0), 0);
        if (annotationCount === 0) {
            return 0;
        }

        // Geometric series: base * (growth^n - 1) / (growth - 1)
        return ANNOTATION_DELAY_BASE_IN_MS * (Math.pow(ANNOTATION_DELAY_GROWTH, annotationCount) - 1) / (ANNOTATION_DELAY_GROWTH - 1);
    }

    const isUserTurn = (moveCount: number): boolean => {
        // After moveCount moves have been played, the next move is by...
        const nextMoveIsWhite = moveCount % 2 === 0;
        return (orientation === 'white' && nextMoveIsWhite) || (orientation === 'black' && !nextMoveIsWhite);
    }

    const logFsrsLookahead = (fen: string, skipLookahead: boolean, autoplay: boolean = false) => {
        const entries = logic.getLookaheadEvaluation(fen, skipLookahead);
        console.log(`[FSRS] Your turn${autoplay ? ' (autoplaying)' : ''}${skipLookahead ? ' (no lookahead)' : ''} — FEN:`, fen);
        console.table(entries.map(e => ({
            path: e.path,
            fen: e.fen,
            state: e.cardData ? FSRS_STATE_NAMES[e.cardData.st] : '(none)',
            stability: e.cardData?.s ?? '—',
            difficulty: e.cardData?.di ?? '—',
            reps: e.cardData?.r ?? '—',
            lapses: e.cardData?.l ?? '—',
            retrievability: e.retrievability !== null ? e.retrievability.toFixed(4) : '—',
            autoplay: e.shouldAutoplay ? '✓' : '✗',
            due: e.cardData?.d ?? '—',
        })));
    }

    const decideNextAction = (chess: Chess) => {
        const moveCount = chess.history().length;
        const inAutoplayPrefix = !userHasPlayedManuallyRef.current;

        // Skip lookahead for the first 2 user-turn moves to avoid excessive
        // tree evaluation at the root where branching factor is highest.
        const userTurnIndex = orientation === 'white'
            ? moveCount / 2
            : (moveCount - 1) / 2;
        const skipLookahead = userTurnIndex < 2;

        if (!isUserTurn(moveCount)) {
            // Opponent's turn → always autoplay
            scheduleToPlayNextMove(chess, inAutoplayPrefix);
        } else if (inAutoplayPrefix && logic.shouldAutoplayUserMove(chess.fen(), skipLookahead)) {
            // User's turn, still in autoplay prefix, FSRS says autoplay
            setAutoPlayPhase('autoplay');
            logFsrsLookahead(chess.fen(), skipLookahead, true);
            scheduleToPlayNextMove(chess, true);
        } else {
            // User's turn, user must play manually
            setAutoPlayPhase('idle');
            logFsrsLookahead(chess.fen(), skipLookahead);
        }
    }

    const playNextMove = (chess: Chess) => {
        const move = logic.getNextMove(chess.fen(), chess.history().length);

        setApplicableVariants(logic.getAllVariants().filter(variant => variant.move !== null));

        handleMove(move.from, move.to, true);
    }

    const boardContainerClass = autoPlayPhase === 'autoplay'
        ? 'board-wrapper board-glow-autoplay'
        : 'board-wrapper';

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
                    <div className={boardContainerClass}>
                        <ChessboardControl
                            roundId={roundId}
                            fen={fen}
                            orientation={orientation}
                            movePlayed={(orig, dest) => handleMove(orig, dest, false)}
                            annotations={annotations}
                            interactive={autoPlayPhase !== 'autoplay'}
                        />
                    </div>
                );
            })()}
            {autoPlayPhase === 'autoplay' && (
                <div className="status-bar status-bar-autoplay">
                    ⏩ Auto-playing mastered moves…
                </div>
            )}
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
