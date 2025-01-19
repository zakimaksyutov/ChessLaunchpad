import React from 'react';
import './Header.css';  // Import the CSS file

interface HeaderProps {
    username: string | null;
    onLogout: () => void;
}

const Header: React.FC<HeaderProps> = ({ username, onLogout }) => {
    const handleLogout = () => {
        // Clear localStorage items
        localStorage.removeItem('username');
        localStorage.removeItem('hashedPassword');
        // Trigger parent callback to set username to null
        onLogout();
    };

    return (
        <header className="header">
            {/* Left side: Title */}
            <div className="header-title">Chess Launchpad</div>

            {/* Right side: if logged in, show user info + logout */}
            {username && (
                <div className="header-right">
                    <span className="username-text">
                        <strong>{username}</strong>
                    </span>
                    <button className="logout-button" onClick={handleLogout}>
                        Logout
                    </button>
                </div>
            )}
        </header>
    );
};

export default Header;
