import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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

    const handleLoginClick = () => {
        navigate('/login');
    };

    const handleLogoutClick = () => {
        // Close the dropdown (otherwise it would be autoshown after next login)
        setIsDropdownOpen(false);

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
                </nav>
            )}

            {/* Right side */}
            <div className="header-right">
                {username ? (
                    /* Logged in state */
                    <div className="username-dropdown-container" ref={dropdownRef}>
                        <span className="username-text" onClick={toggleDropdown}>
                            <strong>{username}</strong>
                        </span>

                        {/* Conditionally render the dropdown menu */}
                        {isDropdownOpen && (
                            <div className="dropdown-menu">
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
