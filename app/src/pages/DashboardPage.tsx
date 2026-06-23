import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { State } from 'ts-fsrs';
import { getSessionStore } from '../data/SessionStore';
import { RepertoireData, PracticeLogEntry, Activity } from '../models/RepertoireData';
import { FSRSCardData } from '../models/FSRSCardData';
import { FSRSService, RETENTION_PRESETS } from '../services/FSRSService';
import { ensureActivity, computeAccuracy, getCurrentStreak, getBestStreak, getTodayDateString, findEntryByDate, entryHasAnyActivity } from '../services/ActivityService';
import { formatDuration, formatDateHeader, formatAccuracy, formatTimeUntil } from '../utils/FormatUtils';
import { runIngest, IngestProgress } from '../services/GameIngestService';
import { isSyncThrottled, markSyncedNow, getLastSyncAt } from '../services/SyncThrottle';
import './DashboardPage.css';

function computeCardBreakdown(fsrsCards: Record<string, FSRSCardData>): {
    total: number; newCount: number; learning: number; reviewDue: number; mastered: number; dueNow: number;
    nextDueAt: Date | null;
} {
    let total = 0, newCount = 0, learning = 0, reviewDue = 0, mastered = 0, dueNow = 0;
    let nextDueMs: number | null = null;
    const now = new Date();
    const nowMs = now.getTime();

    for (const card of Object.values(fsrsCards)) {
        total++;
        const due = FSRSService.computeDueDate(card);
        const dueMs = due.getTime();
        const isDue = nowMs >= dueMs;
        if (!isDue && (nextDueMs === null || dueMs < nextDueMs)) {
            nextDueMs = dueMs;
        }
        switch (card.state as State) {
            case State.New: newCount++; dueNow++; break;
            case State.Learning: learning++; if (isDue) dueNow++; break;
            case State.Review:
                if (isDue) { reviewDue++; dueNow++; }
                else { mastered++; }
                break;
            case State.Relearning: learning++; if (isDue) dueNow++; break;
        }
    }

    return {
        total, newCount, learning, reviewDue, mastered, dueNow,
        nextDueAt: nextDueMs === null ? null : new Date(nextDueMs),
    };
}

function getAccuracyColor(accuracy: number | null): string {
    if (accuracy === null) return '#999';
    if (accuracy >= 0.9) return '#4caf50';
    if (accuracy >= 0.7) return '#ff9800';
    return '#f44336';
}

