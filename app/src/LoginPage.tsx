import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from "react-router-dom";
import { PublicClientApplication, Configuration, AuthenticationResult } from '@azure/msal-browser';
import { derivePassword } from './HashPassword';
import { IDataAccessLayer, DataAccessError, createDataAccessLayer } from './DataAccessLayer';
import { trackEvent, setAuthenticatedUserContext } from './AppInsights';

// MSAL configuration for Microsoft authentication
const msalConfig: Configuration = {
    auth: {
        clientId: 'dc73dfaf-3652-4d96-866a-0110984b3309', // chess-spa-client
        authority: 'https://login.microsoftonline.com/consumers', // Personal accounts only
        redirectUri: window.location.origin
    },
    cache: {
        cacheLocation: 'localStorage',
        storeAuthStateInCookie: false
    }
};

const msalInstance = new PublicClientApplication(msalConfig);

type LoginPageProps = {
    onLogin: (username: string) => void;
};

const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
    const navigate = useNavigate();

    // This ref will help us prevent running the effect twice in Strict Mode
    const didInit = useRef(false);

    useEffect(() => {
        // Only run if we haven't already
        if (didInit.current) {
            return;
        }
        didInit.current = true;

        const storedUser = localStorage.getItem('username');

        if (storedUser) {
            navigate(`/training`);
        }
    }, [navigate]);

    // Toggle between "Sign Up" and "Log In" modes
    const [isSignUp, setIsSignUp] = useState<boolean>(false);

    const [username, setUsername] = useState<string>('');
    const [password, setPassword] = useState<string>('');
    const [confirmPassword, setConfirmPassword] = useState<string>('');
    const [error, setError] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(false);

    const handleLogin = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');
        setIsLoading(true);

        // If we're in Sign Up mode, check if passwords match
        if (isSignUp && password !== confirmPassword) {
            setError('Passwords do not match');
            setIsLoading(false);
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

            // Store the derived password in localStorage (instead of the real password)
            localStorage.setItem('username', username);
            localStorage.setItem('hashedPassword', derivedPassword);

            // Set authenticated context and track event to App Insights
            setAuthenticatedUserContext(username);
            trackEvent(isSignUp ? "UserSignUp" : "UserLogin");

            // Call the parent component's callback to update the username
            onLogin(username);

            // Navigate to the page with main content
            navigate(`/training`);
        } catch (error) {
            console.error(error);

            // The DataAccessLayer throws an Error object,
            // so we can attempt to display its message here:
            if (error instanceof DataAccessError) {
                setError(error.message);
            } else {
                setError('Something went wrong');
            }
        } finally {
            setIsLoading(false);
        }
    };

    const handleMicrosoftLogin = async () => {
        setError('');
        setIsLoading(true);

        try {
            const loginRequest = {
                scopes: ['api://143d11e2-8ee4-4fad-a490-376242ea04d5/user_impersonation', 'openid', 'profile', 'email'],
                prompt: 'select_account'
            };

            await msalInstance.initialize();

            const response: AuthenticationResult = await msalInstance.loginPopup(loginRequest);
            
            if (response.account) {
                const microsoftUsername = response.account.username || response.account.name || 'microsoft_user';
                
                // Store Microsoft authentication info
                localStorage.setItem('username', microsoftUsername);
                localStorage.setItem('microsoftAccessToken', response.accessToken);
                localStorage.setItem('authMethod', 'microsoft');

                // Set authenticated context and track event
                setAuthenticatedUserContext(microsoftUsername);
                trackEvent("UserMicrosoftLogin");

                // Call the parent component's callback
                onLogin(microsoftUsername);

                // Navigate to training page
                navigate('/training');
            }
        } catch (error) {
            console.error('Microsoft login error:', error);
            setError('Microsoft login failed. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: 'auto' }}>
            <h2>{isSignUp ? 'Sign Up' : 'Login'}</h2>

            {/* Microsoft Login Button */}
            <div style={{ marginBottom: '20px' }}>
                <button 
                    type="button"
                    onClick={handleMicrosoftLogin}
                    disabled={isLoading}
                    style={{
                        width: '100%',
                        padding: '12px',
                        backgroundColor: '#0078d4',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        fontSize: '16px',
                        cursor: isLoading ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px'
                    }}
                >
                    <span style={{ fontSize: '18px' }}>🏢</span>
                    {isLoading ? 'Signing in...' : 'Login with Microsoft'}
                </button>
            </div>

            <div style={{ 
                textAlign: 'center', 
                margin: '16px 0', 
                color: '#666',
                fontSize: '14px'
            }}>
                — or —
            </div>

            <form onSubmit={handleLogin}>
                <div style={{ marginBottom: '8px' }}>
                    <label htmlFor="username">Username:</label><br />
                    <input
                        id="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        required
                        autoFocus
                        disabled={isLoading}
                    />
                </div>
                <div style={{ marginBottom: '8px' }}>
                    <label htmlFor="password">Password:</label><br />
                    <input
                        type="password"
                        id="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        disabled={isLoading}
                    />
                </div>

                {/* Show "Confirm Password" only if isSignUp is true */}
                {isSignUp && (
                    <div style={{ marginBottom: '8px' }}>
                        <label htmlFor="confirmPassword">Confirm Password:</label><br />
                        <input
                            type="password"
                            id="confirmPassword"
                            autoComplete="new-password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            required
                            disabled={isLoading}
                        />
                    </div>
                )}
                
                <div style={{ marginBottom: '12px', fontSize: '0.85rem', color: '#555' }}>
                    🔒 Security Note: Your password is securely derived using PBKDF2 in your browser. Only this derived value is sent to our servers — your actual password never leaves your device.
                </div>
                
                <button type="submit" disabled={isLoading} style={{ width: '100%' }}>
                    {isLoading ? 'Please wait...' : (isSignUp ? 'Sign Up' : 'Login')}
                </button>
            </form>

            {error && <p style={{ color: 'red' }}>{error}</p>}

            <hr />

            <button 
                onClick={() => setIsSignUp(!isSignUp)}
                disabled={isLoading}
                style={{ width: '100%' }}
            >
                {isSignUp ? 'Have an account? Log in here.' : 'No account? Sign up here.'}
            </button>
        </div>
    );
};

export default LoginPage;