import React, { useState, useEffect, useRef } from 'react';
import { HashRouter as Router, Routes, Route } from "react-router-dom";
import Header from './Header';
import LandingPage from './LandingPage';
import LoginPage from './LoginPage';
import TrainingPage from './TrainingPage';
import RepertoirePage from './RepertoirePage';
import VariantPage from './VariantPage';
import SettingsPage from './SettingsPage';
import ProtectedRoute from './ProtectedRoute';
import './App.css';
import { trackEvent, setAuthenticatedUserContext, clearAuthenticatedUserContext } from './AppInsights';

const App: React.FC = () => {
  // Track logged-in user in state
  const [username, setUsername] = useState<string | null>(null);

  // This ref will help us prevent running the effect twice in Strict Mode
  const didInit = useRef(false);

  // On mount, load username from localStorage (if exists)
  useEffect(() => {
    // Only run if we haven't already
    if (didInit.current) {
      return;
    }
    didInit.current = true;

    const storedName = localStorage.getItem('username');
    if (storedName) {
      setUsername(storedName);
      setAuthenticatedUserContext(storedName);
    }

    trackEvent("AppLoad");
  }, []);

  const handleLogout = () => {
    // Track logout event
    trackEvent("UserLogout");
    
    // Clear authenticated user context
    clearAuthenticatedUserContext();
    
    // Clear username state
    setUsername(null);
  };

  return (
    <div>
      <Router>
        <Header username={username} onLogout={handleLogout} />
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage onLogin={(user) => setUsername(user)} />} />
          <Route path="/training" element={<ProtectedRoute><TrainingPage /></ProtectedRoute>} />
          <Route path="/repertoire" element={<ProtectedRoute><RepertoirePage /></ProtectedRoute>} />
          <Route path="/repertoire/variant" element={<ProtectedRoute><VariantPage /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
        </Routes>
      </Router>
    </div>
  );
};

export default App;
