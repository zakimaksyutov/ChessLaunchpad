import { OpeningVariant } from "./OpeningVariant";
import { RepertoireData, OpeningVariantData } from "./RepertoireData";
import { LaunchpadLogic } from "./LaunchpadLogic";
import { WeightSettings } from "./WeightSettings";

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
        if (!repertoireData.dailyPlayCount) {
            repertoireData.dailyPlayCount = 0;
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

        // Ensure weight settings are always present and hydrated.
        repertoireData.weightSettings = WeightSettings.from(repertoireData.weightSettings);

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
            // Reset daily counter on new epoch
            repertoireData.dailyPlayCount = 0;
        
            for (const variant of repertoireData.data) {
                variant.successEMA = LaunchpadLogic.SUCCESS_EMA_ALPHA * variant.successEMA;
            }
        }
    }

    public static convertToVariantData(repertoireData: RepertoireData): OpeningVariant[] {
        const settings = WeightSettings.from(repertoireData.weightSettings);
        const variants = repertoireData.data.map(data => {
            const variant = new OpeningVariant(data.pgn, data.orientation, data.classifications);
            variant.errorEMA = data.errorEMA;
            variant.numberOfTimesPlayed = data.numberOfTimesPlayed;
            variant.lastSucceededEpoch = data.lastSucceededEpoch;
            variant.successEMA = data.successEMA;
            variant.numberOfErrors = 0;
            variant.currentEpoch = repertoireData.currentEpoch;
            variant.weightSettings = settings.clone();
            return variant;
        });

        variants.sort((a, b) => a.pgn.localeCompare(b.pgn))

        return variants;
    }

    public static convertToRepertoireData(
        variants: OpeningVariant[],
        dailyPlayCount: number,
        weightSettings?: WeightSettings
    ): RepertoireData {
        const data: OpeningVariantData[] = variants.map(variant => ({
            pgn: variant.pgn,
            orientation: variant.orientation,
            classifications: variant.classifications,
            errorEMA: variant.errorEMA,
            numberOfTimesPlayed: variant.numberOfTimesPlayed,
            lastSucceededEpoch: variant.lastSucceededEpoch,
            successEMA: variant.successEMA
        }));

        const settings =
            weightSettings?.clone() ??
            variants[0]?.weightSettings?.clone() ??
            WeightSettings.createDefault();

        return {
            data,
            currentEpoch: Math.max(...variants.map(v => v.currentEpoch)),
            lastPlayedDate: RepertoireDataUtils.getCurrentDateOnly(),
            dailyPlayCount: dailyPlayCount,
            weightSettings: settings
        };
    }

    public static getCurrentDateOnly(): Date {
        const currentDate = new Date();
        currentDate.setUTCHours(0, 0, 0, 0);
        return new Date(currentDate.getTime());
    }
}
