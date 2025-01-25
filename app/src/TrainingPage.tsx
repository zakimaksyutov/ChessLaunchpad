import React, { useState } from 'react';
import Chessboard from './Chessboard';
import { OpeningVariant } from './OpeningVariant';
import { RepertoireData, LocalStorageData } from './HistoricalData';
import { HistoricalDataUtils } from './HistoricalDataUtils';
import { MyVariants } from './MyVariants';

const TrainingPage: React.FC = () => {

    const pickOrientationAndVariants = (): OrientationAndVariants => {
        // Get variants and sort by PGN
        const allVariants = MyVariants.getVariants();
        allVariants.sort((a, b) => a.pgn.localeCompare(b.pgn))

        // Load and apply historical data
        const historicalData: RepertoireData = LocalStorageData.getHistoricalData();
        HistoricalDataUtils.applyHistoricalData(allVariants, historicalData);

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

    const [{ allVariants, orientation, selectedVariants }, setOrientationAndSelected] = useState(() =>
        pickOrientationAndVariants()
    );

    interface OrientationAndVariants {
        orientation: 'white' | 'black';
        selectedVariants: OpeningVariant[];
        allVariants: OpeningVariant[];
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
