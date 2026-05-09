import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IDataAccessLayer, createDataAccessLayer } from './DataAccessLayer';
import { RepertoireData } from './RepertoireData';
import { WeightSettings } from './WeightSettings';
import { useLichessAuth } from './LichessAuthContext';
import {
    getLinkedAccounts,
    addLinkedAccount,
    removeLinkedAccount,
    LinkedAccount,
    Platform,
    getSyncTimestampKey,
} from './LinkedAccountsService';
import { clearGames } from './GamesDB';
import './SettingsPage.css';

interface CoefficientValues {
    recency: string;
    frequency: string;
    error: string;
}

const SettingsPage: React.FC = () => {
    const [repertoireData, setRepertoireData] = useState<RepertoireData | null>(null);
    const [values, setValues] = useState<CoefficientValues>({ recency: '', frequency: '', error: '' });
    const [loading, setLoading] = useState<boolean>(true);
    const [saving, setSaving] = useState<boolean>(false);
    const [errorMessage, setErrorMessage] = useState<string>('');
    const [lichessLoading, setLichessLoading] = useState(false);
    const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>(() => getLinkedAccounts());
    const [newAccountUsername, setNewAccountUsername] = useState('');
    const [newAccountPlatform, setNewAccountPlatform] = useState<Platform>('lichess');
    const [clearingCache, setClearingCache] = useState(false);
    const [cacheCleared, setCacheCleared] = useState(false);

    const { connected, login, logout } = useLichessAuth();
    const navigate = useNavigate();

    const dal: IDataAccessLayer = useMemo(() => {
        const username = localStorage.getItem('username') || '';
        const hashedPassword = localStorage.getItem('hashedPassword') || '';
        return createDataAccessLayer(username, hashedPassword);
    }, []);

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            setErrorMessage('');
            try {
                const data = await dal.retrieveRepertoireData();
                setRepertoireData(data);
                const settings = WeightSettings.from(data.weightSettings);
                setValues({
                    recency: settings.recencyPower.toString(),
                    frequency: settings.frequencyPower.toString(),
                    error: settings.errorPower.toString()
                });
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                setErrorMessage(`Failed to load settings: ${message}`);
            } finally {
                setLoading(false);
            }
        };

        load();
    }, [dal]);

    const parseCoefficient = (value: string): number | null => {
        const num = Number(value);
        if (!isFinite(num) || num < 0) {
            return null;
        }
        return num;
    };

    const parsedValues = {
        recency: parseCoefficient(values.recency),
        frequency: parseCoefficient(values.frequency),
        error: parseCoefficient(values.error)
    };

    const hasInvalidInput = Object.values(parsedValues).some(v => v === null);
    const referenceSettings = repertoireData?.weightSettings ?? null;
    const hasChanges =
        !hasInvalidInput &&
        referenceSettings !== null &&
        (
            parsedValues.recency !== referenceSettings.recencyPower ||
            parsedValues.frequency !== referenceSettings.frequencyPower ||
            parsedValues.error !== referenceSettings.errorPower
        );

    const handleChange = (field: keyof CoefficientValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
        setValues(prev => ({
            ...prev,
            [field]: event.target.value
        }));
    };

    const handleReset = () => {
        const defaults = WeightSettings.createDefault();
        setValues({
            recency: defaults.recencyPower.toString(),
            frequency: defaults.frequencyPower.toString(),
            error: defaults.errorPower.toString()
        });
        setErrorMessage('');
    };

    const handleCancel = () => {
        navigate(-1);
    };

    const handleSave = async () => {
        if (!repertoireData || hasInvalidInput || saving) {
            return;
        }

        const newSettings = new WeightSettings(
            parsedValues.recency!,
            parsedValues.frequency!,
            parsedValues.error!
        );

        setSaving(true);
        setErrorMessage('');
        try {
            const updatedData: RepertoireData = {
                ...repertoireData,
                weightSettings: newSettings
            };
            await dal.storeRepertoireData(updatedData);
            setRepertoireData(updatedData);
            navigate(-1);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setErrorMessage(`Failed to save settings: ${message}`);
        } finally {
            setSaving(false);
        }
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
            // Clear sync timestamps so next sync does a fresh initial fetch
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

    const renderTable = () => (
        <table className="settings-table">
            <thead>
                <tr>
                    <th>Factor</th>
                    <th>Exponent</th>
                    <th>Description</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>newnessFactor</td>
                    <td className="exponent-cell">
                        <span className="exponent-sign">+</span>
                        <input type="number" value="2" readOnly />
                    </td>
                    <td>Boosts openings played fewer than seven times.</td>
                </tr>
                <tr>
                    <td>recencyFactor</td>
                    <td className="exponent-cell">
                        <span className="exponent-sign">+</span>
                        <input
                            type="number"
                            step="0.1"
                            min="0"
                            value={values.recency}
                            onChange={handleChange('recency')}
                        />
                    </td>
                    <td>Rewards lines that have not been solved recently.</td>
                </tr>
                <tr>
                    <td>frequencyFactor</td>
                    <td className="exponent-cell">
                        <span className="exponent-sign">-</span>
                        <input
                            type="number"
                            step="0.1"
                            min="0"
                            value={values.frequency}
                            onChange={handleChange('frequency')}
                        />
                    </td>
                    <td>Down-weights variants you solve consistently.</td>
                </tr>
                <tr>
                    <td>errorFactor</td>
                    <td className="exponent-cell">
                        <span className="exponent-sign">+</span>
                        <input
                            type="number"
                            step="0.1"
                            min="0"
                            value={values.error}
                            onChange={handleChange('error')}
                        />
                    </td>
                    <td>Prioritizes lines with recent mistakes.</td>
                </tr>
            </tbody>
        </table>
    );

    return (
        <div className="settings-page">
            <div className="settings-card">
                <h1>Weight Settings</h1>
                <p className="settings-description">
                    Tune how strongly each factor contributes to a variant&apos;s training weight.
                    Enter positive values only; higher numbers amplify that part of the formula.
                </p>

                {errorMessage && <div className="settings-error">{errorMessage}</div>}

                {loading ? (
                    <div>Loading...</div>
                ) : (
                    <>
                        {renderTable()}

                        <div className="settings-actions">
                            <button
                                className="primary"
                                onClick={handleSave}
                                disabled={saving || hasInvalidInput || !hasChanges}
                            >
                                {saving ? 'Saving...' : 'Save'}
                            </button>
                            <button className="secondary" onClick={handleCancel} disabled={saving}>
                                Cancel
                            </button>
                            <button className="link" onClick={handleReset} disabled={saving}>
                                Reset
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
