import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { cleanupLegacyIndexedDB } from './utils/cleanupLegacyIDB';

// One-time sweep of legacy IndexedDB stores (no longer used; see BACKLOG.md).
cleanupLegacyIndexedDB();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
