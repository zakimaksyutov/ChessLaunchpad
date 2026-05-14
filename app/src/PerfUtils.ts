/** Check whether `?measurePerf=true` is present in the URL (hash-query or regular query). */
export function getMeasurePerf(): boolean {
    if (typeof window === 'undefined') return false;
    const hashQuery = window.location.hash.split('?')[1];
    const search = hashQuery || window.location.search;
    return new URLSearchParams(search).get('measurePerf') === 'true';
}
