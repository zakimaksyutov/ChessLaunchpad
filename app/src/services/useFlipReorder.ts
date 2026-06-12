import { useLayoutEffect, useRef } from 'react';

/**
 * FLIP-style reorder animation for a flat list of children inside
 * `container`. Each animatable child must carry a stable
 * `data-flip-key` attribute on the element returned by the React render.
 *
 * On each render where `deps` change:
 *   1. Capture the current bounding rect of every keyed child (the
 *      "Last" position).
 *   2. For every child that also appeared in the previous render and
 *      whose position has shifted by more than 1px, play a Web
 *      Animation that interpolates from the prior position
 *      (`translate(dx, dy)`) back to the natural position
 *      (`translate(0, 0)`).
 *   3. Persist the new rects as the next render's "First" snapshot.
 *
 * Children that didn't exist last render (inserted) get no transform —
 * they appear in place, where CSS opacity/scale enter animations can
 * take over. Children removed from the DOM are dropped from the
 * snapshot naturally.
 *
 * Honors `prefers-reduced-motion: reduce` — when set, the hook simply
 * captures rects without animating.
 */
export function useFlipReorder(
    container: HTMLElement | null,
    deps: ReadonlyArray<unknown>,
    options: { duration?: number; easing?: string } = {},
): void {
    const prevRects = useRef<Map<string, DOMRect>>(new Map());

    useLayoutEffect(() => {
        if (!container) return;

        const duration = options.duration ?? 140;
        const easing = options.easing ?? 'cubic-bezier(0.2, 0.8, 0.2, 1)';
        // Shifts smaller than this don't animate — small residuals
        // (sub-pixel rounding, 1-2px height adjustments from font
        // metric changes) just snap. Larger shifts get the FLIP tween.
        const minDelta = 4;

        const reduceMotion =
            typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const newRects = new Map<string, DOMRect>();
        const children = Array.from(container.children) as HTMLElement[];

        for (const child of children) {
            const key = child.dataset.flipKey;
            if (!key) continue;
            newRects.set(key, child.getBoundingClientRect());
        }

        if (!reduceMotion && typeof HTMLElement.prototype.animate === 'function') {
            const prev = prevRects.current;
            for (const child of children) {
                const key = child.dataset.flipKey;
                if (!key) continue;
                const p = prev.get(key);
                const n = newRects.get(key);
                if (!p || !n) continue;
                const dy = p.top - n.top;
                const dx = p.left - n.left;
                if (Math.abs(dy) < minDelta && Math.abs(dx) < minDelta) continue;
                child.animate(
                    [
                        { transform: `translate(${dx}px, ${dy}px)` },
                        { transform: 'translate(0, 0)' },
                    ],
                    { duration, easing, fill: 'none' },
                );
            }
        }

        prevRects.current = newRects;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [container, ...deps]);
}
