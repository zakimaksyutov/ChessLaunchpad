/**
 * Wall-clock timer that pauses when the browser tab is hidden.
 * Accumulated time is available via getElapsedSeconds().
 */
export class TimeTracker {
    private accumulated: number = 0;  // seconds already banked
    private segmentStart: number = 0; // Date.now() of current active segment
    private running: boolean = false;
    private onVisibilityChange: (() => void) | null = null;

    start(): void {
        if (this.running) return;
        this.running = true;
        this.segmentStart = Date.now();
        this.onVisibilityChange = this.handleVisibilityChange.bind(this);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    stop(): void {
        if (!this.running) return;
        // Only bank if tab is visible — hidden time should not be counted
        if (!document.hidden) {
            this.bankCurrentSegment();
        }
        this.running = false;
        if (this.onVisibilityChange) {
            document.removeEventListener('visibilitychange', this.onVisibilityChange);
            this.onVisibilityChange = null;
        }
    }

    /** Get total elapsed seconds (banked + current active segment). */
    getElapsedSeconds(): number {
        if (!this.running || document.hidden) {
            return this.accumulated;
        }
        return this.accumulated + (Date.now() - this.segmentStart) / 1000;
    }

    /** Reset accumulated time and restart the timer. */
    reset(): void {
        this.accumulated = 0;
        if (this.running) {
            this.segmentStart = Date.now();
        }
    }

    /** Bank elapsed time since last segment start and reset the segment. */
    consumeElapsed(): number {
        const elapsed = this.getElapsedSeconds();
        this.accumulated = 0;
        if (this.running) {
            this.segmentStart = Date.now();
        }
        return elapsed;
    }

    destroy(): void {
        this.stop();
    }

    private handleVisibilityChange(): void {
        if (document.hidden) {
            // Tab hidden — bank the active segment
            this.bankCurrentSegment();
        } else {
            // Tab visible — start new segment
            if (this.running) {
                this.segmentStart = Date.now();
            }
        }
    }

    private bankCurrentSegment(): void {
        if (this.running) {
            const now = Date.now();
            this.accumulated += (now - this.segmentStart) / 1000;
            this.segmentStart = now;
        }
    }
}
