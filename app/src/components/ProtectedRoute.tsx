import React from 'react';
import { Navigate } from 'react-router-dom';

interface ProtectedRouteProps {
    children: React.ReactNode;
}

/**
 * Checks if user is logged in.
 * If yes, render children. If not, navigate to landing page.
 */
const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
    const isLoggedIn = !!localStorage.getItem('username');
    if (!isLoggedIn) {
        // Not logged in => go to landing page
        return <Navigate to="/" replace />;
    }

    return <>{children}</>;
};

export default ProtectedRoute;
