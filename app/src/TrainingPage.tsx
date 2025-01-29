import React, { useState, useMemo, useEffect } from 'react';
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

const TrainingPage: React.FC = () => {
    const [repertoireData, setRepertoireData] = useState<RepertoireData | null>(null);
    const [orientationAndVariants, setOrientationAndVariants] = useState<OrientationAndVariants | null>(null);
    const [error, setError] = useState<string>('');
    const [loading, setLoading] = useState<boolean>(true);

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
                setOrientationAndVariants(pickOrientationAndVariants(data));

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
    }, []); // run once on mount


    const pickOrientationAndVariants = (repertoireData: RepertoireData): OrientationAndVariants => {
        const allVariants = RepertoireDataUtils.convertToVariantData(repertoireData);

        const whiteVariants: OpeningVariant[] = allVariants.filter(v => v.orientation === 'white');
        const blackVariants: OpeningVariant[] = allVariants.filter(v => v.orientation === 'black');

        // Guard against zero-length arrays:
        if (whiteVariants.length === 0 && blackVariants.length === 0) {
            return { orientation: 'white' as const, selectedVariants: [] as OpeningVariant[], allVariants: [] as OpeningVariant[] };
        }

        // Decide orientation based on ratio
        const whiteRatio: number = whiteVariants.length / (whiteVariants.length + blackVariants.length);
        const orientation: 'white' | 'black' = Math.random() < whiteRatio ? 'white' : 'black';
        const selectedVariants: OpeningVariant[] = orientation === 'white' ? whiteVariants : blackVariants;
        return { allVariants, orientation, selectedVariants };
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
            setOrientationAndVariants(pickOrientationAndVariants(repertoireData!));
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
