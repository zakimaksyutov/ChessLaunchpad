import React, { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom'; // to read query params
import TrainingPageControl from './TrainingPageControl';
import { OpeningVariant } from './OpeningVariant';
import { IDataAccessLayer, createDataAccessLayer } from './DataAccessLayer';
import { RepertoireData } from './RepertoireData';
import { RepertoireDataUtils } from './RepertoireDataUtils';

interface OrientationAndVariants {
    orientation: 'white' | 'black';
    selectedVariants: OpeningVariant[];
    allVariants: OpeningVariant[];
}

function BadgeRow({ oldest, eightieth, errorsCount }: { oldest: number; eightieth: number; errorsCount: number }) {
    const wrapperStyle: React.CSSProperties = {
        display: 'flex',
        gap: '8px',
        marginBottom: '5px',
    };

    const leftPartStyle: React.CSSProperties = {
        backgroundColor: '#555', // typical left segment color (dark gray)
        color: '#fff',
        padding: '1px 8px',
        paddingBottom: '2px',
        borderRadius: '4px 0 0 4px',
        fontSize: '0.8rem',
    };

    const rightPartStyle: React.CSSProperties = {
        backgroundColor: '#4c1', // typical right segment color (green)
        color: '#fff',
        padding: '1px 8px',
        paddingBottom: '2px',
        borderRadius: '0 4px 4px 0',
        fontSize: '0.8rem',
    };

    // Reusable helper to render a two-part badge
    const renderBadge = (label: React.ReactNode, value: string) => (
        <div style={{ display: 'inline-flex' }}>
            <span style={leftPartStyle}>{label}</span>
            <span style={rightPartStyle}>{value}</span>
        </div>
    );

    return (
        <div style={wrapperStyle}>
            {renderBadge('oldest', oldest.toString())}
            {renderBadge(<span>80<sup style={{ fontSize: '0.6em' }}>TH</sup></span>, eightieth.toString())}
            {renderBadge('errors', errorsCount.toString())}
        </div>
    );
}

const TrainingPage: React.FC = () => {
    const [repertoireData, setRepertoireData] = useState<RepertoireData | null>(null);
    const [orientationAndVariants, setOrientationAndVariants] = useState<OrientationAndVariants | null>(null);
    const [oldest, setOldest] = useState<number>(0);
    const [eightieth, setEightieth] = useState<number>(0);
    const [errorsCount, setErrorsCount] = useState<number>(0);
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

    useEffect(() => {
        if (!orientationAndVariants?.allVariants || orientationAndVariants.allVariants.length === 0) {
            setOldest(0);
            setEightieth(0);
            setErrorsCount(0);
            return;
        }

        // List of “ages”: how many epochs ago each variant was last played
        const ages = orientationAndVariants.allVariants.map(
            v => v.currentEpoch - v.lastSucceededEpoch
        );

        ages.sort((a, b) => a - b);  // sort ascending
        const maxAge = Math.max(...ages);

        // 80th percentile index
        const rankIndex = Math.floor(0.8 * (ages.length - 1));
        const percentile80 = ages[rankIndex];

        setOldest(maxAge);
        setEightieth(percentile80);

        const count = orientationAndVariants.allVariants.filter((v) => v.errorEMA > 2).length;
        setErrorsCount(count);
    }, [orientationAndVariants]);

    const pickOrientationAndVariants = (repertoireData: RepertoireData, filter: string): OrientationAndVariants => {
        const allVariants = RepertoireDataUtils.convertToVariantData(repertoireData);

        // Only *logically* filter if filter is provided
        let variants = allVariants;
        if (filter.trim()) {
            const lowerFilter = filter.toLowerCase();
            variants = variants.filter((v) =>
                v.classifications.some((cls) => cls.toLowerCase().includes(lowerFilter))
            );
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
            const newData = RepertoireDataUtils.convertToRepertoireData(orientationAndVariants.allVariants);
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
        <div style={{ padding: '0.5rem' }}>
            <BadgeRow oldest={oldest} eightieth={eightieth} errorsCount={errorsCount} />
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
