import { LaunchpadLogic } from './LaunchpadLogic';
import { MyVariants } from './MyVariants';
import { LocalStorageData } from './RepertoireData';
import { HistoricalDataUtils } from './HistoricalDataUtils';
import { Chess } from "chess.js";

function playGames(): number {
    localStorage.clear();

    var numberOfVariants: number;
    const numberOfRoundsPerVariant = 1;

    {
        const variants = MyVariants.getVariants().map(variant => ({ ...variant }));
        const whiteVariants = variants.filter(variant => variant.orientation === 'white');
        numberOfVariants = whiteVariants.length;
    }

    // Copy variants
    for (var i = 0; i < numberOfVariants * numberOfRoundsPerVariant; i++) {
        const variants = MyVariants.getVariants().map(variant => ({ ...variant }));

        const whiteVariants = variants.filter(variant => variant.orientation === 'white');

        const historicalData = LocalStorageData.getHistoricalData();
        HistoricalDataUtils.applyHistoricalData(variants, historicalData);

        const logic = new LaunchpadLogic(whiteVariants);

        // Emulate a game
        const chess = new Chess();
        while (!logic.isEndOfVariant(chess.fen(), chess.history().length)) {
            const move = logic.getNextMove(chess.fen(), chess.history().length);
            chess.move({ from: move.from, to: move.to });
        }
        logic.completeVariant(chess.fen());

        const data = HistoricalDataUtils.composeHistoricalData(variants);
        LocalStorageData.setHistoricalData(data);
    }

    // Evaluate results
    {
        const variants = MyVariants.getVariants().map(variant => ({ ...variant }));
        const historicalData = LocalStorageData.getHistoricalData();
        HistoricalDataUtils.applyHistoricalData(variants, historicalData);

        const whiteVariants = variants.filter(variant => variant.orientation === 'white');
        process.stdout.write(`Variants: ${whiteVariants.length}\n`);

        var total = whiteVariants.length;
        for (var i = 0; total > 0; i++) {
            const timesPlayed = whiteVariants.filter(variant => variant.numberOfTimesPlayed === i).length;
            process.stdout.write(`${timesPlayed} variants played ${i} times\n`);
            total -= timesPlayed;
        }

        var score = 0;
        for (var i = 0; i < whiteVariants.length; i++) {
            score += Math.abs(whiteVariants[i].numberOfTimesPlayed - numberOfRoundsPerVariant);
        }
        process.stdout.write(`Score: ${score}\n`);

        return score;
    }
}

describe.skip('End-to-end', () => {
    it('Very closely distributed if there are no errors', () => {

        const numRounds = 10;
        var score = 0;
        for (var i = 0; i < numRounds; i++) {
            score += playGames();
        }
        process.stdout.write(`Average score: ${score/numRounds}\n`);
    });
});