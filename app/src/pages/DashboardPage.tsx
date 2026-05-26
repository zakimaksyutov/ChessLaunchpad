import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { IDataAccessLayer, createDataAccessLayer } from '../data/DataAccessLayer';
import { RepertoireData, PracticeLogEntry, Activity } from '../models/RepertoireData';
import { FSRSCardData } from '../models/FSRSCardData';
import { FSRSService } from '../services/FSRSService';
import { ensureActivity, computeAccuracy, computeCurrentStreak, computeBestStreak } from '../services/ActivityService';
import { formatDuration, formatDateHeader, formatAccuracy } from '../utils/FormatUtils';
import './DashboardPage.css';

// FSRS states: 0=New, 1=Learning, 2=Review, 3=Relearning
function computeCardBreakdown(fsrsCards: Record<string, FSRSCardData>): {
    total: number; newCount: number; learning: number; reviewDue: number; mastered: number; dueNow: number;
} {
    let total = 0, newCount = 0, learning = 0, reviewDue = 0, mastered = 0, dueNow = 0;
    const now = new Date();

    for (const card of Object.values(fsrsCards)) {
        total++;
        const isDue = (): boolean => {
            const due = FSRSService.computeDueDate(card);
            return now >= due;
        };
        switch (card.st) {
            case 0: newCount++; dueNow++; break;
            case 1: learning++; if (isDue()) dueNow++; break;
            case 2:
                if (isDue()) { reviewDue++; dueNow++; }
                else { mastered++; }
                break;
            case 3: learning++; if (isDue()) dueNow++; break;
        }
    }

    return { total, newCount, learning, reviewDue, mastered, dueNow };
}

function getAccuracyColor(accuracy: number | null): string {
    if (accuracy === null) return '#999';
    if (accuracy >= 0.9) return '#4caf50';
    if (accuracy >= 0.7) return '#ff9800';
    return '#f44336';
}

