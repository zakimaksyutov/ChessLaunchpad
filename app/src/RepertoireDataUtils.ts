import { OpeningVariant } from "./OpeningVariant";
import { RepertoireData, OpeningVariantData } from "./RepertoireData";
import { LaunchpadLogic } from "./LaunchpadLogic";

export class RepertoireDataUtils {

    public static normalize(repertoireData: RepertoireData): void {
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
            const variant = new OpeningVariant(data.pgn, data.orientation, data.classifications);
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
            classifications: variant.classifications,
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