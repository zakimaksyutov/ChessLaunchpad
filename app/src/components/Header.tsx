import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PendingEditNotifier } from '../services/PendingEditNotifier';
import { clearClientSessionKeys } from '../services/SessionTeardown';
import { useLichessAuth } from '../LichessAuthContext';
import './Header.css';  // Import the CSS file

interface HeaderProps {
    username: string | null;
    /** Cased name shown in the header (defaults to `username`). */
    displayName?: string | null;
    onLogout: () => void;
}

const Header: React.FC<HeaderProps> = ({ username, displayName, onLogout }) => {
    const navigate = useNavigate();
    const { logout: lichessOAuthLogout } = useLichessAuth();

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

        // Game records live on the synced repertoire blob — no on-device
        // game cache survives logout. Any leftover legacy localStorage
        // sync-watermark keys from before the games-refactor are harmless
        // (the new ingest pipeline reads watermarks from the blob's
        // `data.games[*].watermarkMs`); the boot-time IDB cleanup also
        // sweeps the retired stores.

        // Reset the LinkedAccountsService cache + clear every persisted
        // session key. The returned mode is captured *before* the clear: a
        // Lichess-login session must also disconnect (revoke) the underlying
        // Lichess OAuth connection, since for a Lichess login that connection
        // *is* the sign-in. A password account that merely linked Lichess in
        // Settings keeps its connection.
        const mode = clearClientSessionKeys();

        if (mode === 'lichess') {
            void lichessOAuthLogout();
        }

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
                            <strong>{displayName ?? username}</strong>
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