const DashboardPage: React.FC = () => {
    const navigate = useNavigate();
    const [repertoireData, setRepertoireData] = useState<RepertoireData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const dal: IDataAccessLayer | null = useMemo(() => {
        const username = localStorage.getItem('username');
        const hashedPassword = localStorage.getItem('hashedPassword');
        if (!username || !hashedPassword) return null;
        return createDataAccessLayer(username, hashedPassword);
    }, []);

    useEffect(() => {
        let cancelled = false;
        if (!dal) {
            setLoading(false);
            return;
        }

        (async () => {
            try {
                const data = await dal.retrieveRepertoireData();
                if (cancelled) return;
                ensureActivity(data);
                setRepertoireData(data);
            } catch (e: any) {
                if (cancelled) return;
                setError(e.message || 'Failed to load data');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [dal]);

    if (loading) return <div className="dashboard-loading">Loading dashboard…</div>;
    if (error) return <div className="dashboard-error">Error: {error}</div>;
    if (!repertoireData) return <div className="dashboard-error">No data available.</div>;

    const activity: Activity = repertoireData.activity ?? { practiceLog: [], lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 } };
    const fsrsCards = repertoireData.fsrsCards ?? {};
    const cards = computeCardBreakdown(fsrsCards);

    // Today's entry
    const today = activity.practiceLog.length > 0
        ? activity.practiceLog[activity.practiceLog.length - 1]
        : null;

    const currentStreak = computeCurrentStreak(activity.practiceLog);
    const bestStreak = computeBestStreak(activity.practiceLog);

    return (
        <div className="dashboard">
            {/* Call to Action */}
            <div className="dashboard-cta">
                <button
                    className="dashboard-cta-button"
                    onClick={() => navigate('/training')}
                >
                    {cards.dueNow > 0
                        ? `🚀 Start Training (${cards.dueNow} due)`
                        : '🚀 Start Training'}
                </button>
            </div>

            <div className="dashboard-grid">
                {/* Today's Session */}
                <div className="dashboard-widget">
                    <h3 className="widget-title">📅 Today's Session</h3>
                    {today && (today.reviewed + today.mistakes + today.learned > 0) ? (
                        <div className="widget-stats">
                            <StatRow label="Reviewed" value={today.reviewed} />
                            <StatRow label="Mistakes" value={today.mistakes} />
                            <StatRow label="Learned" value={today.learned} />
                            <StatRow label="Traversals" value={today.traversals} />
                            <StatRow label="Time" value={formatDuration(today.timeSeconds)} />
                            <StatRow label="Cards due" value={cards.dueNow} />
                        </div>
                    ) : (
                        <p className="widget-empty">No training yet today. Start a session!</p>
                    )}
                </div>

                {/* Lifetime Stats */}
                <div className="dashboard-widget">
                    <h3 className="widget-title">📊 Lifetime Stats</h3>
                    <div className="widget-stats">
                        <StatRow label="Total reviewed" value={activity.lifetime.reviewed} />
                        <StatRow label="Total mistakes" value={activity.lifetime.mistakes} />
                        <StatRow label="Total learned" value={activity.lifetime.learned} />
                        <StatRow label="Total traversals" value={activity.lifetime.traversals} />
                        <StatRow label="Total time" value={formatDuration(activity.lifetime.timeSeconds)} />
                        <StatRow label="Current streak" value={`${currentStreak} day${currentStreak !== 1 ? 's' : ''}`} />
                        <StatRow label="Best streak" value={`${bestStreak} day${bestStreak !== 1 ? 's' : ''}`} />
                    </div>
                </div>

                {/* Repertoire Summary */}
                <div className="dashboard-widget">
                    <h3 className="widget-title">📚 Repertoire</h3>
                    <div className="widget-stats">
                        <StatRow label="Total cards" value={cards.total} />
                        <StatRow label="New" value={cards.newCount} />
                        <StatRow label="Learning" value={cards.learning} />
                        <StatRow label="Due review" value={cards.reviewDue} />
                        <StatRow label="Mastered" value={cards.mastered} />
                    </div>
                </div>
            </div>

            {/* Activity Feed */}
            <div className="dashboard-activity">
                <h3 className="widget-title">📈 Activity</h3>
                <ActivityFeed entries={[...activity.practiceLog].reverse()} />
            </div>
        </div>
    );
};

// ── Sub-components ──────────────────────────────────────────────────

const StatRow: React.FC<{ label: string; value: string | number; color?: string }> = ({ label, value, color }) => (
    <div className="stat-row">
        <span className="stat-label">{label}</span>
        <span className="stat-value" style={color ? { color } : undefined}>{value}</span>
    </div>
);

const ActivityFeed: React.FC<{ entries: PracticeLogEntry[] }> = ({ entries }) => {
    const activeEntries = entries.filter(e => e.reviewed + e.mistakes + e.learned > 0);

    if (activeEntries.length === 0) {
        return <p className="widget-empty">No activity yet. Start training to build your history!</p>;
    }

    return (
        <div className="activity-feed">
            {activeEntries.map(entry => {
                const hasTraining = entry.reviewed + entry.mistakes > 0;
                const hasLearned = entry.learned > 0;

                const accuracy = computeAccuracy(entry.reviewed, entry.mistakes);

                return (
                    <div key={entry.date} className="activity-day">
                        <div className="activity-date">{formatDateHeader(entry.date)}</div>
                        {hasTraining && (
                            <div className="activity-line">
                                <span>🎯</span>
                                <span>
                                    Trained {entry.reviewed + entry.mistakes} positions
                                    {' · '}{entry.reviewed} correct
                                    {' · '}{entry.mistakes} mistake{entry.mistakes !== 1 ? 's' : ''}
                                    {' · '}<span className="accuracy-badge" style={{ color: getAccuracyColor(accuracy) }}>
                                        {formatAccuracy(accuracy)}
                                    </span>
                                </span>
                            </div>
                        )}
                        {hasTraining && (
                            <div className="activity-line activity-line-sub">
                                <span></span>
                                <span>
                                    {entry.traversals} traversal{entry.traversals !== 1 ? 's' : ''}
                                    {entry.timeSeconds > 0 && ` · ${formatDuration(entry.timeSeconds)}`}
                                </span>
                            </div>
                        )}
                        {hasLearned && (
                            <div className="activity-line">
                                <span>📘</span>
                                <span>Learned {entry.learned} new position{entry.learned !== 1 ? 's' : ''}</span>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default DashboardPage;
