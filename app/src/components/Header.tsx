import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { clearGames } from '../data/GamesDB';
import { getLinkedAccounts, setLinkedAccounts } from '../services/LinkedAccountsService';
import { PendingEditNotifier } from '../services/PendingEditNotifier';
import './Header.css';  // Import the CSS file

interface HeaderProps {
    username: string | null;
    onLogout: () => void;
}

const Header: React.FC<HeaderProps> = ({ username, onLogout }) => {
    const navigate = useNavigate();

    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Subscribe to the Explorer's edit-mode signal. While editing, every
    // header menu item is disabled (title, nav links, username dropdown).
    // The user must Save or Discard from the Explorer page before
    // navigating anywhere — this prevents accidentally losing pending
    // repertoire edits via the header.
    const [inEditMode, setInEditMode] = useState(() => PendingEditNotifier.isInEditMode());
    useEffect(() => {
        return PendingEditNotifier.subscribeEditMode(setInEditMode);
    }, []);

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

    // Close the dropdown automatically whenever edit mode becomes active,
    // so a dropdown that happened to be open doesn't end up with disabled
    // buttons lingering on screen.
    useEffect(() => {
        if (inEditMode) setIsDropdownOpen(false);
    }, [inEditMode]);

    const toggleDropdown = () => {
        if (inEditMode) return;
        setIsDropdownOpen((prev) => !prev);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (inEditMode) return;
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
        // platform+username. Iterate the in-memory LinkedAccountsService cache
        // (the authoritative source for the active session) and clear each
        // account's watermark so a different user logging into this browser
        // doesn't inherit them.
        for (const a of getLinkedAccounts()) {
            localStorage.removeItem(`chesslaunchpad:lastSyncTimestamp:${a.platform}:${a.username}`);
        }

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

    // Block anchor-link navigations from the header while editing. The
    // `<Link>` components below render real `<a>` tags inside HashRouter;
    // adding `pointer-events: none` on them via CSS handles mouse clicks,
    // but keyboard (Enter) and assistive-tech activations bypass that, so
    // we also gate clicks here for full coverage.
    const handleNavClick = (e: React.MouseEvent) => {
        if (inEditMode) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    const navLinkClass = `header-nav-link${inEditMode ? ' header-nav-link-disabled' : ''}`;
    const editModeTitle = inEditMode
        ? 'Save or discard your repertoire edits in Explorer first.'
        : undefined;

    return (
        <header className="header">
            {/* Left side: Title */}
            <Link
                to="/"
                className={`header-title-link${inEditMode ? ' header-title-link-disabled' : ''}`}
                onClick={handleNavClick}
                aria-disabled={inEditMode || undefined}
                title={editModeTitle}
            >
                <div className="header-title">Chess Launchpad</div>
            </Link>

            {/* Middle Section: Menu items (only if logged in) */}
            {username && (
                <nav className="header-nav">
                    <Link
                        to="/training"
                        className={navLinkClass}
                        onClick={handleNavClick}
                        title={editModeTitle}
                        aria-disabled={inEditMode || undefined}
                    >
                        Training
                    </Link>
                    <Link
                        to="/explorer"
                        className={navLinkClass}
                        onClick={handleNavClick}
                        title={editModeTitle}
                        aria-disabled={inEditMode || undefined}
                    >
                        Explorer
                    </Link>
                    <Link
                        to="/games"
                        className={navLinkClass}
                        onClick={handleNavClick}
                        title={editModeTitle}
                        aria-disabled={inEditMode || undefined}
                    >
                        Games
                    </Link>
                </nav>
            )}

            {/* Right side */}
            <div className="header-right">
                {username ? (
                    /* Logged in state */
                    <div className="username-dropdown-container" ref={dropdownRef}>
                        <span
                            className={`username-text${inEditMode ? ' username-text-disabled' : ''}`}
                            onClick={toggleDropdown}
                            onKeyDown={handleKeyDown}
                            tabIndex={inEditMode ? -1 : 0}
                            role="button"
                            aria-expanded={isDropdownOpen}
                            aria-haspopup="true"
                            aria-disabled={inEditMode || undefined}
                            title={editModeTitle}
                        >
                            <strong>{username}</strong>
                        </span>

                        {/* Conditionally render the dropdown menu */}
                        {isDropdownOpen && !inEditMode && (
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
