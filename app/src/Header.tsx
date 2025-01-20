import React from 'react';
import { useNavigate } from 'react-router-dom';
import './Header.css';  // Import the CSS file

interface HeaderProps {
    username: string | null;
    onLogout: () => void;
}

const Header: React.FC<HeaderProps> = ({ username, onLogout }) => {
    const navigate = useNavigate();

    const handleLoginClick = () => {
        navigate('/login');
    };

    const handleLogoutClick = () => {
        // Clear localStorage items
        localStorage.removeItem('username');
        localStorage.removeItem('hashedPassword');

        // Trigger parent callback to set username to null
        onLogout();

        // Navigate back to landing
        navigate('/');
    };

    return (
        <header className="header">
            {/* Left side: Title */}
            <div className="header-title">Chess Launchpad</div>

            {/* Right side */}
            {username ? (
                /* Logged in state */
                <div className="header-right">
                    <span className="username-text">
                        <strong>{username}</strong>
                    </span>
                    <button className="logout-button" onClick={handleLogoutClick}>
                        Logout
                    </button>
                </div>
            ) : (
                /* Logged out state */
                <div className="header-right">
                    <button className="login-button" onClick={handleLoginClick}>
                        Login
                    </button>
                </div>
            )}
        </header>
    );
};

export default Header;