function formatSyncTime(d: Date): string {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

type SyncState =
    | { phase: 'syncing' }
    | { phase: 'synced'; at: Date };

const DashboardPage: React.FC = () => {
    const navigate = useNavigate();
    const [repertoireData, setRepertoireData] = useState<RepertoireData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [syncStatus, setSyncStatus] = useState<SyncState | null>(() => {
        // Seed from the shared last-sync time so a throttled first paint shows
        // the real "Synced @ HH:MM" instead of nothing while we decide whether
        // to auto-sync.
        const last = getLastSyncAt();
        return last !== null ? { phase: 'synced', at: new Date(last) } : null;
    });

    // Stays true while the component is mounted; flipped to false on real
    // unmount and explicitly re-set to true on every effect run so that
    // React.StrictMode's synthetic mount→unmount→remount cycle doesn't leave
    // the ref stuck at false (refs are preserved across the synthetic cycle).
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    // Lock against overlapping sync cycles (auto + manual button + double-click).
    const syncInFlightRef = useRef(false);

    // Page-scoped AbortController for `runIngest` so navigation away
    // from /dashboard cancels its in-flight HTTP fetches and skips
    // its final PUT — eliminating the sync-vs-training 412 race.
    //
    // StrictMode caveat: cleanup defers `.abort()` by a tick so the
    // synthetic remount can clear the pending timer before it fires.
    // See docs/DAL-REFACTOR.md "StrictMode caveat".
    const pageAbortRef = useRef<AbortController | null>(null);
    const pendingAbortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const dal = useMemo(() => getSessionStore().createDataAccessProxyLayer(), []);

    const runSyncCycle = useCallback(async (force = false) => {
        if (!mountedRef.current) return;
        if (syncInFlightRef.current) return;
        const ctrl = pageAbortRef.current;
        if (ctrl?.signal.aborted) return;
        // Throttle the automatic provider game-download: if we queried the
        // providers less than SYNC_THROTTLE_MS ago, skip the auto run and just
        // reflect the shared last-sync time. The manual ↻ button passes
        // `force` to bypass this. See services/SyncThrottle.ts.
        if (!force && isSyncThrottled()) {
            const last = getLastSyncAt();
            if (last !== null) setSyncStatus({ phase: 'synced', at: new Date(last) });
            return;
        }
        syncInFlightRef.current = true;

        const handleProgress = (progress: IngestProgress) => {
            if (!mountedRef.current) return;
            if (progress.phase === 'fetching') {
                // Coalesce all per-account fetching events into a single "syncing"
                // state — the widget header has limited width and the i/N suffix
                // is more noise than signal for the typical single-account user.
                setSyncStatus(prev => (prev?.phase === 'syncing' ? prev : { phase: 'syncing' }));
                return;
            }
            // 'done' — both success-with-imports and success-empty/failure are
            // treated the same: stamp the time and show "Synced @ HH:MM". This
            // matches the existing silent-error contract (rare failures aren't
            // worth a distinct "Sync failed" badge here). Source the displayed
            // time from the shared throttle stamp (set below) so both pages
            // agree on "last sync".
            setSyncStatus({ phase: 'synced', at: new Date(getLastSyncAt() ?? Date.now()) });
        };

        try {
            // Stamp the moment we commit to querying the providers (start, not
            // completion) so rapid back-and-forth navigation and StrictMode
            // remounts see a fresh time and don't re-fetch.
            markSyncedNow();
            const summary = await runIngest(dal, handleProgress, ctrl?.signal);
            if (!mountedRef.current || !summary.didWrite) return;
            const refreshed = await dal.retrieveRepertoireData();
            if (!mountedRef.current) return;
            ensureActivity(refreshed);
            setRepertoireData(refreshed);
        } catch {
            // Ingest errors (including aborts) must never disrupt the UI.
        } finally {
            syncInFlightRef.current = false;
        }
    }, [dal]);

    useEffect(() => {
        // Clear any pending abort from a prior cleanup — we're back
        // (real or StrictMode-synthetic remount).
        if (pendingAbortTimerRef.current) {
            clearTimeout(pendingAbortTimerRef.current);
            pendingAbortTimerRef.current = null;
        }
        // Lazy so the controller survives the synthetic mount → unmount
        // → remount cycle (don't recreate on every effect run).
        if (!pageAbortRef.current) {
            pageAbortRef.current = new AbortController();
        }
        const controller = pageAbortRef.current;

        (async () => {
            try {
                const data = await dal.retrieveRepertoireData();
                if (!mountedRef.current) return;
                ensureActivity(data);
                setRepertoireData(data);
                setLoading(false);

                // Chain ingest after the initial load resolves. Sequencing here
                // serves two purposes:
                //   (1) avoids a race where the initial load resolves *after*
                //       the post-ingest refresh and overwrites it with stale data;
                //   (2) ensures the linked-accounts cache has been hydrated by
                //       the blob load before any consumer might rely on it.
                runSyncCycle();
            } catch (e: any) {
                if (!mountedRef.current) return;
                setError(e.message || 'Failed to load data');
                setLoading(false);
            }
        })();

        return () => {
            // Defer the abort by a tick — a StrictMode synthetic remount
            // runs cleanup → next-effect synchronously and the next-effect
            // clears this timer. Real navigation has no follow-up effect
            // → timer fires → ingest aborts.
            pendingAbortTimerRef.current = setTimeout(() => {
                pendingAbortTimerRef.current = null;
                controller.abort();
                // Drop our ref so any future effect run gets a fresh one.
                if (pageAbortRef.current === controller) {
                    pageAbortRef.current = null;
                }
            }, 0);
        };
    }, [dal, runSyncCycle]);

    if (loading) return <div className="dashboard-loading">Loading dashboard…</div>;
    if (error) return <div className="dashboard-error">Error: {error}</div>;
    if (!repertoireData) return <div className="dashboard-error">No data available.</div>;

    const activity: Activity = repertoireData.activity ?? { practiceLog: [], lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 } };
    const fsrsCards = repertoireData.fsrsCards ?? {};
    const cards = computeCardBreakdown(fsrsCards);

    // Today's entry — look up by date so newly-ingested games on past dates
    // don't shift the "today" detection.
    const today = findEntryByDate(activity, getTodayDateString());

    const currentStreak = getCurrentStreak(activity);
    const bestStreak = getBestStreak(activity);

    const presetId = FSRSService.getPresetForRetention(FSRSService.getRetention());
    const preset = RETENTION_PRESETS.find(p => p.id === presetId) ?? RETENTION_PRESETS[2];

    const version = import.meta.env.VITE_BUILD_VERSION;

    return (
        <div className="dashboard">
            <div>
                {/* Call to Action */}
                <div className="dashboard-cta">
                    <button
                        className="dashboard-cta-button"
                        onClick={() => navigate('/training')}
                    >
                        {cards.dueNow > 0
                            ? `Start Training (${cards.dueNow} due)`
                            : 'Start Training'}
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
                            {cards.dueNow === 0 && cards.nextDueAt && (
                                <StatRow label="Next due" value={formatTimeUntil(cards.nextDueAt)} />
                            )}
                            <div className="stat-row">
                                <span className="stat-label">Training intensity</span>
                                <Link
                                    to="/settings"
                                    className="stat-value training-intensity-link"
                                    title="Click to change in Settings"
                                >
                                    {preset.label}
                                </Link>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Activity Feed */}
                <div className="dashboard-activity">
                    <h3 className="widget-title widget-title-row">
                        <span>📈 Activity</span>
                        {syncStatus && (
                            <span className="widget-sync-controls">
                                <SyncStatusIndicator status={syncStatus} />
                                <button
                                    type="button"
                                    className="widget-sync-button"
                                    onClick={() => runSyncCycle(true)}
                                    disabled={syncStatus.phase === 'syncing'}
                                    title="Sync games now"
                                    aria-label="Sync games now"
                                >
                                    ↻
                                </button>
                            </span>
                        )}
                    </h3>
                    <ActivityFeed entries={[...activity.practiceLog].reverse()} />
                </div>
            </div>

            {version && (
              <div style={{
                fontSize: '0.7rem',
                color: '#666',
                fontStyle: 'italic',
                textAlign: 'center',
                paddingTop: '1rem',
                paddingBottom: '0.5rem'
              }}>
                Build version: {version}
              </div>
            )}
        </div>
    );
};

