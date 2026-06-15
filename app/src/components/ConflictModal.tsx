import React, { useEffect, useState, useCallback } from 'react';
import { setConflictListener } from '../data/ConflictNotifier';
import './ConflictModal.css';

/**
 * App-root modal that surfaces server-side 412 conflicts as a single,
 * universal "Reload" prompt.
 *
 * Wiring: registers itself with {@link setConflictListener} on mount.
 * `SessionStore.save` calls `notifyConflict()` on every 412, which
 * flips `visible` to true. The only action is a hard
 * `window.location.reload()` — by the time a 412 fires, the local
 * `(data, etag)` cache is suspect, so the simplest and safest recovery
 * is to drop all in-memory state and re-bootstrap.
 *
 * The modal coalesces repeated notifications: once `visible` is true,
 * additional `notifyConflict()` calls are a no-op until reload.
 */
const ConflictModal: React.FC = () => {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const cleanup = setConflictListener(() => setVisible(true));
        return cleanup;
    }, []);

    const handleReload = useCallback(() => {
        window.location.reload();
    }, []);

    if (!visible) return null;

    return (
        <div
            className="conflict-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="conflict-modal-title"
        >
            <div className="conflict-modal">
                <h2 id="conflict-modal-title">Repertoire changed elsewhere</h2>
                <p>
                    Another writer (another tab, a training session, or game
                    ingestion) updated your repertoire while you were working.
                    Reload the page to fetch the latest state.
                </p>
                <p>
                    Any unsaved local changes will be lost.
                </p>
                <div className="conflict-modal-actions">
                    <button
                        type="button"
                        className="conflict-modal-button"
                        onClick={handleReload}
                        autoFocus
                    >
                        Reload
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ConflictModal;
