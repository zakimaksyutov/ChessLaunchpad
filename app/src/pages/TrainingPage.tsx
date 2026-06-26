import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import TrainingPageControl from '../components/TrainingPageControl';
import { getSessionStore } from '../data/SessionStore';
import { DataAccessError } from '../data/DataAccessLayer';
import { RepertoireData } from '../models/RepertoireData';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import { recordTraversal, getTodayPlayCount, TraversalStats } from '../services/ActivityService';
import BadgeRow from '../components/BadgeRow';

const TrainingPage: React.FC = () => {
    const navigate = useNavigate();
    const [repertoireData, setRepertoireData] = useState<RepertoireData | null>(null);
    const [error, setError] = useState<string>('');
    const [loading, setLoading] = useState<boolean>(true);
    const [queueStats, setQueueStats] = useState<{ dueCount: number; newCount: number; reviewCount: number; learningCount: number; totalCards: number }>({
        dueCount: 0, newCount: 0, reviewCount: 0, learningCount: 0, totalCards: 0
    });
    const [reviewedToday, setReviewedToday] = useState<number>(0);
    const [animationTrigger, setAnimationTrigger] = useState<number>(0);

    const repertoireDataRef = useRef<RepertoireData | null>(null);

    const dal = useMemo(() => getSessionStore().createDataAccessProxyLayer(), []);

    // On mount, retrieve data from the server
    useEffect(() => {
        let cancelled = false;

        const fetchData = async () => {
            setLoading(true);
            try {
                const data: RepertoireData = await dal.retrieveRepertoireData();
                if (cancelled) return;
                setRepertoireData(data);
                repertoireDataRef.current = data;
                setReviewedToday(getTodayPlayCount(data));

                const repertoireCount = data.repertoires?.length ?? 0;
                const positionCount = (data.repertoires ?? []).reduce(
                    (sum, r) => sum + Object.keys(r.positions).length, 0,
                );
                console.log(`DAL: Loaded ${repertoireCount} repertoires, ${positionCount} positions.`);
            } catch (e: any) {
                if (cancelled) return;
                const msg = `Failed to load variants: ${e.message || 'Unknown error'}`;
                console.error(msg, e);
                setError(msg);
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        fetchData();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Handle traversal completion: save updated FSRS cards + activity stats
    const handleTraversalComplete = useCallback(async (
        correctCardsRated: number,
        traversalStats: TraversalStats,
        elapsedSeconds: number,
    ) => {
        const currentData = repertoireDataRef.current;
        if (!currentData) return;

        try {
            // Record activity (recordTraversal calls ensureActivity internally).
            //
            // IMPORTANT: recordTraversal is NON-IDEMPOTENT (it does `+=` on
            // entry.reviewed/mistakes/learned/traversals and the lifetime
            // counters). Do NOT wrap the storeRepertoireData call below in a
            // "retry on transient network error" loop — replaying it after a
            // successful-but-perceived-failed save would double-count stats.
            // On 412 conflicts the app-root ConflictModal hard-reloads, which
            // discards the in-memory mutation; that's the only safe recovery.
            recordTraversal(currentData, traversalStats, elapsedSeconds);

            // FSRSService has already mutated currentData.fsrsCards in-place
            // (it's the same flat map reference). prepareDataForSave projects
            // it back into the position dict and produces the persistence blob.
            const blobForSave = RepertoireDataUtils.prepareDataForSave(currentData);

            setReviewedToday(getTodayPlayCount(currentData));
            await dal.storeRepertoireData(blobForSave);

            console.log(`DAL: Saved. reviewed today: ${getTodayPlayCount(currentData)} (+${correctCardsRated})`);
        } catch (e: any) {
            if (e instanceof DataAccessError && e.statusCode === 412) {
                // The app-root <ConflictModal> already fired (via
                // SessionStore.save's notifyConflict) and is showing
                // the Reload prompt. Don't duplicate the message with
                // an inline banner — the modal owns the recovery flow
                // and will hard-reload the page on confirm.
                return;
            }
            const msg = `Failed to store data: ${e.message || 'Unknown error'}`;
            console.error(msg, e);
            setError(msg);
        }
    }, [dal]);

    const handleQueueStats = useCallback((stats: { dueCount: number; newCount: number; reviewCount: number; learningCount: number; totalCards: number }) => {
        setQueueStats(stats);
    }, []);

    const handleCardRated = useCallback(() => {
        setReviewedToday(prev => prev + 1);
        setAnimationTrigger(prev => prev + 1);
    }, []);

    if (loading) {
        return <div>Loading...</div>;
    }

    if (error) {
        return <div style={{ color: "red" }}>Error: {error}</div>;
    }

    const hasContent = (repertoireData?.repertoires ?? []).some(r => Object.keys(r.positions).length > 0);
    if (!repertoireData || !hasContent) {
        // Nothing to train yet. Training is meaningless without positions, and
        // the dashboard owns every onboarding lead (Import PGN, Link account,
        // Analyze games), so hand off there with a nudge instead of stranding
        // the user on a dead-end message.
        return <Navigate to="/" replace state={{ trainingRedirect: true }} />;
    }

    return (
        <div style={{ 
            padding: '0.5rem',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            width: '100%',
            maxWidth: '100vw',
            overflowX: 'hidden'
        }}>
            <BadgeRow
                reviewCount={queueStats.reviewCount}
                learningCount={queueStats.learningCount}
                newCount={queueStats.newCount}
                reviewedToday={reviewedToday}
                animationTrigger={animationTrigger}
            />
            <TrainingPageControl
                repertoires={repertoireData.repertoires ?? []}
                fsrsCards={repertoireData.fsrsCards ?? {}}
                audit={repertoireData.audit}
                onTraversalComplete={handleTraversalComplete}
                onQueueStats={handleQueueStats}
                onCardRated={handleCardRated}
                reviewedToday={reviewedToday}
                onDone={() => navigate('/')}
            />
        </div>
    );
};

export default TrainingPage;