// ── Sub-components ──────────────────────────────────────────────────

const SyncStatusIndicator: React.FC<{ status: SyncState }> = ({ status }) => {
    if (status.phase === 'syncing') {
        return (
            <span
                className="widget-sync-status widget-sync-status-active"
                role="status"
                aria-live="polite"
                title="Syncing games from linked accounts"
            >
                <span className="widget-sync-spinner" aria-hidden="true" />
                <span>Syncing games…</span>
            </span>
        );
    }
    return (
        <span
            className="widget-sync-status"
            role="status"
            aria-live="polite"
            title={`Last sync at ${status.at.toLocaleString()}`}
        >
            Synced @ {formatSyncTime(status.at)}
        </span>
    );
};

const StatRow: React.FC<{ label: string; value: string | number; color?: string }> = ({ label, value, color }) => (
    <div className="stat-row">
        <span className="stat-label">{label}</span>
        <span className="stat-value" style={color ? { color } : undefined}>{value}</span>
    </div>
);

const ActivityFeed: React.FC<{ entries: PracticeLogEntry[] }> = ({ entries }) => {
    const activeEntries = entries.filter(entryHasAnyActivity);

    if (activeEntries.length === 0) {
        return <p className="widget-empty">No activity yet. Start training to build your history!</p>;
    }

    return (
        <div className="activity-feed">
            {activeEntries.map(entry => {
                const hasTraining = entry.reviewed + entry.mistakes > 0;
                const hasLearned = entry.learned > 0;
                const gameIngested = entry.games?.ingested ?? 0;
                const hasGames = gameIngested > 0;

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
                        {hasGames && (
                            <div className="activity-line">
                                <span>⚔️</span>
                                <span>
                                    Played {gameIngested} game{gameIngested !== 1 ? 's' : ''}
                                    {' · '}{entry.games!.reviewed} correct
                                    {' · '}
                                    {entry.games!.mistakes > 0 ? (
                                        <span className="repertoire-mistake">
                                            {entry.games!.mistakes} repertoire mistake{entry.games!.mistakes !== 1 ? 's' : ''}
                                        </span>
                                    ) : (
                                        <>{entry.games!.mistakes} repertoire mistakes</>
                                    )}
                                </span>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default DashboardPage;
