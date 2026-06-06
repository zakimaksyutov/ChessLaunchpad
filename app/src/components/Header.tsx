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

    // Subscribe to the Explorer's pending-edit signal so we can dim the
    // Training link and warn the user — Training shares the repertoire
    // blob with Explorer, so kicking off a training session while edits
    // are pending would race on the same data.
    const [editsPending, setEditsPending] = useState(() => PendingEditNotifier.isPending());
    useEffect(() => {
        return PendingEditNotifier.subscribe(setEditsPending);
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

    /**
     * Synchronous confirm guard for imperative navigations that would
     * destroy unsaved Explorer edits. Returns true if it's safe to proceed
     * (either no edits pending, or the user confirmed the discard).
     *
     * Anchor `<Link>` clicks are guarded by a separate document-level
     * listener inside `ExplorerPage` — that listener doesn't see calls to
     * React Router's imperative `navigate()` from outside the page, so the
     * Settings menu item and the Logout button need their own gate.
     */
    const guardDestructiveNav = (): boolean => {
        if (!PendingEditNotifier.isPending()) return true;
        return window.confirm(
            'You have unsaved repertoire edits. Leaving this page will discard them. Continue?',
        );
    };

    const handleSettingsClick = () => {
        if (!guardDestructiveNav()) return;
        setIsDropdownOpen(false);
        navigate('/settings');
    };

    const handleLogoutClick = () => {
        if (!guardDestructiveNav()) return;
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

    return (
        <header className="header">
            {/* Left side: Title */}
            <Link to="/" className="header-title-link">
                <div className="header-title">Chess Launchpad</div>
            </Link>

            {/* Middle Section: Menu items (only if logged in) */}
            {username && (
                <nav className="header-nav">
                    <Link
                        to="/training"
                        className={`header-nav-link ${editsPending ? 'header-nav-link-disabled' : ''}`}
                        title={editsPending
                            ? 'Save or discard your repertoire edits in Explorer first.'
                            : undefined}
                        aria-disabled={editsPending || undefined}
                    >
                        Training
                    </Link>
                    <Link to="/explorer" className="header-nav-link">Explorer</Link>
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
