import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import TrainingPageControl from '../components/TrainingPageControl';
import { IDataAccessLayer, createDataAccessLayer } from '../data/DataAccessLayer';
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
        if (!currentData || !dal) return;

        try {
            // Record activity (recordTraversal calls ensureActivity internally)
            recordTraversal(currentData, traversalStats, elapsedSeconds);

            // FSRSService has already mutated currentData.fsrsCards in-place
            // (it's the same flat map reference). prepareDataForSave projects
            // it back into the position dict and produces the persistence blob.
            const blobForSave = RepertoireDataUtils.prepareDataForSave(currentData);

            setReviewedToday(getTodayPlayCount(currentData));
            await dal.storeRepertoireData(blobForSave);

            console.log(`DAL: Saved. reviewed today: ${getTodayPlayCount(currentData)} (+${correctCardsRated})`);
        } catch (e: any) {
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
                reviewCount={queueStats.reviewCount}
                learningCount={queueStats.learningCount}
                newCount={queueStats.newCount}
                reviewedToday={reviewedToday}
                animationTrigger={animationTrigger}
            />
            <TrainingPageControl
                repertoires={repertoireData.repertoires ?? []}
                fsrsCards={repertoireData.fsrsCards ?? {}}
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
