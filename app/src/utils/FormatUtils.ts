/**
 * Format seconds as human-friendly duration.
 * Examples: "12 min", "1 hr 5 min", "< 1 min", "2 hr"
 */
export function formatDuration(totalSeconds: number): string {
    if (totalSeconds < 60) return '< 1 min';

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (hours === 0) return `${minutes} min`;
    if (minutes === 0) return `${hours} hr`;
    return `${hours} hr ${minutes} min`;
}

/**
 * Format a date string (YYYY-MM-DD) as display header.
 * Example: "25 MAY 2026"
 */
export function formatDateHeader(dateStr: string): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                     'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return `${d} ${months[m - 1]} ${y}`;
}

/**
 * Format accuracy as percentage string.
 * Returns "—" when accuracy is null (no reviews).
 */
export function formatAccuracy(accuracy: number | null): string {
    if (accuracy === null) return '—';
    return `${Math.round(accuracy * 100)}%`;
}

/**
 * Format a future point in time as a human-friendly relative string.
 * Examples: "in < 1 min", "in 15 min", "in 3 hr", "in 1 hr 20 min",
 *           "in 2 days", "in 1 day 4 hr"
 * Returns "now" defensively when target is at or before now.
 *
 * Matches the unit style of formatDuration ("min", "hr") and pluralizes
 * "day"/"days" since that unit appears with the count.
 */
export function formatTimeUntil(target: Date, now: Date = new Date()): string {
    const diffMs = target.getTime() - now.getTime();
    if (diffMs <= 0) return 'now';

    const totalSeconds = Math.floor(diffMs / 1000);
    if (totalSeconds < 60) return 'in < 1 min';

    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `in ${totalMinutes} min`;

    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24) {
        const minutes = totalMinutes % 60;
        if (minutes === 0) return `in ${totalHours} hr`;
        return `in ${totalHours} hr ${minutes} min`;
    }

    const totalDays = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const dayLabel = totalDays === 1 ? 'day' : 'days';
    if (hours === 0) return `in ${totalDays} ${dayLabel}`;
    return `in ${totalDays} ${dayLabel} ${hours} hr`;
}
