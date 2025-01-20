import React, { useState, useEffect, useRef } from 'react';
import { HashRouter as Router, Routes, Route, useNavigate } from "react-router-dom";
import Chessboard from './Chessboard';
import { OpeningVariant } from './OpeningVariant';
import { LocalStorageData } from './HistoricalData';
import { HistoricalDataUtils } from './HistoricalDataUtils';
import { MyVariants } from './MyVariants';
import LoginPage from './LoginPage';
import Header from './Header';
import './App.css';

const App: React.FC = () => {
  // Track logged-in user in state
  const [username, setUsername] = useState<string | null>(null);

  const variants: OpeningVariant[] = MyVariants.getVariants();

  // Sort variants by the pgn field
  variants.sort((a, b) => a.pgn.localeCompare(b.pgn));

  const whiteVariants = variants.filter(variant => variant.orientation === 'white');
  const blackVariants = variants.filter(variant => variant.orientation === 'black');

  const whiteRatio = whiteVariants.length / (whiteVariants.length + blackVariants.length);

  const randomOrientation: 'white' | 'black' = Math.random() < whiteRatio ? 'white' : 'black';
  const selectedVariants = randomOrientation === 'white' ? whiteVariants : blackVariants;

  const handleCompletion = () => {
    const data = HistoricalDataUtils.composeHistoricalData(variants);
    LocalStorageData.setHistoricalData(data);
  };

  const historicalData = LocalStorageData.getHistoricalData();
  HistoricalDataUtils.applyHistoricalData(variants, historicalData);

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
      {/* Show "Chess Launchpad" plus optional username and logout button */}
      <Header username={username} onLogout={() => setUsername(null)} />

      <Router>
        <Routes>
          <Route path="/" element={<LoginPage onLogin={(user) => setUsername(user)} />} />
          <Route path="/:username" element={<Chessboard variants={selectedVariants} onCompletion={handleCompletion} orientation={randomOrientation} />} />
        </Routes>

        {/* A sub-component that can navigate when the user logs out */}
        <NavigatorHelper username={username} />
      </Router>
    </div>
  );
};


/**
 * A small helper component inside the Router so we have access to useNavigate.
 * We'll watch the `username` prop. If it becomes null, we navigate to /ChessLaunchpad (the login).
 */
const NavigatorHelper: React.FC<{ username: string | null }> = ({ username }) => {
  const navigate = useNavigate();

  useEffect(() => {
    if (username === null) {
      // means user logged out => go to the login page
      navigate('/');
    }
  }, [username, navigate]);

  return null;
};

export default App;
