import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLichessAuth } from '../LichessAuthContext';
import { setLichessLoginPending, clearLichessLoginPending } from '../data/AuthSession';
import { trackEvent } from '../AppInsights';
import './LandingPage.css';

const LandingPage: React.FC = () => {
    const version = import.meta.env.VITE_BUILD_VERSION;
    const navigate = useNavigate();
    const { login: lichessLogin } = useLichessAuth();
    const [redirecting, setRedirecting] = useState(false);

    // Kick off Lichess OAuth straight from the landing page — the lowest-
    // friction entry for our (Lichess-using) audience. Mirrors LoginPage's
    // initiation: record the pending intent so it survives the full-page
    // redirect; on return PendingLichessLoginRedirect routes to /login where
    // the token exchange resumes. If the redirect can't even start, fall back
    // to /login so the user can retry there.
    const handleLichessSignIn = async () => {
        trackEvent('LandingCtaLichess');
        setRedirecting(true);
        setLichessLoginPending();
        try {
            await lichessLogin();
        } catch (err) {
            console.error('Lichess redirect failed from landing:', err);
            clearLichessLoginPending();
            setRedirecting(false);
            navigate('/login');
        }
    };

    const handleEmailSignUp = () => {
        trackEvent('LandingCtaSignup');
        navigate('/login');
    };

    return (
        <div className="landing">
            <section className="landing-hero">
                <span className="landing-eyebrow">🔥 Spaced-repetition openings trainer</span>
                <h1 className="landing-title">Memorize chess openings — and never forget them</h1>
                <p className="landing-subtitle">
                    Chess Launchpad drills your opening repertoire with adaptive repetition —
                    surfacing each move right before you'd forget it and correcting mistakes the
                    instant you make them.
                </p>

                <div className="landing-cta">
                    <button
                        type="button"
                        className="landing-cta-primary"
                        onClick={handleLichessSignIn}
                        disabled={redirecting}
                    >
                        {redirecting ? 'Redirecting…' : '♞ Get started with Lichess'}
                    </button>
                    <button
                        type="button"
                        className="landing-cta-secondary"
                        onClick={handleEmailSignUp}
                        disabled={redirecting}
                    >
                        or sign up with a username &amp; password
                    </button>
                </div>
            </section>

            <ul className="landing-features">
                <li className="landing-feature">
                    <div className="landing-feature-icon" aria-hidden="true">🧠</div>
                    <h2 className="landing-feature-title">Adaptive repetition</h2>
                    <p className="landing-feature-text">
                        An FSRS schedule reviews every position at the perfect moment, so each rep
                        cements the move order in long-term memory.
                    </p>
                </li>
                <li className="landing-feature">
                    <div className="landing-feature-icon" aria-hidden="true">⚡</div>
                    <h2 className="landing-feature-title">Instant feedback</h2>
                    <p className="landing-feature-text">
                        Play your lines on a live board and get mistakes flagged and corrected the
                        moment they happen.
                    </p>
                </li>
                <li className="landing-feature">
                    <div className="landing-feature-icon" aria-hidden="true">📈</div>
                    <h2 className="landing-feature-title">Track your progress</h2>
                    <p className="landing-feature-text">
                        Clear progress indicators and motivational badges keep you engaged and
                        coming back for the next session.
                    </p>
                </li>
                <li className="landing-feature">
                    <div className="landing-feature-icon" aria-hidden="true">🔎</div>
                    <h2 className="landing-feature-title">Learn from your games</h2>
                    <p className="landing-feature-text">
                        Import your Lichess and Chess.com games to see where you left your prep
                        and slipped, then add the suggested fix straight to your repertoire.
                    </p>
                </li>
            </ul>

            {version && (
                <div className="landing-version">Build version: {version}</div>
            )}
        </div>
    );
};

export default LandingPage;
