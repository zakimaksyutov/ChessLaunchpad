import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { clearGames } from '../data/GamesDB';
import { getLinkedAccounts, setLinkedAccounts } from '../services/LinkedAccountsService';
import './Header.css';  // Import the CSS file

interface HeaderProps {
    username: string | null;
    onLogout: () => void;
}

const Header: React.FC<HeaderProps> = ({ username, onLogout }) => {
    const navigate = useNavigate();

    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // If user clicks *anywhere* outside the dropdown, close it
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (
                dropdownRef.current &&
                !dropdownRef.current.contains(event.target as Node)
            ) {
                setIsDropdownOpen(false);
            }
        }

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []);

    const toggleDropdown = () => {
        setIsDropdownOpen((prev) => !prev);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleDropdown();
        } else if (e.key === 'Escape') {
            setIsDropdownOpen(false);
        }
    };

    const handleLoginClick = () => {
        navigate('/login');
    };

    const handleSettingsClick = () => {
        setIsDropdownOpen(false);
        navigate('/settings');
    };

    const handleLogoutClick = () => {
        // Close the dropdown (otherwise it would be autoshown after next login)
        setIsDropdownOpen(false);

        // Clear Games data (IndexedDB + per-account sync timestamps).
        clearGames().catch(() => { /* best-effort */ });

        // Per-account sync watermarks live in localStorage and are keyed by
        // platform+username. Iterate the current in-memory LinkedAccountsService
        // cache (the source of truth for the active session) and also any
        // residual legacy localStorage list, so we clean up regardless of
        // which write path created them.
        const accountsToClean: Array<{ platform: string; username: string }> = [];
        for (const a of getLinkedAccounts()) {
            accountsToClean.push({ platform: a.platform, username: a.username });
        }
        const linkedRaw = localStorage.getItem('chesslaunchpad:linkedAccounts');
        if (linkedRaw) {
            try {
                const legacy = JSON.parse(linkedRaw) as { platform?: string; username: string }[];
                for (const a of legacy) {
                    accountsToClean.push({ platform: a.platform || 'lichess', username: a.username });
                }
            } catch { /* ignore malformed */ }
        }
        for (const a of accountsToClean) {
            // Remove new-format watermark
            localStorage.removeItem(`chesslaunchpad:lastSyncTimestamp:${a.platform}:${a.username}`);
            // Remove legacy-format watermark
            localStorage.removeItem(`chesslaunchpad:lastSyncTimestamp:${a.username}`);
        }
        localStorage.removeItem('chesslaunchpad:linkedAccounts');

        // Reset the in-memory LinkedAccountsService cache so a subsequent
        // login as a different user does not inherit the previous user's
        // accounts before normalize() runs.
        setLinkedAccounts([]);

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
            <Link to="/" className="header-title-link">
                <div className="header-title">Chess Launchpad</div>
            </Link>

            {/* Middle Section: Menu items (only if logged in) */}
            {username && (
                <nav className="header-nav">
                    <Link to="/training" className="header-nav-link">Training</Link>
                    <Link to="/repertoire" className="header-nav-link">Repertoire</Link>
                    <Link to="/games" className="header-nav-link">Games</Link>
                </nav>
            )}

            {/* Right side */}
            <div className="header-right">
                {username ? (
                    /* Logged in state */
                    <div className="username-dropdown-container" ref={dropdownRef}>
                        <span
                            className="username-text"
                            onClick={toggleDropdown}
                            onKeyDown={handleKeyDown}
                            tabIndex={0}
                            role="button"
                            aria-expanded={isDropdownOpen}
                            aria-haspopup="true"
                        >
                            <strong>{username}</strong>
                        </span>

                        {/* Conditionally render the dropdown menu */}
                        {isDropdownOpen && (
                            <div className="dropdown-menu">
                                <button onClick={handleSettingsClick}>Settings</button>
                                <button onClick={handleLogoutClick}>Logout</button>
                            </div>
                        )}
                    </div>
                ) : (
                    /* Logged out state */
                    <button className="login-button" onClick={handleLoginClick}>
                        Login
                    </button>
                )}
            </div>
        </header>
    );
};

export default Header;
