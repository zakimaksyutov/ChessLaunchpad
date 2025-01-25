import { OpeningVariant } from "./OpeningVariant";
import { RepertoireData, OpeningVariantData } from "./RepertoireData";
import { LaunchpadLogic } from "./LaunchpadLogic";

export class HistoricalDataUtils {
    public static applyHistoricalData(variants: OpeningVariant[], historicalData: RepertoireData): void {
        const dataMap = new Map<string, OpeningVariantData>(
            historicalData.data.map(data => [`${data.pgn}_${data.orientation}`, data])
        );

        var newEpoch: boolean = false;

        const currentDate = HistoricalDataUtils.getCurrnetDateOnly();
        if (currentDate > historicalData.lastPlayedDate) {
            historicalData.currentEpoch++;
            newEpoch = true;
        }

        for (const variant of variants) {
            const key = `${variant.pgn}_${variant.orientation}`;
            const data = dataMap.get(key);
            if (data) {
                variant.errorEMA = data.errorEMA;
                variant.numberOfTimesPlayed = data.numberOfTimesPlayed;
                variant.lastSucceededEpoch = data.lastSucceededEpoch;
                variant.successEMA = data.successEMA;
                variant.numberOfErrors = 0;

                // If a new epoch has started, adjust successEMA.
                if (newEpoch) {
                    variant.successEMA = LaunchpadLogic.SUCCESS_EMA_ALPHA * variant.successEMA;
                }
            }

            variant.currentEpoch = historicalData.currentEpoch;
        }
    }

    public static composeHistoricalData(variants: OpeningVariant[]): RepertoireData {
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
            lastPlayedDate: HistoricalDataUtils.getCurrnetDateOnly()
        };
    }

    public static getCurrnetDateOnly(): Date {
        const currentDate = new Date();
        return new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
    }
}