import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { getSessionStore } from '../data/SessionStore';
import './ProtectedRoute.css';

interface ProtectedRouteProps {
    isLoggedIn: boolean;
    children: React.ReactNode;
}

/**
 * Gates a protected route on (1) the user being logged in and
 * (2) the SessionStore cache being populated.
 *
 * (2) is the precondition for `SessionStore.createDataAccessProxyLayer()`
 * — concentrating the wait here lets pages call that factory
 * synchronously inside `useMemo` with no null-etag handling.
 *
 * `isLoggedIn` is passed in from `App` rather than read from
 * `localStorage` so the gate is fully reactive to App's `username`
 * state. Reading localStorage during render would create an
 * ordering coupling with `Header.handleLogout` (and any future
 * logout path): if state flipped before localStorage was cleared,
 * this component would still see `isLoggedIn=true` for one render
 * and lazy-bootstrap a SessionStore from stale credentials via
 * `getSessionStore()`.
 */
const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ isLoggedIn, children }) => {
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Bumped by Retry to re-run the ready() effect.
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!isLoggedIn) return;
        let cancelled = false;
        setReady(false);
        setError(null);
        getSessionStore().ready()
            .then(() => {
                if (!cancelled) setReady(true);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setError(e instanceof Error ? e.message : String(e));
            });
        return () => { cancelled = true; };
    }, [isLoggedIn, attempt]);

    if (!isLoggedIn) {
        return <Navigate to="/" replace />;
    }
    if (error !== null) {
        return (
            <div className="protected-route-status protected-route-status--error">
                <p>Failed to load your data: {error}</p>
                <button type="button" onClick={() => setAttempt(a => a + 1)}>
                    Retry
                </button>
            </div>
        );
    }
    if (!ready) {
        return (
            <div className="protected-route-status protected-route-status--loading">
                Loading…
            </div>
        );
    }

    return <>{children}</>;
};

export default ProtectedRoute;
