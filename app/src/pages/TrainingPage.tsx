import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import TrainingPageControl from '../components/TrainingPageControl';
import { IDataAccessLayer, createDataAccessLayer } from '../data/DataAccessLayer';
import { RepertoireData } from '../models/RepertoireData';
import { FSRSCardData } from '../models/FSRSCardData';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import { recordTraversal, recordTime, ensureActivity, TraversalStats } from '../services/ActivityService';
import { TimeTracker } from '../services/TimeTracker';
import BadgeRow from '../components/BadgeRow';

const TrainingPage: React.FC = () => {
    const [repertoireData, setRepertoireData] = useState<RepertoireData | null>(null);
    const [error, setError] = useState<string>('');
    const [loading, setLoading] = useState<boolean>(true);
    const [queueStats, setQueueStats] = useState<{ dueCount: number; newCount: number; totalCards: number }>({
        dueCount: 0, newCount: 0, totalCards: 0
    });
    const [reviewedToday, setReviewedToday] = useState<number>(0);

    const repertoireDataRef = useRef<RepertoireData | null>(null);
    const timeTrackerRef = useRef<TimeTracker>(new TimeTracker());

    // Safe to use non-null assertions: ProtectedRoute guarantees credentials
    // exist in localStorage before this component renders.
    const dal: IDataAccessLayer = useMemo(() => {
        const username = localStorage.getItem('username');
        const hashedPassword = localStorage.getItem('hashedPassword');
        if (!username || !hashedPassword) {
            setError('No user session found. Please log in first.');
        }
        return createDataAccessLayer(username!, hashedPassword!);
    }, []);

    // Start time tracker on mount, flush on unmount
    useEffect(() => {
        const tracker = timeTrackerRef.current;
        tracker.start();

        return () => {
            tracker.stop();
            // Flush remaining time on unmount
            const elapsed = tracker.getElapsedSeconds();
            const currentData = repertoireDataRef.current;
            if (currentData && elapsed > 0) {
                ensureActivity(currentData);
                recordTime(currentData, elapsed);
                // Best-effort save (fire-and-forget since component is unmounting)
                dal.storeRepertoireData(currentData).catch(() => { /* best-effort */ });
            }
            tracker.destroy();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dal]);

    // On mount, retrieve data from the server
    useEffect(() => {
        let cancelled = false;

        const fetchData = async () => {
            if (!dal) {
                console.error('DataAccessLayer not initialized');
                return;
            }

            setLoading(true);
            try {
                const data: RepertoireData = await dal.retrieveRepertoireData();
                if (cancelled) return;
                setRepertoireData(data);
                repertoireDataRef.current = data;
                setReviewedToday(data.dailyPlayCount);

                console.log(`DAL: Loaded ${data.data.length} variants.`);
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

    // Convert repertoire data to variants for the engine
    const variants = useMemo(() => {
        if (!repertoireData) return [];
        return RepertoireDataUtils.convertToVariantData(repertoireData);
    }, [repertoireData]);

    // Handle traversal completion: save updated FSRS cards + activity stats
    const handleTraversalComplete = useCallback(async (
        correctCardsRated: number,
        updatedCards: Record<string, FSRSCardData>,
        traversalStats: TraversalStats,
    ) => {
        const currentData = repertoireDataRef.current;
        if (!currentData || !dal) return;

        try {
            // Consume elapsed time from tracker for this traversal
            const elapsed = timeTrackerRef.current.consumeElapsed();

            // Record activity
            ensureActivity(currentData);
            recordTraversal(currentData, traversalStats, elapsed);

            const newData = RepertoireDataUtils.convertToRepertoireData(
                RepertoireDataUtils.convertToVariantData(currentData),
                currentData.dailyPlayCount,
                updatedCards,
                currentData.settings,
                currentData,
            );

            // Update ref immediately but don't trigger engine recreation via setRepertoireData
            repertoireDataRef.current = newData;
            // Reconcile UI with persisted value
            setReviewedToday(newData.dailyPlayCount);
            await dal.storeRepertoireData(newData);

            console.log(`DAL: Saved. dailyPlayCount: ${newData.dailyPlayCount} (+${correctCardsRated})`);
        } catch (e: any) {
            const msg = `Failed to store data: ${e.message || 'Unknown error'}`;
            console.error(msg, e);
            setError(msg);
        }
    }, [dal]);

    const handleQueueStats = useCallback((stats: { dueCount: number; newCount: number; totalCards: number }) => {
        setQueueStats(stats);
    }, []);

    const handleCardRated = useCallback(() => {
        setReviewedToday(prev => prev + 1);
    }, []);

    if (loading) {
        return <div>Loading...</div>;
    }

    if (error) {
        return <div style={{ color: "red" }}>Error: {error}</div>;
    }

    if (!repertoireData || variants.length === 0) {
        return <div>No variants available.</div>;
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
                dueCount={queueStats.dueCount + queueStats.newCount}
                reviewedToday={reviewedToday}
                totalCards={queueStats.totalCards}
            />
            <TrainingPageControl
                variants={variants}
                fsrsCards={repertoireData.fsrsCards ?? {}}
                onTraversalComplete={handleTraversalComplete}
                onQueueStats={handleQueueStats}
                onCardRated={handleCardRated}
            />
        </div>
    );
};

export default TrainingPage;
