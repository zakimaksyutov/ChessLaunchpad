import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useLichessAuth } from '../LichessAuthContext';
import {
    getLinkedAccounts,
    setLinkedAccounts,
    LinkedAccount,
    Platform,
    getAccountKey,
} from '../services/LinkedAccountsService';
import { purgeRecordsForAccounts } from '../services/GameRecordStore';
import { TrainingEngine } from '../services/TrainingEngine';
import {
    FSRSService,
    RETENTION_PRESETS,
    DEFAULT_RETENTION_PRESET,
    RetentionPreset,
} from '../services/FSRSService';
import { FSRSCardData } from '../models/FSRSCardData';
import { RepertoireData } from '../models/RepertoireData';
import { getSessionStore, clearSessionStore } from '../data/SessionStore';
import { isLichessSession, loadSession } from '../data/AuthSession';
import { clearClientSessionKeys } from '../services/SessionTeardown';
import { clearSyncThrottle } from '../services/SyncThrottle';
import { trackEvent } from '../AppInsights';
import { DataAccessError } from '../data/DataAccessLayer';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import { encodePersistedBlob, decodePersistedBlob } from '../utils/BlobCodec';
import './SettingsPage.css';

// Survives the Lichess OAuth full-page redirect so the post-redirect mount can
// attribute the established connection to a Settings-initiated "Connect".
const LICHESS_CONNECT_PENDING_KEY = 'lichess_connect_pending';

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
    const { connected, ready: lichessReady, login, logout } = useLichessAuth();
    // For a Lichess-login session the OAuth connection *is* the sign-in, so the
    // separate connect/disconnect section is redundant and hidden.
    const isLichessLogin = useMemo(() => isLichessSession(), []);

    // Import/Export
    const [importing, setImporting] = useState(false);
    const importInputRef = useRef<HTMLInputElement>(null);

    const [errorMessage, setErrorMessage] = useState<string>('');

    // Delete-account flow (Danger Zone). Two-step: the "Delete account" button
    // reveals a typed-confirmation gate before the destructive call fires.
    const [deleteRevealed, setDeleteRevealed] = useState(false);
    const [deleteConfirmText, setDeleteConfirmText] = useState('');
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string>('');
    const deleteConfirmInputRef = useRef<HTMLInputElement>(null);
    const deleteTriggerRef = useRef<HTMLButtonElement>(null);
    // Canonical account id (lowercased username) used both as the DELETE
    // target and as the value the user must type to confirm.
    const accountUsername = useMemo(
        () => loadSession()?.userId ?? localStorage.getItem('username') ?? '',
        [],
    );
    const accountDisplayName = useMemo(
        () => loadSession()?.displayName ?? accountUsername,
        [accountUsername],
    );
    const deleteConfirmMatches =
        accountUsername.length > 0 &&
        deleteConfirmText.trim().toLowerCase() === accountUsername.toLowerCase();

    // Move focus into the typed-confirmation input when the gate is revealed,
    // so keyboard/screen-reader users land on the step they need to complete.
    useEffect(() => {
        if (deleteRevealed) deleteConfirmInputRef.current?.focus();
    }, [deleteRevealed]);

    const revealDelete = () => {
        setDeleteError('');
        setDeleteConfirmText('');
        setDeleteRevealed(true);
    };

    const cancelDelete = () => {
        setDeleteRevealed(false);
        setDeleteConfirmText('');
        setDeleteError('');
        // Return focus to the trigger once it re-mounts.
        requestAnimationFrame(() => deleteTriggerRef.current?.focus());
    };

    // On mount, fetch RepertoireData to hydrate module-level settings from backend
    useEffect(() => {
        let cancelled = false;
        const hydrate = async () => {
            try {
                const dal = getSessionStore().createDataAccessProxyLayer();
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
        trackEvent('SettingsReset');
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
            const dal = getSessionStore().createDataAccessProxyLayer();
            const current = await dal.retrieveRepertoireData();

            // Resolve preset → (retention, maxInterval) for both backend persistence and runtime.
            const presetCfg = FSRSService.getPresetConfig(presetId);

            // When an account is unlinked, drop its per-account ingest state from
            // the games map so the next ingest run doesn't keep tracking it,
            // and purge its display records from the activity log so the /games
            // page stops showing them. Counters (`ingested` / `reviewed` /
            // `mistakes`) are intentionally not rewritten — historical activity
            // remains visible on the Dashboard.
            let nextGames = current.games;
            if (removedAccountsRef.current.length > 0 && current.games) {
                nextGames = { ...current.games };
                for (const removed of removedAccountsRef.current) {
                    delete nextGames[getAccountKey(removed.platform, removed.username)];
                }
            }
            if (removedAccountsRef.current.length > 0 && current.activity) {
                const removedLower = new Set(
                    removedAccountsRef.current.map(a => a.username.toLowerCase()),
                );
                purgeRecordsForAccounts(current.activity, removedLower);
            }

            // Build settings from draft values (don't mutate globals until save succeeds).
            current.settings = {
                ...(current.settings ?? {}),
                contextDepth,
                retention: presetCfg.retention,
                maxInterval: presetCfg.maxInterval,
                linkedAccounts,
            };
            current.games = nextGames;

            // prepareDataForSave projects the in-memory `repertoires` + flat
            // `fsrsCards` map into the position-centric blob shape. We need
            // it here even though we only changed settings — to keep every
            // persist path producing identical wire formats.
            const blobForSave = RepertoireDataUtils.prepareDataForSave(current);

            await dal.storeRepertoireData(blobForSave);

            // Telemetry: report only the settings that actually changed in this
            // save. Account deltas are a net diff of committed vs draft, so an
            // add-then-remove of the same account within one unsaved session
            // reports nothing. Read the committed values here, before the
            // in-memory mutations below overwrite them.
            const settingsSavedProps: Record<string, string | number> = {};
            if (contextDepth !== TrainingEngine.getContextDepth()) {
                settingsSavedProps.ContextDepth = contextDepth;
            }
            if (presetId !== committedPresetId) {
                settingsSavedProps.ReviewIntensity = presetId;
            }
            const committedAccountKeys = new Set(
                getLinkedAccounts().map(a => getAccountKey(a.platform, a.username)),
            );
            const draftAccountKeys = new Set(
                linkedAccounts.map(a => getAccountKey(a.platform, a.username)),
            );
            const addedAccounts = linkedAccounts.filter(
                a => !committedAccountKeys.has(getAccountKey(a.platform, a.username)),
            );
            const removedAccounts = getLinkedAccounts().filter(
                a => !draftAccountKeys.has(getAccountKey(a.platform, a.username)),
            );
            const countByPlatform = (accounts: LinkedAccount[], platform: Platform) =>
                accounts.filter(a => a.platform === platform).length;
            if (countByPlatform(addedAccounts, 'lichess')) {
                settingsSavedProps.AddedLichess = countByPlatform(addedAccounts, 'lichess');
            }
            if (countByPlatform(addedAccounts, 'chess.com')) {
                settingsSavedProps.AddedChessCom = countByPlatform(addedAccounts, 'chess.com');
            }
            if (countByPlatform(removedAccounts, 'lichess')) {
                settingsSavedProps.RemovedLichess = countByPlatform(removedAccounts, 'lichess');
            }
            if (countByPlatform(removedAccounts, 'chess.com')) {
                settingsSavedProps.RemovedChessCom = countByPlatform(removedAccounts, 'chess.com');
            }
            settingsSavedProps.TotalLinked = linkedAccounts.length;
            trackEvent('SettingsSaved', settingsSavedProps);

            // Apply draft to in-memory services only after save succeeds
            TrainingEngine.setContextDepth(contextDepth);
            FSRSService.setRetention(presetCfg.retention);
            FSRSService.setMaxInterval(presetCfg.maxInterval);
            setLinkedAccounts(linkedAccounts);
            setCommittedPresetId(presetId);

            // Newly linked accounts have no games downloaded yet, so the
            // Dashboard's actions list stays empty until the next provider
            // sync. The auto-sync that runs on Dashboard mount is gated by the
            // 5-minute throttle (services/SyncThrottle.ts), which an earlier
            // zero-account visit may already have stamped. Forget that stamp so
            // returning to the Dashboard syncs the just-linked account right
            // away instead of waiting out the cooldown. (Removals don't need a
            // re-download, so only clear when accounts were actually added.)
            if (addedAccounts.length > 0) {
                clearSyncThrottle();
            }

            removedAccountsRef.current = [];

            setIsDirty(false);
            setSaveMessage({ type: 'success', text: 'Settings saved.' });
        } catch (err: unknown) {
            if (err instanceof DataAccessError && err.statusCode === 412) {
                // The app-root <ConflictModal> already fired and owns
                // the recovery flow. Skip the inline error banner so
                // we don't surface a duplicate message under the modal.
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                setErrorMessage(`Failed to save settings: ${msg}`);
            }
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
        // Mark the intent before redirecting so the post-redirect mount can
        // distinguish a fresh connect from merely opening Settings while
        // already connected.
        localStorage.setItem(LICHESS_CONNECT_PENDING_KEY, '1');
        try { await login(); } finally { setLichessLoading(false); }
    };

    const handleLichessDisconnect = async () => {
        setLichessLoading(true);
        try {
            await logout();
            trackEvent('SettingsLichessDisconnected');
        } finally {
            setLichessLoading(false);
        }
    };

    // After returning from the Lichess OAuth redirect, emit SettingsLichessConnected for
    // a connect this page initiated. The intent flag distinguishes a fresh
    // connect from a revisit while already connected; a denied auth returns
    // not-connected, so the flag is cleared without emitting.
    useEffect(() => {
        if (!lichessReady) return;
        if (localStorage.getItem(LICHESS_CONNECT_PENDING_KEY) !== '1') return;
        localStorage.removeItem(LICHESS_CONNECT_PENDING_KEY);
        if (connected) trackEvent('SettingsLichessConnected');
    }, [lichessReady, connected]);

    // ── Import / Export ────────────────────────────────────────────────
    //
    // Relocated from the now-removed Repertoire page. Since the variant
    // editor is gone, Import is the only in-app way to seed a fresh
    // repertoire — so it must (a) decode and validate the file, (b) round-
    // trip cleanly through normalize() so module-level state (FSRSService /
    // TrainingEngine / LinkedAccountsService) is correctly hydrated, and
    // (c) confirm before destroying existing data.
    //
    // Only v3 `.chess` files are accepted; pre-v3 (legacy variant-PGN)
    // files are rejected by `decodePersistedBlob` with a clear error.

    const FILE_EXTENSION = 'chess';

    const handleExport = async () => {
        try {
            const username = localStorage.getItem('username') || '';
            if (!username) {
                setErrorMessage('Not logged in. Please log in first.');
                return;
            }
            const dal = getSessionStore().createDataAccessProxyLayer();
            const current = await dal.retrieveRepertoireData();
            const blob = RepertoireDataUtils.prepareDataForSave(current);
            const persisted = encodePersistedBlob(blob);

            const json = JSON.stringify(persisted);
            const file = new Blob([json], { type: 'application/json' });

            const positionCount = (blob.repertoires ?? []).reduce(
                (sum, r) => sum + Object.keys(r.positions).length, 0,
            );
            const now = new Date().toISOString();
            const filename = `Repertoire-${username}-${now}-${positionCount} positions.${FILE_EXTENSION}`;

            const url = URL.createObjectURL(file);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            trackEvent('SettingsBackupExport');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMessage(`Failed to export: ${msg}`);
        }
    };

    const handleDeleteAccount = async () => {
        if (!deleteConfirmMatches || deleting) return;
        setDeleteError('');
        setDeleting(true);
        try {
            // Goes through SessionStore so the request is authorized for both
            // password and Lichess sessions; a 404 is treated as success.
            await getSessionStore().deleteAccount();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setDeleteError(`Failed to delete account: ${msg}`);
            setDeleting(false);
            return;
        }

        trackEvent("UserDelete");

        // Account is gone on the backend — tear down the client session and
        // send the user back to the landing page, fully logged out. We have no
        // parent logout handler here, so we clear the SessionStore ourselves
        // and force a full reload: App re-reads (now-empty) session storage on
        // boot and renders logged-out.
        const mode = clearClientSessionKeys();
        clearSessionStore();

        // Revoke any live Lichess OAuth connection. For a Lichess login the
        // connection *is* the sign-in; a password account may *also* have
        // linked Lichess in Settings (`connected`), and deleting the account
        // should erase that too rather than leak it to the next user on this
        // browser. Best-effort and time-bounded so a slow/unreachable
        // lichess.org can't strand the user on a page whose account no longer
        // exists (the comment-vs-code mismatch the reviewers flagged).
        if (mode === 'lichess' || connected) {
            try {
                await Promise.race([
                    logout(),
                    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
                ]);
            } catch { /* ignore */ }
        }

        window.location.hash = '#/';
        window.location.reload();
    };

    const handleImportFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        const file = files[0];

        const text = await file.text();
        // Reset the input so re-selecting the same file fires onChange again.
        e.target.value = '';

        let parsed: RepertoireData;
        try {
            const raw = JSON.parse(text);
            // `decodePersistedBlob` accepts only the v3 wire shape (array of
            // positions, `"<SAN>:<idx>"` move keys, packed cards). After this,
            // `parsed` is in the in-memory shape that `normalize()` expects.
            // Pre-v3 (variant-PGN) blobs are rejected with a clear error.
            parsed = decodePersistedBlob(raw);
        } catch (ex: unknown) {
            const msg = ex instanceof Error ? ex.message : String(ex);
            alert(`Failed to import: ${msg || 'file is not valid JSON.'}`);
            return;
        }

        // Validate + count positions WITHOUT triggering normalize() (which
        // has live side effects on FSRSService / TrainingEngine / linked
        // accounts module vars). We only want to mutate global state once
        // the user has confirmed the destructive replace.
        const positionCount = (parsed.repertoires ?? []).reduce(
            (sum, r) => sum + Object.keys(r.positions).length, 0,
        );

        if (positionCount === 0 && !window.confirm(
            'The imported file contains no positions. Continue and overwrite your repertoire with an empty one?'
        )) {
            return;
        }
        if (!window.confirm(
            `Import will REPLACE your existing repertoire with ${positionCount} position(s). ` +
            'You may want to Export first if you plan to restore later.\n\nProceed?'
        )) {
            return;
        }

        setImporting(true);
        try {
            const store = getSessionStore();
            // Run normalization (snaps retention to preset, hydrates the
            // flat fsrsCards map, synthesizes New cards for graph edges
            // missing one) so the import lands in the same shape a live
            // GET would produce. prepareDataForSave then projects back
            // into the position-centric wire form.
            RepertoireDataUtils.normalize(parsed);
            const blobForSave = RepertoireDataUtils.prepareDataForSave(parsed);
            await store.importBlob(blobForSave);
            trackEvent('SettingsBackupImport');
            // Full reload so all pages re-fetch the new repertoire.
            window.location.reload();
        } catch (ex: unknown) {
            if (ex instanceof DataAccessError && ex.statusCode === 412) {
                // The app-root <ConflictModal> already fired and owns
                // the Reload prompt. A native alert() here would be
                // worse than the modal — it would block until the user
                // dismisses it, intercepting focus from the modal.
            } else {
                const msg = ex instanceof Error ? ex.message : String(ex);
                alert(`Failed to import: ${msg}`);
            }
        } finally {
            setImporting(false);
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

            {!isLichessLogin && (
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
            )}

            <div className="settings-card">
                <h1>Repertoire Backup</h1>
                <p className="settings-description">
                    Export your full repertoire (positions, FSRS card states, settings, and activity)
                    to a <code>.chess</code> file, or replace your current repertoire with one from a file.
                </p>
                <p className="settings-description" style={{ fontSize: '0.85rem', color: '#666' }}>
                    Import will replace your entire repertoire — export first if you want a backup.
                </p>
                <div className="cache-info" style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                        className="secondary"
                        onClick={handleExport}
                        disabled={importing}
                    >
                        Export
                    </button>
                    <button
                        className="secondary"
                        onClick={() => importInputRef.current?.click()}
                        disabled={importing}
                    >
                        {importing ? 'Importing…' : 'Import'}
                    </button>
                    <input
                        type="file"
                        ref={importInputRef}
                        style={{ display: 'none' }}
                        accept=".chess"
                        onChange={handleImportFileSelected}
                    />
                </div>
            </div>

            {/* ── Danger Zone: permanent account deletion ── */}
            <div className="settings-card danger-zone">
                <h1>Danger Zone</h1>
                <p className="settings-description">
                    Deleting your account <strong>permanently removes</strong> your entire
                    repertoire, FSRS progress, linked accounts, and settings from the server.
                    This <strong>cannot be undone.</strong>
                </p>
                <p className="settings-description" style={{ fontSize: '0.9rem' }}>
                    We strongly recommend exporting a <code>.chess</code> backup first — it's the
                    only way to restore your repertoire later.
                </p>
                <div className="danger-actions">
                    <button
                        className="secondary"
                        onClick={handleExport}
                        disabled={deleting}
                    >
                        Export backup first
                    </button>
                    {!deleteRevealed && (
                        <button
                            ref={deleteTriggerRef}
                            className="danger-button"
                            onClick={revealDelete}
                        >
                            Delete account…
                        </button>
                    )}
                </div>

                {deleteRevealed && (
                    <div className="danger-confirm" role="group" aria-label="Confirm account deletion">
                        <p className="danger-confirm-warning" id="danger-confirm-warning">
                            This will permanently delete the account
                            {' '}<strong>{accountDisplayName}</strong> and all of its data.
                            To confirm, type your username
                            {' '}<code>{accountUsername}</code> below.
                        </p>
                        <input
                            ref={deleteConfirmInputRef}
                            type="text"
                            className="danger-confirm-input"
                            placeholder="Type your username to confirm"
                            value={deleteConfirmText}
                            onChange={(e) => setDeleteConfirmText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && deleteConfirmMatches && !deleting) {
                                    e.preventDefault();
                                    void handleDeleteAccount();
                                }
                            }}
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            disabled={deleting}
                            aria-label="Type your username to confirm account deletion"
                            aria-describedby="danger-confirm-warning"
                        />
                        {deleteError && (
                            <div className="settings-error" role="alert" style={{ marginTop: '0.75rem' }}>
                                {deleteError}
                            </div>
                        )}
                        <div className="danger-actions" style={{ marginTop: '0.75rem' }}>
                            <button
                                className="secondary"
                                onClick={cancelDelete}
                                disabled={deleting}
                            >
                                Cancel
                            </button>
                            <button
                                className="danger-button"
                                onClick={handleDeleteAccount}
                                disabled={!deleteConfirmMatches || deleting}
                            >
                                {deleting ? 'Deleting…' : 'Permanently delete account'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SettingsPage;
