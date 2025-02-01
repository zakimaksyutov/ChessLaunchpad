import { OpeningVariant } from "./OpeningVariant";
import { RepertoireData, OpeningVariantData } from "./RepertoireData";
import { LaunchpadLogic } from "./LaunchpadLogic";
import { MyVariants } from './MyVariants';

export class RepertoireDataUtils {

    // This is temp solution while migrating from hardcoded list to backend.
    // Moving forward this should be removed.
    private static addMyVariantsToRepertoireData(repertoireData: RepertoireData): void {
        const dataMap = new Map<string, OpeningVariantData>(
            repertoireData.data.map(data => [`${data.pgn}_${data.orientation}`, data])
        );

        const variants = MyVariants.getVariants();
        for (const variant of variants) {
            const key = `${variant.pgn}_${variant.orientation}`;
            if (!dataMap.has(key)) {
                repertoireData.data.push({
                    pgn: variant.pgn,
                    orientation: variant.orientation,
                    errorEMA: 0,
                    numberOfTimesPlayed: 0,
                    lastSucceededEpoch: 0,
                    successEMA: 0
                });
            }
        }
    }

    public static normalize(repertoireData: RepertoireData, addLocalVariants: boolean = false): void {
        // Handle data from backend, normalize/provide defaults if needed.
        if (!repertoireData.data) {
            repertoireData.data = [];
        }
        if (!repertoireData.currentEpoch) {
            repertoireData.currentEpoch = 0;
        }
        if (!repertoireData.lastPlayedDate) {
            repertoireData.lastPlayedDate = new Date(0);
        } else {
            // If it was sent as a string, re-hydrate into a real Date
            repertoireData.lastPlayedDate = new Date(repertoireData.lastPlayedDate);
        }

        // Normalize the data
        for (const variant of repertoireData.data) {
            if (!variant.errorEMA) {
                variant.errorEMA = 0;
            }
            if (!variant.numberOfTimesPlayed) {
                variant.numberOfTimesPlayed = 0;
            }
            if (!variant.lastSucceededEpoch) {
                variant.lastSucceededEpoch = 0;
            }
            if (!variant.successEMA) {
                variant.successEMA = 0;
            }
        }

        // Load my hardcoded variants into the repertoire data.
        if (addLocalVariants) {
            RepertoireDataUtils.addMyVariantsToRepertoireData(repertoireData);
        }

        // Check whether we started a new epoch (a new day).
        // Note, if a player hasn't played for N days, then the epoch will be incremented only once and not N times.
        var newEpoch: boolean = false;

        const currentDate = RepertoireDataUtils.getCurrentDateOnly();
        if (currentDate > repertoireData.lastPlayedDate) {
            repertoireData.currentEpoch++;
            repertoireData.lastPlayedDate = currentDate;
            newEpoch = true;
        }

        // If a new epoch has started, adjust successEMA.
        if (newEpoch) {
            for (const variant of repertoireData.data) {
                variant.successEMA = LaunchpadLogic.SUCCESS_EMA_ALPHA * variant.successEMA;
            }
        }
    }

    public static convertToVariantData(repertoireData: RepertoireData): OpeningVariant[] {
        const variants = repertoireData.data.map(data => {
            const variant = new OpeningVariant(data.pgn, data.orientation);
            variant.errorEMA = data.errorEMA;
            variant.numberOfTimesPlayed = data.numberOfTimesPlayed;
            variant.lastSucceededEpoch = data.lastSucceededEpoch;
            variant.successEMA = data.successEMA;
            variant.numberOfErrors = 0;
            variant.currentEpoch = repertoireData.currentEpoch;
            return variant;
        });

        variants.sort((a, b) => a.pgn.localeCompare(b.pgn))

        return variants;
    }

    public static convertToRepertoireData(variants: OpeningVariant[]): RepertoireData {
        const data: OpeningVariantData[] = variants.map(variant => ({
            pgn: variant.pgn,
            orientation: variant.orientation,
            errorEMA: variant.errorEMA,
            numberOfTimesPlayed: variant.numberOfTimesPlayed,
            lastSucceededEpoch: variant.lastSucceededEpoch,
            successEMA: variant.successEMA
        }));

        return {
            data,
            currentEpoch: Math.max(...variants.map(v => v.currentEpoch)),
            lastPlayedDate: RepertoireDataUtils.getCurrentDateOnly()
        };
    }

    public static getCurrentDateOnly(): Date {
        const currentDate = new Date();
        currentDate.setUTCHours(0, 0, 0, 0);
        return new Date(currentDate.getTime());
    }
}