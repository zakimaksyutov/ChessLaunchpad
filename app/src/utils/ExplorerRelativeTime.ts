/**
 * Coarse-grained relative-time formatters for the Explorer move list, where
 * each card label competes for space in a dense row. Kept deliberately compact
 * ("due in 14d", "5d ago") rather than the verbose FormatUtils style.
 */

/**
 * Render a Date as "due now" / "due in 15 min" / "due in 14d" / "due in 3 mo".
 */
export function formatDueRelative(due: Date, now: Date): string {
    const diffMs = due.getTime() - now.getTime();
    if (diffMs <= 0) return 'due now';
    const sec = Math.round(diffMs / 1000);
    const min = Math.round(sec / 60);
    const hr = Math.round(min / 60);
    const day = Math.round(hr / 24);
    if (sec < 60) return 'due in < 1 min';
    if (min < 60) return `due in ${min} min`;
    if (hr < 48) return `due in ${hr}h`;
    if (day < 60) return `due in ${day}d`;
    const mo = Math.round(day / 30);
    if (mo < 24) return `due in ${mo} mo`;
    const yr = (day / 365).toFixed(1);
    return `due in ${yr} yr`;
}

/**
 * Render how long ago a review happened:
 * "just now" / "last 5 min ago" / "last 2h ago" / "last 5d ago" / "last 3 mo ago".
 *
 * Mirrors formatDueRelative's sub-day granularity so a freshly-rated card reads
 * "just now" instead of clamping to a misleading "last 1d ago" (the old formatter
 * rounded any review ≥ 12h to 1d and then clamped 0d up to 1d).
 */
export function formatLastReviewed(when: Date, now: Date): string {
    const diffMs = Math.max(0, now.getTime() - when.getTime());
    const sec = Math.round(diffMs / 1000);
    const min = Math.round(sec / 60);
    const hr = Math.round(min / 60);
    const day = Math.round(hr / 24);
    if (sec < 60) return 'just now';
    if (min < 60) return `last ${min} min ago`;
    if (hr < 48) return `last ${hr}h ago`;
    if (day < 60) return `last ${day}d ago`;
    const mo = Math.round(day / 30);
    if (mo < 24) return `last ${mo} mo ago`;
    const yr = (day / 365).toFixed(1);
    return `last ${yr} yr ago`;
}
