import { OpeningVariant } from "../models/OpeningVariant";
import { RepertoireData, OpeningVariantData } from "../models/RepertoireData";
import { WeightSettings } from "../models/WeightSettings";
import { FSRSCardData } from "../models/FSRSCardData";
import { RepertoireGraph } from "../services/RepertoireGraph";
import { FSRSService } from "../services/FSRSService";

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

        // Ensure fsrsCards is always present.
        if (!repertoireData.fsrsCards) {
            repertoireData.fsrsCards = {};
        }

        // Reconcile FSRS cards with current repertoire positions
        RepertoireDataUtils.reconcileCards(repertoireData);

        // Check whether we started a new day — reset daily counter.
        // Note: currentEpoch is no longer incremented (FSRSv2) but kept for rollback safety.
        const currentDate = RepertoireDataUtils.getCurrentDateOnly();
        if (currentDate > repertoireData.lastPlayedDate) {
            repertoireData.lastPlayedDate = currentDate;
            // Reset daily counter on new day
            repertoireData.dailyPlayCount = 0;
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
        weightSettings?: WeightSettings,
        fsrsCards?: Record<string, FSRSCardData>
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
            weightSettings: settings,
            fsrsCards: fsrsCards ?? {}
        };
    }

    /**
     * Reconcile fsrsCards with the repertoire graph.
     * - New positions (in graph, no card) → create card with state=New
     * - Removed positions (card exists, not in graph) → delete card
     * - Existing positions → untouched
     */
    public static reconcileCards(repertoireData: RepertoireData): void {
        const cards = repertoireData.fsrsCards ?? {};
        repertoireData.fsrsCards = cards;

        const pgns = repertoireData.data.map(v => ({
            pgn: v.pgn,
            orientation: v.orientation,
        }));
        const graph = new RepertoireGraph(pgns);
        const graphKeys = new Set(graph.getCardKeys());
        const fsrsService = new FSRSService(cards);

        // Create new cards for positions in graph but not in cards
        for (const key of graphKeys) {
            fsrsService.ensureCard(key);
        }

        // Delete cards for positions not in graph
        for (const key of fsrsService.getAllCardKeys()) {
            if (!graphKeys.has(key)) {
                fsrsService.deleteCard(key);
            }
        }
    }

    public static getCurrentDateOnly(): Date {
        const currentDate = new Date();
        currentDate.setUTCHours(0, 0, 0, 0);
        return new Date(currentDate.getTime());
    }
}
