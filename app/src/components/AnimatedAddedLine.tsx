import React, { useEffect, useMemo, useState } from 'react';
import ChessboardControl from './ChessboardControl';
import { EditChain } from '../services/PendingEditModel';
import { AddedLineFrames } from '../utils/ReviewAnimation';

/** Hold on the anchor position before the first move plays (ms). */
const ANCHOR_HOLD_MS = 850;
/** Time each played ply rests before the next one (ms). */
const PLY_MS = 850;
/** Rest on the final position before snapping back to the anchor (ms). */
const END_PAUSE_MS = 1900;

/**
 * Looping big-board preview of a single added line. Starts on the anchor
 * position (already in the repertoire), plays each new ply with a green
 * arrow + glide, rests on the final position, then snaps back and loops.
 *
 * The glide is provided by `ChessboardControl` itself: it animates whenever
 * the `fen` prop changes by one legal move while `roundId` stays constant.
 * The multi-ply jump back to the anchor on loop is intentionally a snap
 * (`detectMove` finds no single move) so the restart reads cleanly.
 *
 * The board is the whole UI — no caption or controls. Users who prefer
 * reduced motion get a static final position instead of the loop.
 */
const AnimatedAddedLine: React.FC<{ chain: EditChain; frames: AddedLineFrames }> = ({ chain, frames }) => {
    const prefersReducedMotion = usePrefersReducedMotion();
    const lastIdx = frames.frames.length - 1;
    const canAnimate = lastIdx > 0;

    const [idx, setIdx] = useState(() => (prefersReducedMotion ? lastIdx : 0));

    // Stable across fen steps so ChessboardControl keeps computing per-ply
    // glides instead of resetting its animation baseline.
    const roundId = useMemo(
        () => `review-anim-${chain.head.from}-${chain.head.san}`,
        [chain.head.from, chain.head.san],
    );

    // (Re)initialize when the line or the motion preference changes: start
    // from the anchor and let the autoplay effect drive, unless reduced
    // motion is requested, in which case rest statically on the final frame.
    useEffect(() => {
        setIdx(prefersReducedMotion ? lastIdx : 0);
    }, [prefersReducedMotion, lastIdx, roundId]);

    // Autoplay loop. Disabled entirely under reduced motion.
    useEffect(() => {
        if (prefersReducedMotion || !canAnimate) return;
        const delay = idx === 0 ? ANCHOR_HOLD_MS : idx === lastIdx ? END_PAUSE_MS : PLY_MS;
        const t = window.setTimeout(() => {
            setIdx(i => (i >= lastIdx ? 0 : i + 1));
        }, delay);
        return () => window.clearTimeout(t);
    }, [idx, lastIdx, canAnimate, prefersReducedMotion]);

    const safeIdx = Math.min(idx, lastIdx);
    const fen = frames.frames[safeIdx];
    const arrow = frames.arrows[safeIdx];

    return (
        <div className="explorer-review-anim">
            <div
                className="explorer-review-anim-board"
                role="img"
                aria-label={chain.chainPgn ? `Preview of added line ${chain.chainPgn}` : 'Preview of added line'}
            >
                <ChessboardControl
                    roundId={roundId}
                    fen={fen}
                    orientation={chain.orientation}
                    movePlayed={() => false}
                    annotations={arrow ? [arrow] : []}
                    interactive={false}
                />
            </div>
        </div>
    );
};

export default AnimatedAddedLine;

/**
 * Track the user's reduced-motion preference reactively so the animation can
 * stop if the OS setting changes mid-session.
 */
function usePrefersReducedMotion(): boolean {
    const getInitial = () =>
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const [reduced, setReduced] = useState<boolean>(getInitial);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
        const onChange = () => setReduced(mql.matches);
        onChange();
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, []);

    return reduced;
}
