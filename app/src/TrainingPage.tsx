import React from 'react';
import Chessboard from './Chessboard';
import { OpeningVariant } from './OpeningVariant';
import { LocalStorageData } from './HistoricalData';
import { HistoricalDataUtils } from './HistoricalDataUtils';
import { MyVariants } from './MyVariants';

const TrainingPage: React.FC = () => {

    // Get variants and sort by PGN
    const variants: OpeningVariant[] = MyVariants.getVariants();
    variants.sort((a, b) => a.pgn.localeCompare(b.pgn));

    // Randomly select orientation (white or black)
    const whiteVariants = variants.filter(variant => variant.orientation === 'white');
    const blackVariants = variants.filter(variant => variant.orientation === 'black');
    const whiteRatio = whiteVariants.length / (whiteVariants.length + blackVariants.length);
    const randomOrientation: 'white' | 'black' = Math.random() < whiteRatio ? 'white' : 'black';
    const selectedVariants = randomOrientation === 'white' ? whiteVariants : blackVariants;

    // Handle completion of a training round
    const handleCompletion = () => {
        const data = HistoricalDataUtils.composeHistoricalData(variants);
        LocalStorageData.setHistoricalData(data);
    };

    // Load and apply historical data
    const historicalData = LocalStorageData.getHistoricalData();
    HistoricalDataUtils.applyHistoricalData(variants, historicalData);

    return (
        <div style={{ padding: '0.5rem' }}>
            <Chessboard
                variants={selectedVariants}
                onCompletion={handleCompletion}
                orientation={randomOrientation}
            />
        </div>
    );
};

export default TrainingPage;
