import React, { useState } from 'react';
import Chessboard from './Chessboard';
import { OpeningVariant } from './OpeningVariant';
import { HistoricalData, LocalStorageData } from './HistoricalData';
import { HistoricalDataUtils } from './HistoricalDataUtils';
import { MyVariants } from './MyVariants';

const TrainingPage: React.FC = () => {

    // Get variants and sort by PGN
    const allVariants: OpeningVariant[] = MyVariants.getVariants();
    allVariants.sort((a, b) => a.pgn.localeCompare(b.pgn));

    const pickOrientationAndVariants = (): OrientationAndVariants => {
        // Load and apply historical data
        const historicalData: HistoricalData = LocalStorageData.getHistoricalData();
        HistoricalDataUtils.applyHistoricalData(allVariants, historicalData);

        const whiteVariants: OpeningVariant[] = allVariants.filter(v => v.orientation === 'white');
        const blackVariants: OpeningVariant[] = allVariants.filter(v => v.orientation === 'black');

        // Guard against zero-length arrays:
        if (whiteVariants.length === 0 && blackVariants.length === 0) {
            return { orientation: 'white' as const, selectedVariants: [] as OpeningVariant[] };
        }
        if (blackVariants.length === 0) {
            return { orientation: 'white' as const, selectedVariants: whiteVariants };
        }
        if (whiteVariants.length === 0) {
            return { orientation: 'black' as const, selectedVariants: blackVariants };
        }

        // Decide orientation based on ratio
        const whiteRatio: number = whiteVariants.length / (whiteVariants.length + blackVariants.length);
        const orientation: 'white' | 'black' = Math.random() < whiteRatio ? 'white' : 'black';
        const selectedVariants: OpeningVariant[] = orientation === 'white' ? whiteVariants : blackVariants;
        return { orientation, selectedVariants };
    };

    const [{ orientation, selectedVariants }, setOrientationAndSelected] = useState(() =>
        pickOrientationAndVariants()
    );

    interface OrientationAndVariants {
        orientation: 'white' | 'black';
        selectedVariants: OpeningVariant[];
    }

    // Handle completion of a training round
    const handleCompletion = () => {
        const data = HistoricalDataUtils.composeHistoricalData(allVariants);
        LocalStorageData.setHistoricalData(data);
    };

    const handleLoadNext = () => {
        setTimeout(() => {
            setOrientationAndSelected(pickOrientationAndVariants());
        }, 50);
    };

    return (
        <div style={{ padding: '0.5rem' }}>
            <Chessboard
                variants={selectedVariants}
                onCompletion={handleCompletion}
                onLoadNext={handleLoadNext}
                orientation={orientation}
            />
        </div>
    );
};

export default TrainingPage;
