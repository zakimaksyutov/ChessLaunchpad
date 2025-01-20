import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from "react-router-dom";
import { hashPassword } from './HashPassword';

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
            navigate(`/${storedUser}`);
        }
    }, [navigate]);

    // Toggle between "Sign Up" and "Log In" modes
    const [isSignUp, setIsSignUp] = useState<boolean>(false);

    const [username, setUsername] = useState<string>('');
    const [password, setPassword] = useState<string>('');
    const [confirmPassword, setConfirmPassword] = useState<string>('');
    const [error, setError] = useState<string>('');

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');

        // If we're in Sign Up mode, check if passwords match
        if (isSignUp && password !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        try {
            // 1) Derive a new "hashed password" from the user's raw password
            // This is one-way hash and from backend API perspective this will represent the user's password.
            // The real password will not be sent to the backend.
            // Also, the hashed password will be stored in localStorage for future requests. While this makes it vulnerable to XSS attacks,
            // since the data in this app is not sensitive (worst case - someone can read or delete opening variants), the main
            // effort was made not to store a password in plain text in case a user uses this password in other more critical places.
            const hashedPassword = await hashPassword(password);

            let response: Response;
            if (isSignUp) {
                // 2a) Create a new user account
                response = await fetch(`https://chess-prod-function.azurewebsites.net/api/user/${username}`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': hashedPassword
                    }
                });
            } else {
                // 2b) Try to retrieve the user's variants to validate that password is correct
                response = await fetch(`https://chess-prod-function.azurewebsites.net/api/user/${username}/variants`, {
                    headers: {
                        'Authorization': hashedPassword
                    }
                });
            }

            // 3) Check if successful
            if (!response.ok) {
                const msg = await response.text();
                setError(msg || 'Something went wrong');
                return;
            }

            // 4) Store the derived password in localStorage (instead of the real password)
            localStorage.setItem('username', username);
            localStorage.setItem('hashedPassword', hashedPassword);

            // 5) Call the parent component's callback to update the username
            onLogin(username);

            // 6) Navigate to the page with main content
            navigate(`/${username}`);
        } catch (error) {
            console.error(error);
            setError('Something went wrong');
        }
    };

    return (
        <div style={{ maxWidth: '400px', margin: 'auto' }}>
            <h2>{isSignUp ? 'Sign Up' : 'Login'}</h2>

            <form onSubmit={handleSubmit}>
                <div style={{ marginBottom: '8px' }}>
                    <label htmlFor="username">Username:</label><br />
                    <input
                        id="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        required
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