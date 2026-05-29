import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useLichessAuth } from '../LichessAuthContext';
import {
    getLinkedAccounts,
    setLinkedAccounts,
    LinkedAccount,
    Platform,
    cleanupRemovedAccount,
    getAccountKey,
} from '../services/LinkedAccountsService';
import { clearGames } from '../data/GamesDB';
import { clearMastersCache } from '../services/MastersExplorerService';
import { TrainingEngine } from '../services/TrainingEngine';
import {
    FSRSService,
    RETENTION_PRESETS,
    DEFAULT_RETENTION_PRESET,
    RetentionPreset,
} from '../services/FSRSService';
import { FSRSCardData } from '../models/FSRSCardData';
import { createDataAccessLayer } from '../data/DataAccessLayer';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import './SettingsPage.css';

const SettingsPage: React.FC = () => {
    // Draft state (local to form, not applied until Save)
    const [contextDepth, setContextDepth] = useState<number>(() => TrainingEngine.getContextDepth());
    const [presetId, setPresetId] = useState<RetentionPreset>(
        () => FSRSService.getPresetForRetention(FSRSService.getRetention())
    );
    // Committed preset snapshot — captured at hydrate time so dirty-tracking is
    // not affected if module-level retention changes mid-session.
    const [committedPresetId, setCommittedPresetId] = useState<RetentionPreset>(
        () => FSRSService.getPresetForRetention(FSRSService.getRetention())
    );
    const [fsrsCards, setFsrsCards] = useState<Record<string, FSRSCardData>>({});
    const [linkedAccounts, setLinkedAccountsDraft] = useState<LinkedAccount[]>(() => getLinkedAccounts());
    const [newAccountUsername, setNewAccountUsername] = useState('');
    const [newAccountPlatform, setNewAccountPlatform] = useState<Platform>('lichess');

    // Track removed accounts for deferred cleanup
    const removedAccountsRef = useRef<LinkedAccount[]>([]);

    // Loading state for initial fetch
    const [loading, setLoading] = useState(true);

    // Dirty tracking
    const [isDirty, setIsDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    // Lichess integration (separate, not part of Save/Discard)
    const [lichessLoading, setLichessLoading] = useState(false);
    const { connected, login, logout } = useLichessAuth();

    // Cache clearing
    const [clearingCache, setClearingCache] = useState(false);
    const [cacheCleared, setCacheCleared] = useState(false);

    const [errorMessage, setErrorMessage] = useState<string>('');

    // On mount, fetch RepertoireData to hydrate module-level settings from backend
    useEffect(() => {
        let cancelled = false;
        const hydrate = async () => {
            try {
                const username = localStorage.getItem('username');
                const hashedPassword = localStorage.getItem('hashedPassword');
                if (!username || !hashedPassword) return;

                const dal = createDataAccessLayer(username, hashedPassword);
                const repertoire = await dal.retrieveRepertoireData(); // normalize() hydrates module vars

                if (cancelled) return;
                // Refresh draft state from freshly-hydrated module vars
                setContextDepth(TrainingEngine.getContextDepth());
                const hydratedPreset = FSRSService.getPresetForRetention(FSRSService.getRetention());
                setPresetId(hydratedPreset);
                setCommittedPresetId(hydratedPreset);
                setFsrsCards(repertoire.fsrsCards ?? {});
                setLinkedAccountsDraft(getLinkedAccounts());
            } catch (err: unknown) {
                if (cancelled) return;
                const msg = err instanceof Error ? err.message : String(err);
                setErrorMessage(`Failed to load settings: ${msg}`);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        hydrate();
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Mark dirty when any draft value changes (skip while loading)
    useEffect(() => {
        if (loading) return;
        const committedAccounts = getLinkedAccounts();
        const accountsChanged =
            JSON.stringify(linkedAccounts) !== JSON.stringify(committedAccounts);
        const trainingChanged =
            contextDepth !== TrainingEngine.getContextDepth() ||
            presetId !== committedPresetId;
        setIsDirty(accountsChanged || trainingChanged);
    }, [contextDepth, presetId, committedPresetId, linkedAccounts, loading]);

    const handleDiscard = () => {
        setContextDepth(TrainingEngine.getContextDepth());
        setPresetId(committedPresetId);
        setLinkedAccountsDraft(getLinkedAccounts());
        removedAccountsRef.current = [];
        setIsDirty(false);
        setSaveMessage(null);
    };

    const handleReset = () => {
        setContextDepth(2);
        setPresetId(DEFAULT_RETENTION_PRESET);
        setLinkedAccountsDraft([]);
        // Mark all current committed accounts as removed for cleanup on save
        for (const account of getLinkedAccounts()) {
            if (!removedAccountsRef.current.some(a => a.platform === account.platform && a.username === account.username)) {
                removedAccountsRef.current.push(account);
            }
        }
    };

    const handleSave = async () => {
        setSaving(true);
        setSaveMessage(null);
        setErrorMessage('');

        try {
            const username = localStorage.getItem('username');
            const hashedPassword = localStorage.getItem('hashedPassword');
            if (!username || !hashedPassword) {
                setErrorMessage('Not logged in. Please log in first.');
                return;
            }

            const dal = createDataAccessLayer(username, hashedPassword);
            const current = await dal.retrieveRepertoireData();

            // Resolve preset → (retention, maxInterval) for both backend persistence and runtime.
            const presetCfg = FSRSService.getPresetConfig(presetId);

            // When an account is unlinked, drop its per-account ingest state from
            // the games map so the next ingest run doesn't keep tracking it.
            let nextGames = current.games;
            if (removedAccountsRef.current.length > 0 && current.games) {
                nextGames = { ...current.games };
                for (const removed of removedAccountsRef.current) {
                    delete nextGames[getAccountKey(removed.platform, removed.username)];
                }
            }

            // Build settings from draft values (don't mutate globals until save succeeds)
            const updated = {
                ...current,
                settings: {
                    ...(current.settings ?? {}),
                    contextDepth,
                    retention: presetCfg.retention,
                    maxInterval: presetCfg.maxInterval,
                    linkedAccounts,
                },
                games: nextGames,
            };

            await dal.storeRepertoireData(updated);

            // Apply draft to in-memory services only after save succeeds
            TrainingEngine.setContextDepth(contextDepth);
            FSRSService.setRetention(presetCfg.retention);
            FSRSService.setMaxInterval(presetCfg.maxInterval);
            setLinkedAccounts(linkedAccounts);
            setCommittedPresetId(presetId);

            // Clean up local data for removed accounts after successful save
            for (const removed of removedAccountsRef.current) {
                cleanupRemovedAccount(removed.username, removed.platform);
            }
            removedAccountsRef.current = [];

            setIsDirty(false);
            setSaveMessage({ type: 'success', text: 'Settings saved.' });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMessage(`Failed to save settings: ${msg}`);
        } finally {
            setSaving(false);
        }
    };

    const [addingAccount, setAddingAccount] = useState(false);
    const [addAccountError, setAddAccountError] = useState<string>('');

    const handleAddAccount = async () => {
        const trimmed = newAccountUsername.trim().toLowerCase();
        if (!trimmed) return;
        if (linkedAccounts.some(a => a.platform === newAccountPlatform && a.username === trimmed)) return;

        setAddingAccount(true);
        setAddAccountError('');
        try {
            const url = newAccountPlatform === 'lichess'
                ? `https://lichess.org/api/user/${encodeURIComponent(trimmed)}`
                : `https://api.chess.com/pub/player/${encodeURIComponent(trimmed)}`;
            const resp = await fetch(url);
            if (!resp.ok) {
                setAddAccountError(`User "${trimmed}" not found on ${newAccountPlatform === 'chess.com' ? 'Chess.com' : 'Lichess'}.`);
                return;
            }
        } catch {
            setAddAccountError('Could not verify username. Check your connection and try again.');
            return;
        } finally {
            setAddingAccount(false);
        }

        setLinkedAccountsDraft([...linkedAccounts, { platform: newAccountPlatform, username: trimmed }]);
        setNewAccountUsername('');
    };

    const handleRemoveAccount = (username: string, platform: Platform) => {
        setLinkedAccountsDraft(linkedAccounts.filter(a => !(a.platform === platform && a.username === username)));
        removedAccountsRef.current.push({ username, platform });
    };

    const handleAccountKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); handleAddAccount(); }
    };

    const handleLichessConnect = async () => {
        setLichessLoading(true);
        try { await login(); } finally { setLichessLoading(false); }
    };

    const handleLichessDisconnect = async () => {
        setLichessLoading(true);
        try { await logout(); } finally { setLichessLoading(false); }
    };

    const handleClearCache = async () => {
        setClearingCache(true);
        setCacheCleared(false);
        try {
            await clearGames();
            await clearMastersCache();
            setCacheCleared(true);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMessage(`Failed to clear cache: ${msg}`);
        } finally {
            setClearingCache(false);
        }
    };

    // Live detail panel below the preset selector. Shows the static spec
    // (target recall, miss rate, max interval) plus a deck-based steady-state
    // estimate of daily reviews and mistakes for the selected preset.
    const presetDetails = useMemo(() => {
        const cfg = FSRSService.getPresetConfig(presetId);
        const recallPct = Math.round(cfg.retention * 100);
        const missPct = Math.round((1 - cfg.retention) * 100);
        const load = FSRSService.estimateDailyLoad(fsrsCards, cfg.retention, cfg.maxInterval);
        const hasCards = Object.keys(fsrsCards).length > 0;
        const reviewsDisplay = load.reviewsPerDay >= 10
            ? Math.round(load.reviewsPerDay).toString()
            : load.reviewsPerDay.toFixed(1);
        return (
            <div className="review-intensity-details">
                <div className="review-intensity-spec">
                    Target recall <b>{recallPct}%</b>
                    <span className="review-intensity-sep">·</span>
                    Expected miss rate <b>{missPct}%</b>
                    <span className="review-intensity-sep">·</span>
                    Max <b>{cfg.maxInterval} days</b> between reviews
                </div>
                {hasCards && (
                    <div className="review-intensity-estimate">
                        ≈ <b>{reviewsDisplay}</b> reviews/day
                        <span className="review-intensity-sep">·</span>
                        ≈ <b>{load.mistakesPerDay.toFixed(1)}</b> mistakes/day on your repertoire
                    </div>
                )}
            </div>
        );
    }, [presetId, fsrsCards]);

    return (
        <div className="settings-page">
            <div className="settings-card">
                <h1>Settings</h1>

                {loading ? (
                    <div>Loading settings…</div>
                ) : (
                <>
                {errorMessage && <div className="settings-error">{errorMessage}</div>}
                {saveMessage && (
                    <div className={saveMessage.type === 'success' ? 'cache-success' : 'settings-error'}>
                        {saveMessage.text}
                    </div>
                )}

                {/* ── Training Settings ── */}
                <hr style={{ border: 'none', borderTop: '1px solid #e0e0e0', margin: '1.5rem 0' }} />
                <h2 style={{ marginBottom: '0.5rem', fontSize: '1.1rem' }}>Training</h2>

                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.75rem' }}>
                    <label htmlFor="context-depth" style={{ fontWeight: 500 }}>Context Depth:</label>
                    <input
                        id="context-depth"
                        type="range"
                        min="0"
                        max="10"
                        step="1"
                        value={contextDepth}
                        onChange={(e) => setContextDepth(Math.max(0, Math.min(10, parseInt(e.target.value, 10))))}
                        style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: '2rem', textAlign: 'center', fontWeight: 600, fontSize: '1.1rem' }}>
                        {contextDepth}
                    </span>
                </div>
                <p style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.5rem' }}>
                    Number of your moves shown as warm-up/cool-down around each target position.
                </p>

                <div style={{ marginTop: '1.25rem' }}>
                    <label style={{ fontWeight: 500, display: 'block', marginBottom: '0.5rem' }}>
                        Review Intensity:
                    </label>
                    <div
                        className="review-intensity-presets"
                        role="radiogroup"
                        aria-label="Review intensity"
                    >
                        {RETENTION_PRESETS.map(p => (
                            <label
                                key={p.id}
                                className={`review-intensity-preset${presetId === p.id ? ' selected' : ''}`}
                            >
                                <input
                                    type="radio"
                                    name="review-intensity"
                                    value={p.id}
                                    checked={presetId === p.id}
                                    onChange={() => setPresetId(p.id)}
                                    aria-label={p.label}
                                />
                                <span>{p.label}</span>
                            </label>
                        ))}
                    </div>
                    {presetDetails}
                </div>

                {/* ── Linked Accounts ── */}
                <hr style={{ border: 'none', borderTop: '1px solid #e0e0e0', margin: '1.5rem 0' }} />
                <h2 style={{ marginBottom: '0.5rem', fontSize: '1.1rem' }}>Linked Accounts</h2>
                <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: '1rem' }}>
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
                        onChange={(e) => { setNewAccountUsername(e.target.value); setAddAccountError(''); }}
                        onKeyDown={handleAccountKeyDown}
                        disabled={addingAccount}
                    />
                    <button
                        className="linked-accounts-add-btn"
                        type="button"
                        onClick={handleAddAccount}
                        disabled={!newAccountUsername.trim() || addingAccount}
                    >
                        {addingAccount ? 'Checking…' : 'Add'}
                    </button>
                </div>
                {addAccountError && (
                    <div className="settings-error" style={{ marginTop: '0.5rem' }}>{addAccountError}</div>
                )}

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

                {/* ── Save / Discard / Reset ── */}
                <hr style={{ border: 'none', borderTop: '1px solid #e0e0e0', margin: '1.5rem 0' }} />
                <div className="settings-actions">
                    <button
                        className="primary"
                        onClick={handleSave}
                        disabled={!isDirty || saving}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                        className="secondary"
                        onClick={handleDiscard}
                        disabled={!isDirty || saving}
                    >
                        Discard
                    </button>
                    <button
                        className="secondary"
                        onClick={handleReset}
                        disabled={saving}
                    >
                        Reset to Defaults
                    </button>
                </div>
                </>
                )}
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

            <div className="settings-card">
                <h1>Data Cache</h1>
                <p className="settings-description">
                    Remove all downloaded games and sync timestamps.
                </p>
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
                </div>
            </div>
        </div>
    );
};

export default SettingsPage;
