import React, { createContext, useContext, useState, useEffect, useSyncExternalStore, useCallback } from 'react';
import { lichessAuth } from './LichessAuthService';

interface LichessAuthState {
    /** Whether the auth service has finished initializing. */
    ready: boolean;
    /** Whether the user is connected to Lichess. */
    connected: boolean;
    /** The Bearer token, or null. */
    token: string | null;
    /** Redirect to Lichess for login. */
    login: () => Promise<void>;
    /** Disconnect and revoke the token. */
    logout: () => Promise<void>;
}

const LichessAuthContext = createContext<LichessAuthState>({
    ready: false,
    connected: false,
    token: null,
    login: async () => {},
    logout: async () => {},
});

export const useLichessAuth = () => useContext(LichessAuthContext);

export const LichessAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [ready, setReady] = useState(false);

    // Subscribe to the singleton's auth state changes
    const connected = useSyncExternalStore(
        useCallback((cb) => lichessAuth.subscribe(cb), []),
        () => lichessAuth.isConnected()
    );

    const token = useSyncExternalStore(
        useCallback((cb) => lichessAuth.subscribe(cb), []),
        () => lichessAuth.getToken()
    );

    useEffect(() => {
        lichessAuth.init().finally(() => setReady(true));
    }, []);

    const login = useCallback(async () => {
        await lichessAuth.login();
    }, []);

    const logout = useCallback(async () => {
        await lichessAuth.logout();
    }, []);

    return (
        <LichessAuthContext.Provider value={{ ready, connected, token, login, logout }}>
            {children}
        </LichessAuthContext.Provider>
    );
};
