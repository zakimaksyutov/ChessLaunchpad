import React, { useState, useEffect, useRef, useCallback } from 'react';
import { HashRouter as Router, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import Header from './components/Header';
import LandingPage from './pages/LandingPage';
import DashboardPage from './pages/DashboardPage';
import LoginPage from './pages/LoginPage';
import TrainingPage from './pages/TrainingPage';
import SettingsPage from './pages/SettingsPage';
import GamesPage from './pages/GamesPage';
import ExplorerPage from './pages/ExplorerPage';
import FsrsCardListPage from './pages/FsrsCardListPage';
import ProtectedRoute from './components/ProtectedRoute';
import ConflictModal from './components/ConflictModal';
import { LichessAuthProvider } from './LichessAuthContext';
import './App.css';
import { trackEvent, setAuthenticatedUserContext, clearAuthenticatedUserContext } from './AppInsights';
import { createSessionStore, clearSessionStore, tryGetSessionStore } from './data/SessionStore';
import { loadSession, loadCredentialFromStorage, clearStoredSession, isLichessLoginPending } from './data/AuthSession';
import { setSessionExpiredListener } from './data/SessionExpiredNotifier';
import { setLinkedAccounts } from './services/LinkedAccountsService';

// Reset the scroll container to the top on every route change. With the
// app-shell layout the scrolling element is `.app-content` (not the
// window), and it stays mounted across navigations, so its scrollTop would
// otherwise persist from the previous page.
const ScrollToTop: React.FC = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    document.querySelector('.app-content')?.scrollTo(0, 0);
  }, [pathname]);
  return null;
};

/**
 * Drops a dead session and routes back to Login when the data layer signals
 * an unrecoverable auth failure (a Lichess session whose underlying OAuth
 * connection is gone and can't be re-exchanged). Lives inside the Router so
 * it can navigate; `onExpire` clears the in-memory + stored session.
 */
const SessionExpiredHandler: React.FC<{ onExpire: () => void }> = ({ onExpire }) => {
  const navigate = useNavigate();
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  useEffect(() => {
    return setSessionExpiredListener(() => {
      onExpireRef.current();
      navigate('/login');
    });
  }, [navigate]);
  return null;
};

/**
 * After the Lichess OAuth redirect, the app reloads at its base URL with no
 * hash route, so HashRouter lands on `/` and `LoginPage` (which owns the
 * resume) never mounts. This one-shot redirect routes a pending Lichess login
 * to `/login` so it can finish. `history.replaceState` in the OAuth layer
 * doesn't notify the router, so this explicit navigation is required.
 */
const PendingLichessLoginRedirect: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const didRedirect = useRef(false);
  useEffect(() => {
    if (didRedirect.current) return;
    didRedirect.current = true;
    if (isLichessLoginPending() && location.pathname !== '/login') {
      navigate('/login', { replace: true });
    }
  }, [navigate, location.pathname]);
  return null;
};

const App: React.FC = () => {
  // Track logged-in user in state.
  //
  // Seed from localStorage in the initializer so the very first render
  // already reflects the authenticated user. Without this, the
  // `[username]` sync effect below would fire once with the stale
  // null closure and immediately `clearSessionStore()` the
  // SessionStore that ProtectedRoute's (child-first) effect just
  // lazily created — aborting the eager GET /variants and surfacing
  // "signal is aborted without reason" on a hard refresh of any
  // protected page.
  const [username, setUsername] = useState<string | null>(
    () => localStorage.getItem('username')
  );

  // Cased display name (the Lichess username for Lichess sessions, the plain
  // userId for username/password sessions). Shown in the header.
  const [displayName, setDisplayName] = useState<string | null>(
    () => loadSession()?.displayName ?? localStorage.getItem('username')
  );

  // This ref will help us prevent running the effect twice in Strict Mode
  const didInit = useRef(false);

  // On mount, wire up AppInsights for the (possibly already-seeded)
  // username and emit AppLoad. The username state itself is seeded
  // synchronously in the useState initializer above.
  useEffect(() => {
    // Only run if we haven't already
    if (didInit.current) {
      return;
    }
    didInit.current = true;

    const storedName = localStorage.getItem('username');
    if (storedName) {
      setAuthenticatedUserContext(storedName);
    }

    trackEvent("AppLoad");
  }, []);

  // Keep the SessionStore singleton in lockstep with `username`. The
  // eager `GET /variants` on construction primes the cache for the
  // first page after login; `clearSessionStore` on logout drops the
  // cached `(data, etag)` so it can't leak across user sessions.
  useEffect(() => {
    if (!username) {
      clearSessionStore();
      return;
    }
    if (tryGetSessionStore()) return;
    // Rebuild the store from the persisted session on a hard refresh — the
    // credential is auth-mode aware (password vs Lichess Bearer token).
    const loaded = loadCredentialFromStorage();
    if (!loaded) return;
    createSessionStore(loaded.userId, loaded.credential);
  }, [username]);

  const handleLogin = useCallback((user: string) => {
    setUsername(user);
    setDisplayName(loadSession()?.displayName ?? user);
  }, []);

  const handleLogout = () => {
    trackEvent("UserLogout");
    clearAuthenticatedUserContext();
    clearSessionStore();
    setUsername(null);
    setDisplayName(null);
  };

  // Unrecoverable auth failure (dead Lichess session): clear everything,
  // including the persisted session keys, and let SessionExpiredHandler route
  // back to Login.
  const handleSessionExpired = useCallback(() => {
    clearAuthenticatedUserContext();
    clearSessionStore();
    clearStoredSession();
    setLinkedAccounts([]);
    setUsername(null);
    setDisplayName(null);
  }, []);

  return (
    <LichessAuthProvider>
      <div className="app-shell">
        <Router>
          <SessionExpiredHandler onExpire={handleSessionExpired} />
          <PendingLichessLoginRedirect />
          <Header username={username} displayName={displayName} onLogout={handleLogout} />
          <ScrollToTop />
          <main className="app-content">
            <Routes>
              <Route path="/" element={username ? <ProtectedRoute isLoggedIn={!!username}><DashboardPage /></ProtectedRoute> : <LandingPage />} />
              <Route path="/login" element={<LoginPage onLogin={handleLogin} />} />
              <Route path="/training" element={<ProtectedRoute isLoggedIn={!!username}><TrainingPage /></ProtectedRoute>} />
              <Route path="/explorer" element={<ProtectedRoute isLoggedIn={!!username}><ExplorerPage /></ProtectedRoute>} />
              <Route path="/fsrs" element={<ProtectedRoute isLoggedIn={!!username}><FsrsCardListPage /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute isLoggedIn={!!username}><SettingsPage /></ProtectedRoute>} />
              <Route path="/games" element={<ProtectedRoute isLoggedIn={!!username}><GamesPage /></ProtectedRoute>} />
            </Routes>
          </main>
        </Router>
        <ConflictModal />
      </div>
    </LichessAuthProvider>
  );
};

export default App;
