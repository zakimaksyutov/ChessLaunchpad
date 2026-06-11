import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { cleanupLegacyIndexedDB } from './utils/cleanupLegacyIDB';

// One-time sweep of IndexedDB stores retired by GAMES-REFACTOR.
cleanupLegacyIndexedDB();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
