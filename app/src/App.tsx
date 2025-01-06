import React from 'react';
import Chessboard from './Chessboard';
import { OpeningVariant } from './OpeningVariant';
import { LocalStorageData } from './HistoricalData';
import { HistoricalDataUtils } from './HistoricalDataUtils';
import { MyVariants } from './MyVariants';
import './App.css';

const App: React.FC = () => {
  const variants: OpeningVariant[] = MyVariants.getVariants();

  // Sort variants by the pgn field
  variants.sort((a, b) => a.pgn.localeCompare(b.pgn));

  const whiteVariants = variants.filter(variant => variant.orientation === 'white');
  const blackVariants = variants.filter(variant => variant.orientation === 'black');

  const whiteRatio = whiteVariants.length / (whiteVariants.length + blackVariants.length);

  const randomOrientation: 'white' | 'black' = Math.random() < whiteRatio ? 'white' : 'black';
  const selectedVariants = randomOrientation === 'white' ? whiteVariants : blackVariants;

  const handleCompletion = () => {
    const data = HistoricalDataUtils.composeHistoricalData(variants);
    LocalStorageData.setHistoricalData(data);
  };

  const historicalData = LocalStorageData.getHistoricalData();
  HistoricalDataUtils.applyHistoricalData(variants, historicalData);

  return (
    <div>
      <h1>Chess Launchpad</h1>
      <Chessboard variants={selectedVariants} onCompletion={handleCompletion} orientation={randomOrientation} />
    </div>
  );
};

export default App;
