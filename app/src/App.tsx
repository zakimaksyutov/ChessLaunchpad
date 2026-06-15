import React, { useState, useEffect, useRef } from 'react';
import { HashRouter as Router, Routes, Route } from "react-router-dom";
import Header from './components/Header';
import LandingPage from './pages/LandingPage';
import DashboardPage from './pages/DashboardPage';
import LoginPage from './pages/LoginPage';
import TrainingPage from './pages/TrainingPage';
import SettingsPage from './pages/SettingsPage';
import GamesPage from './pages/GamesPage';
import ExplorerPage from './pages/ExplorerPage';
import ProtectedRoute from './components/ProtectedRoute';
import { LichessAuthProvider } from './LichessAuthContext';
import './App.css';
import { trackEvent, setAuthenticatedUserContext, clearAuthenticatedUserContext } from './AppInsights';
import { createSessionStore, clearSessionStore, tryGetSessionStore } from './data/SessionStore';

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
    const hashedPassword = localStorage.getItem('hashedPassword');
    if (!hashedPassword) return;
    if (tryGetSessionStore()) return;
    createSessionStore(username, hashedPassword);
  }, [username]);

  const handleLogout = () => {
    trackEvent("UserLogout");
    clearAuthenticatedUserContext();
    clearSessionStore();
    setUsername(null);
  };

  return (
    <LichessAuthProvider>
      <div>
        <Router>
          <Header username={username} onLogout={handleLogout} />
          <Routes>
            <Route path="/" element={username ? <ProtectedRoute><DashboardPage /></ProtectedRoute> : <LandingPage />} />
            <Route path="/login" element={<LoginPage onLogin={(user) => setUsername(user)} />} />
            <Route path="/training" element={<ProtectedRoute><TrainingPage /></ProtectedRoute>} />
            <Route path="/explorer" element={<ProtectedRoute><ExplorerPage /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
            <Route path="/games" element={<ProtectedRoute><GamesPage /></ProtectedRoute>} />
          </Routes>
        </Router>
      </div>
    </LichessAuthProvider>
  );
};

export default App;
