import { BootstrapSelection } from './RepertoireBootstrapService';

/**
 * In-memory, consume-once handoff for the repertoire-bootstrap → Explorer
 * review flow. The /bootstrap page stages its proposed starter lines here and
 * navigates to `/explorer?review=1`; Explorer adopts the selection into its
 * own PendingEditModel on mount and renders the canonical Review & Save view.
 *
 * Why memory and not the URL (the path /games' "Add to repertoire" uses): the
 * selection spans both colors and can hold many lines, so it neither fits a URL
 * nor matches the single-orientation `?addpgn=` PGN contract. A module-level
 * singleton lives for the app's lifetime and survives client-side navigation,
 * so the two pages can share the object directly. It is intentionally ephemeral
 * — a hard reload clears it (unsaved edits are ephemeral anyway).
 */
let pending: BootstrapSelection | null = null;

export function setBootstrapHandoff(selection: BootstrapSelection): void {
    pending = selection;
}

/** Read and clear the staged selection (consume-once). */
export function takeBootstrapHandoff(): BootstrapSelection | null {
    const selection = pending;
    pending = null;
    return selection;
}
