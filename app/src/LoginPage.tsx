import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from "react-router-dom";
import { hashPassword } from './HashPassword';
import { IDataAccessLayer, DataAccessError, createDataAccessLayer } from './DataAccessLayer';

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

    const handleLogin = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');

        // If we're in Sign Up mode, check if passwords match
        if (isSignUp && password !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        try {
            // Derive a new "hashed password" from the user's raw password
            // This is one-way hash and from backend API perspective this will represent the user's password.
            // The real password will not be sent to the backend.
            // Also, the hashed password will be stored in localStorage for future requests. While this makes it vulnerable to XSS attacks,
            // since the data in this app is not sensitive (worst case - someone can read or delete opening variants), the main
            // effort was made not to store a password in plain text in case a user uses this password in other more critical places.
            const hashedPassword = await hashPassword(password);

            const dal: IDataAccessLayer = createDataAccessLayer(username, hashedPassword);
            if (isSignUp) {
                // Create a new user account
                await dal.createAccount();
            } else {
                // Attempt to retrieve the user's variants to validate the password
                await dal.retrieveRepertoireData();
            }

            // Store the derived password in localStorage (instead of the real password)
            localStorage.setItem('username', username);
            localStorage.setItem('hashedPassword', hashedPassword);

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
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: 'auto' }}>
            <h2>{isSignUp ? 'Sign Up' : 'Login'}</h2>

            <form onSubmit={handleLogin}>
                <div style={{ marginBottom: '8px' }}>
                    <label htmlFor="username">Username:</label><br />
                    <input
                        id="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        required
                        autoFocus
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
                        />
                    </div>
                )}
                
                <div style={{ marginBottom: '12px', fontSize: '0.85rem', color: '#555' }}>
                    🔒 Security Note: Your password is hashed locally in your browser. Only the hash is sent to our servers — your actual password never leaves your device.
                </div>
                
                <button type="submit">
                    {isSignUp ? 'Sign Up' : 'Login'}
                </button>
            </form>

            {error && <p style={{ color: 'red' }}>{error}</p>}

            <hr />

            <button onClick={() => setIsSignUp(!isSignUp)}>
                {isSignUp ? 'Have an account? Log in here.' : 'No account? Sign up here.'}
            </button>
        </div>
    );
};

export default LoginPage;