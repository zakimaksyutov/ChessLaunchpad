import React, { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom'; // to read query params
import TrainingPageControl from './TrainingPageControl';
import { OpeningVariant } from './OpeningVariant';
import { IDataAccessLayer, createDataAccessLayer } from './DataAccessLayer';
import { RepertoireData } from './RepertoireData';
import { RepertoireDataUtils } from './RepertoireDataUtils';
import BadgeRow from './BadgeRow';
import { WeightSettings } from './WeightSettings';
import { buildNormalizedFensFromPgn, isLikelyFen, normalizeFenResetHalfmoveClock } from './FenUtils';

interface OrientationAndVariants {
    orientation: 'white' | 'black';
    selectedVariants: OpeningVariant[];
    allVariants: OpeningVariant[];
}

const TrainingPage: React.FC = () => {
    const [repertoireData, setRepertoireData] = useState<RepertoireData | null>(null);
    const [orientationAndVariants, setOrientationAndVariants] = useState<OrientationAndVariants | null>(null);
    const [error, setError] = useState<string>('');
    const [loading, setLoading] = useState<boolean>(true);

    const [searchParams] = useSearchParams();
    const filterParam = searchParams.get('filter') ?? '';

    const dal: IDataAccessLayer = useMemo(() => {
        const username = localStorage.getItem('username');
        const hashedPassword = localStorage.getItem('hashedPassword');
        if (!username || !hashedPassword) {
            setError('No user session found. Please log in first.');
        }
        return createDataAccessLayer(username!, hashedPassword!);
    }, []);

    // On mount, retrieve data from the server and merge with local
    useEffect(() => {
        const fetchVariants = async () => {
            if (!dal) {
                console.error('DataAccessLayer not initialized');
                return;
            }

            setLoading(true);
            try {
                const data: RepertoireData = await dal.retrieveRepertoireData();
                setRepertoireData(data);
                setOrientationAndVariants(pickOrientationAndVariants(data, filterParam));

                console.log(`DAL: Loaded ${data.data.length} variants.`);
            } catch (e: any) {
                const msg = `Failed to load variants: ${e.message || 'Unknown error'}`;
                console.error(msg, e);
                setError(msg);
            } finally {
                setLoading(false);
            }
        };

        fetchVariants();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filterParam]); // run once on mount

    const pickOrientationAndVariants = (repertoireData: RepertoireData, filter: string): OrientationAndVariants => {
        const allVariants = RepertoireDataUtils.convertToVariantData(repertoireData);

        // Only *logically* filter if filter is provided
        let variants = allVariants;
        if (filter.trim()) {
            const trimmed = filter.trim();
            if (isLikelyFen(trimmed)) {
                const normalizedFilter = normalizeFenResetHalfmoveClock(trimmed);
                variants = variants.filter((v) =>
                    buildNormalizedFensFromPgn(v.pgn).includes(normalizedFilter)
                );
            } else {
                const lowerFilter = trimmed.toLowerCase();
                variants = variants.filter((v) =>
                    v.classifications.some((cls) => cls.toLowerCase().includes(lowerFilter))
                );
            }
        }
        
        const whiteVariants: OpeningVariant[] = variants.filter(v => v.orientation === 'white');
        const blackVariants: OpeningVariant[] = variants.filter(v => v.orientation === 'black');

        // Guard against zero-length arrays:
        if (whiteVariants.length === 0 && blackVariants.length === 0) {
            return {
                orientation: 'white' as const,
                selectedVariants: [] as OpeningVariant[],
                allVariants
            };
        }

        // Decide orientation based on ratio
        const whiteRatio: number = whiteVariants.length / (whiteVariants.length + blackVariants.length);
        const orientation: 'white' | 'black' = Math.random() < whiteRatio ? 'white' : 'black';
        const selectedVariants: OpeningVariant[] = orientation === 'white' ? whiteVariants : blackVariants;
        return { 
            allVariants,
            orientation,
            selectedVariants
        };
    };

    // Handle completion of a training round
    const handleCompletion = async () => {
        if (!orientationAndVariants || !dal) {
            return;
        }

        try {
            const settings = repertoireData?.weightSettings ?? WeightSettings.createDefault();
            const newData = RepertoireDataUtils.convertToRepertoireData(
                orientationAndVariants.allVariants,
                repertoireData!.dailyPlayCount + 1,
                settings
            );
            setRepertoireData(newData); // Updating local copy - it will be used for loading the next round.
            await dal.storeRepertoireData(newData);

            console.log(`DAL: Saved ${newData.data.length} variants.`);
        } catch (e: any) {
            const msg = `Failed to store variants: ${e.message || 'Unknown error'}`;
            console.error(msg, e);
            setError(msg);
        }
    };

    const handleLoadNext = () => {
        setTimeout(() => {
            // If we're loading next - it means we successfully loaded repertoire data.
            setOrientationAndVariants(pickOrientationAndVariants(repertoireData!, filterParam));
        }, 50);
    };

    if (loading) {
        return <div>Loading...</div>;
    }

    if (error) {
        return <div style={{ color: "red" }}>Error: {error}</div>;
    }

    if (!orientationAndVariants) {
        // If there's no variants to train on:
        return <div>No variants available.</div>;
    }

    const { orientation, selectedVariants } = orientationAndVariants;

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
            <BadgeRow repertoireData={repertoireData} />
            <TrainingPageControl
                variants={selectedVariants}
                onCompletion={handleCompletion}
                onLoadNext={handleLoadNext}
                orientation={orientation}
            />
        </div>
    );
};

export default TrainingPage;
