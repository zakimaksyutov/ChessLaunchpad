import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from "react-router-dom";
import { useLichessAuth } from '../LichessAuthContext';
import { derivePassword } from '../utils/HashPassword';
import { IDataAccessLayer, DataAccessError, createDataAccessLayer } from '../data/DataAccessLayer';
import { createSessionStore, clearSessionStore, getSessionStore } from '../data/SessionStore';
import {
    LichessCredential,
    persistPasswordSession,
    persistLichessSession,
    isLichessLoginPending,
    setLichessLoginPending,
    clearLichessLoginPending,
    telemetryUserId,
} from '../data/AuthSession';
import {
    exchangeLichessToken,
    createLichessAccount,
    fetchLichessDisplayName,
} from '../services/LichessAccountAuth';
import { setLinkedAccounts } from '../services/LinkedAccountsService';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import { trackEvent, setAuthenticatedUserContext } from '../AppInsights';
import './LoginPage.css';

type LoginPageProps = {
    onLogin: (username: string) => void;
};

// Single user-facing message for any Lichess sign-in failure or cancellation;
// the spec intentionally avoids leaking specific causes.
const LICHESS_GENERIC_ERROR = 'Could not sign in with Lichess. Please try again.';

const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
    const navigate = useNavigate();
    const { ready: lichessReady, token: lichessToken, login: lichessLogin } = useLichessAuth();

    // This ref will help us prevent running the effect twice in Strict Mode
    const didInit = useRef(false);

    useEffect(() => {
        // Only run if we haven't already
        if (didInit.current) {
            return;
        }
        didInit.current = true;

        const storedUser = localStorage.getItem('username');

        // Don't auto-redirect while a Lichess sign-in is mid-flight: the
        // session is not established until the exchange resumes below.
        if (storedUser && !isLichessLoginPending()) {
            navigate(`/`);
        }
    }, [navigate]);

    // Toggle between "Sign Up" and "Log In" modes
    const [isSignUp, setIsSignUp] = useState<boolean>(false);

    const [username, setUsername] = useState<string>('');
    const [password, setPassword] = useState<string>('');
    const [confirmPassword, setConfirmPassword] = useState<string>('');
    const [error, setError] = useState<string>('');

    // Lichess sign-in is busy while redirecting out or resuming on return.
    const [lichessBusy, setLichessBusy] = useState<boolean>(
        () => isLichessLoginPending(),
    );
    const resumeStarted = useRef(false);

    const handleLogin = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');

        // If we're in Sign Up mode, check if passwords match
        if (isSignUp && password !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        try {
            // Derive a password using PBKDF2 with username as salt for better security
            // This is a one-way derivation and from backend API perspective this will represent the user's password.
            // The real password will not be sent to the backend.
            const derivedPassword = await derivePassword(password, username);

            const dal: IDataAccessLayer = createDataAccessLayer(username, derivedPassword);
            if (isSignUp) {
                // Create a new user account
                await dal.createAccount();
            } else {
                // Attempt to retrieve the user's variants to validate the password
                await dal.retrieveRepertoireData();
            }

            // Persist the username/password session (clears any prior Lichess keys).
            persistPasswordSession(username, derivedPassword);

            // Construct the SessionStore now so its eager GET /variants
            // overlaps with React's re-render → navigate cycle and the
            // destination page's first proxy retrieve hits a warm cache.
            clearSessionStore();
            createSessionStore(username, derivedPassword);

            // Set authenticated context and track event to App Insights
            setAuthenticatedUserContext(telemetryUserId('password', username));
            trackEvent(isSignUp ? "UserSignUp" : "UserLogin");

            // Call the parent component's callback to update the username
            onLogin(username);

            // Navigate to the dashboard (main content)
            navigate(`/`);
        } catch (error) {
            console.error(error);

            // The DataAccessLayer throws an Error object,
            // so we can attempt to display its message here:
            if (error instanceof DataAccessError) {
                setError(error.message);
            } else {
                setError('Something went wrong');
            }
        }
    };

    // ── Sign in with Lichess ────────────────────────────────────────────

    const finishLichessLogin = useCallback(async (token: string) => {
        setError('');
        try {
            // Exchange the Lichess token for a backend JWT + resolved id.
            // This is the gate: nothing is persisted until it succeeds.
            const { jwt, userId } = await exchangeLichessToken(token);
            const displayName = await fetchLichessDisplayName(userId);
            // First-ever sign-in creates the account; 409 ("already exists")
            // is a normal sign-in.
            const created = await createLichessAccount(userId, jwt);

            // Install the in-memory session so we can seed linked accounts
            // (if newly created) before committing the session to storage.
            clearSessionStore();
            createSessionStore(userId, new LichessCredential(userId, jwt));

            if (created) {
                // Seed Linked Accounts with this Lichess account so the user's
                // own games are ingested with no manual entry — only at creation.
                // Best-effort: a seeding failure must not block sign-in, since
                // the account already exists and the session is valid.
                try {
                    const store = getSessionStore();
                    await store.ready();
                    const dal = store.createDataAccessProxyLayer();
                    const data = await dal.retrieveRepertoireData();
                    const account = { platform: 'lichess' as const, username: userId };
                    data.settings = { ...(data.settings ?? {}), linkedAccounts: [account] };
                    await dal.storeRepertoireData(RepertoireDataUtils.prepareDataForSave(data));
                    setLinkedAccounts([account]);
                } catch (seedErr) {
                    console.warn('Lichess linked-account seeding failed:', seedErr);
                }
            }

            // Commit the session now that everything has succeeded.
            persistLichessSession(userId, displayName, jwt);
            setAuthenticatedUserContext(telemetryUserId('lichess', userId));
            trackEvent(created ? 'UserSignUp' : 'UserLogin');

            clearLichessLoginPending();
            onLogin(userId);
            navigate('/');
        } catch (err) {
            console.error('Lichess sign-in failed:', err);
            // Clear the pending intent and tear down the in-memory store. No
            // Lichess session was ever committed to storage (persist is the
            // last step), so we deliberately do NOT clear stored session keys —
            // that would wipe an unrelated pre-existing session.
            clearLichessLoginPending();
            clearSessionStore();
            setLichessBusy(false);
            setError(LICHESS_GENERIC_ERROR);
        }
    }, [navigate, onLogin]);

    // Resume a pending Lichess login once the OAuth layer has settled after
    // the redirect back from Lichess.
    useEffect(() => {
        if (!lichessReady) return;
        if (!isLichessLoginPending()) return;
        if (resumeStarted.current) return;
        resumeStarted.current = true;

        if (!lichessToken) {
            // The user denied access or the token could not be obtained. No
            // session was committed, so only the pending intent needs clearing.
            clearLichessLoginPending();
            setLichessBusy(false);
            setError(LICHESS_GENERIC_ERROR);
            return;
        }
        finishLichessLogin(lichessToken);
    }, [lichessReady, lichessToken, finishLichessLogin]);

    const handleLichessSignIn = async () => {
        setError('');
        setLichessBusy(true);
        // Record the intent so it survives the full-page redirect.
        setLichessLoginPending();
        try {
            await lichessLogin();
        } catch (err) {
            console.error('Lichess redirect failed:', err);
            clearLichessLoginPending();
            setLichessBusy(false);
            setError(LICHESS_GENERIC_ERROR);
        }
    };

    return (
        <div className="login-page">
            <div className="login-card">
                <h2 className="login-title">{isSignUp ? 'Create your account' : 'Welcome back'}</h2>

                <button
                    type="button"
                    className="login-lichess-btn"
                    onClick={handleLichessSignIn}
                    disabled={lichessBusy}
                >
                    {lichessBusy ? 'Signing in…' : '♞ Sign in with Lichess'}
                </button>

                <div className="login-divider"><span>or</span></div>

                <form onSubmit={handleLogin} className="login-form">
                    <label className="login-label" htmlFor="username">Username</label>
                    <input
                        id="username"
                        className="login-input"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        required
                        autoFocus
                    />

                    <label className="login-label" htmlFor="password">Password</label>
                    <input
                        type="password"
                        id="password"
                        className="login-input"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                    />

                    {/* Show "Confirm Password" only if isSignUp is true */}
                    {isSignUp && (
                        <>
                            <label className="login-label" htmlFor="confirmPassword">Confirm Password</label>
                            <input
                                type="password"
                                id="confirmPassword"
                                className="login-input"
                                autoComplete="new-password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                required
                            />
                        </>
                    )}

                    <button type="submit" className="login-submit" disabled={lichessBusy}>
                        {isSignUp ? 'Sign Up' : 'Log In'}
                    </button>
                </form>

                <div className="login-security-note">
                    🔒 Your password is securely derived using PBKDF2 in your browser. Only this
                    derived value is sent to our servers — your actual password never leaves your device.
                </div>

                {error && <p className="login-error">{error}</p>}

                <button
                    type="button"
                    className="login-toggle"
                    onClick={() => { setIsSignUp(!isSignUp); setError(''); }}
                    disabled={lichessBusy}
                >
                    {isSignUp ? 'Have an account? Log in' : 'No account? Sign up'}
                </button>
            </div>
        </div>
    );
};

export default LoginPage;
