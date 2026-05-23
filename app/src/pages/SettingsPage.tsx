import React, { useState } from 'react';
import { useLichessAuth } from '../LichessAuthContext';
import {
    getLinkedAccounts,
    addLinkedAccount,
    removeLinkedAccount,
    LinkedAccount,
    Platform,
    getSyncTimestampKey,
} from '../services/LinkedAccountsService';
import { clearGames } from '../data/GamesDB';
import { clearMastersCache } from '../services/MastersExplorerService';
import { TrainingEngine } from '../services/TrainingEngine';
import './SettingsPage.css';

const SettingsPage: React.FC = () => {
    const [contextDepth, setContextDepth] = useState<number>(() => TrainingEngine.getContextDepth());
    const [lichessLoading, setLichessLoading] = useState(false);
    const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>(() => getLinkedAccounts());
    const [newAccountUsername, setNewAccountUsername] = useState('');
    const [newAccountPlatform, setNewAccountPlatform] = useState<Platform>('lichess');
    const [clearingCache, setClearingCache] = useState(false);
    const [cacheCleared, setCacheCleared] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string>('');

    const { connected, login, logout } = useLichessAuth();

    const handleContextDepthChange = (newDepth: number) => {
        const clamped = Math.max(0, Math.min(10, Math.round(newDepth)));
        setContextDepth(clamped);
        TrainingEngine.setContextDepth(clamped);
    };

    const handleLichessConnect = async () => {
        setLichessLoading(true);
        try {
            await login();
        } finally {
            setLichessLoading(false);
        }
    };

    const handleLichessDisconnect = async () => {
        setLichessLoading(true);
        try {
            await logout();
        } finally {
            setLichessLoading(false);
        }
    };

    const handleAddAccount = () => {
        const trimmed = newAccountUsername.trim();
        if (!trimmed) return;
        const updated = addLinkedAccount(trimmed, newAccountPlatform);
        setLinkedAccounts(updated);
        setNewAccountUsername('');
    };

    const handleRemoveAccount = (username: string, platform: Platform) => {
        const updated = removeLinkedAccount(username, platform);
        setLinkedAccounts(updated);
    };

    const handleAccountKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleAddAccount();
        }
    };

    const handleClearCache = async () => {
        setClearingCache(true);
        setCacheCleared(false);
        try {
            await clearGames();
            await clearMastersCache();
            for (const account of linkedAccounts) {
                localStorage.removeItem(getSyncTimestampKey(account.platform, account.username));
            }
            setCacheCleared(true);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMessage(`Failed to clear cache: ${msg}`);
        } finally {
            setClearingCache(false);
        }
    };

    return (
        <div className="settings-page">
            <div className="settings-card">
                <h1>Training Settings</h1>
                <p className="settings-description">
                    Configure how many moves of context are shown before and after the target position during training.
                </p>

                {errorMessage && <div className="settings-error">{errorMessage}</div>}

                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '1rem' }}>
                    <label htmlFor="context-depth" style={{ fontWeight: 500 }}>Context Depth:</label>
                    <input
                        id="context-depth"
                        type="range"
                        min="0"
                        max="10"
                        step="1"
                        value={contextDepth}
                        onChange={(e) => handleContextDepthChange(parseInt(e.target.value, 10))}
                        style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: '2rem', textAlign: 'center', fontWeight: 600, fontSize: '1.1rem' }}>
                        {contextDepth}
                    </span>
                </div>
                <p style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.5rem' }}>
                    Number of your moves shown as warm-up/cool-down around each target position.
                    Higher values provide more context but longer traversals.
                </p>
            </div>

            <div className="settings-card lichess-section">
                <h1>Lichess Integration</h1>
                <p className="settings-description">
                    Connect your Lichess account to improve API rate limits for position analysis.
                </p>
                {connected ? (
                    <div className="lichess-status">
                        <span className="lichess-connected-badge">✓ Connected</span>
                        <button
                            className="secondary"
                            onClick={handleLichessDisconnect}
                            disabled={lichessLoading}
                        >
                            {lichessLoading ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                    </div>
                ) : (
                    <button
                        className="lichess-connect-btn"
                        onClick={handleLichessConnect}
                        disabled={lichessLoading}
                    >
                        {lichessLoading ? 'Connecting…' : '♞ Connect with Lichess'}
                    </button>
                )}
            </div>

            <div className="settings-card linked-accounts-section">
                <h1>Linked Accounts</h1>
                <p className="settings-description">
                    Add Lichess or Chess.com usernames to download and analyze your games on the Games page.
                </p>

                <div className="linked-accounts-add">
                    <select
                        className="linked-accounts-platform-select"
                        value={newAccountPlatform}
                        onChange={(e) => setNewAccountPlatform(e.target.value as Platform)}
                        aria-label="Platform"
                    >
                        <option value="lichess">Lichess</option>
                        <option value="chess.com">Chess.com</option>
                    </select>
                    <input
                        type="text"
                        className="linked-accounts-input"
                        placeholder={newAccountPlatform === 'lichess' ? 'Lichess username' : 'Chess.com username'}
                        aria-label={newAccountPlatform === 'lichess' ? 'Lichess username' : 'Chess.com username'}
                        value={newAccountUsername}
                        onChange={(e) => setNewAccountUsername(e.target.value)}
                        onKeyDown={handleAccountKeyDown}
                    />
                    <button
                        className="linked-accounts-add-btn"
                        type="button"
                        onClick={handleAddAccount}
                        disabled={!newAccountUsername.trim()}
                    >
                        Add
                    </button>
                </div>

                {linkedAccounts.length > 0 && (
                    <ul className="linked-accounts-list">
                        {linkedAccounts.map((account) => (
                            <li key={`${account.platform}:${account.username}`} className="linked-account-item">
                                <span className="linked-account-platform">
                                    {account.platform === 'chess.com' ? '♔' : '♞'}
                                </span>
                                <span className="linked-account-name">
                                    {account.username}
                                    <span className="linked-account-platform-label">
                                        {account.platform === 'chess.com' ? ' (Chess.com)' : ' (Lichess)'}
                                    </span>
                                </span>
                                <button
                                    className="linked-account-remove"
                                    type="button"
                                    onClick={() => handleRemoveAccount(account.username, account.platform)}
                                    aria-label={`Remove ${account.username}`}
                                    title="Remove account"
                                >
                                    ✕
                                </button>
                            </li>
                        ))}
                    </ul>
                )}

                {linkedAccounts.length > 0 && (
                    <div className="cache-section">
                        {cacheCleared && (
                            <div className="cache-success">Cache cleared. Sync Games to re-download.</div>
                        )}
                        <div className="cache-info">
                            <button
                                className="secondary"
                                onClick={handleClearCache}
                                disabled={clearingCache}
                            >
                                {clearingCache ? 'Clearing…' : 'Clear Cache'}
                            </button>
                            <span className="cache-count">
                                Remove all downloaded games and sync timestamps.
                            </span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SettingsPage;
