import React, { useState, useEffect, useRef } from 'react';
import { HashRouter as Router, Routes, Route } from "react-router-dom";
import Header from './Header';
import LandingPage from './LandingPage';
import LoginPage from './LoginPage';
import TrainingPage from './TrainingPage';
import './App.css';

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
    }
  }, []);

  return (
    <div>
      <Router>
        <Header username={username} onLogout={() => setUsername(null)} />
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage onLogin={(user) => setUsername(user)} />} />
          <Route path="/training" element={<TrainingPage />} />
        </Routes>
      </Router>
    </div>
  );
};

export default App;
