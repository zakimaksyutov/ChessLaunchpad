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
