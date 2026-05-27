import { OpeningVariant } from "../models/OpeningVariant";
import { RepertoireData, OpeningVariantData, AppSettings } from "../models/RepertoireData";
import { FSRSCardData } from "../models/FSRSCardData";
import { RepertoireGraph } from "../services/RepertoireGraph";
import { FSRSService } from "../services/FSRSService";
import { TrainingEngine } from "../services/TrainingEngine";
import { getLinkedAccounts, setLinkedAccounts } from "../services/LinkedAccountsService";
import { ensureActivity } from "../services/ActivityService";

export class RepertoireDataUtils {

    public static normalize(repertoireData: RepertoireData): void {
        // Handle data from backend, normalize/provide defaults if needed.
        if (!repertoireData.data) {
            repertoireData.data = [];
        }
        // V1 stub — always reset to 0
        repertoireData.currentEpoch = 0;
        if (!repertoireData.lastPlayedDate) {
            repertoireData.lastPlayedDate = new Date(0);
        } else {
            // If it was sent as a string, re-hydrate into a real Date
            repertoireData.lastPlayedDate = new Date(repertoireData.lastPlayedDate);
        }
        if (!repertoireData.dailyPlayCount) {
            repertoireData.dailyPlayCount = 0;
        }

        // Normalize the data — stub V1 fields
        for (const variant of repertoireData.data) {
            variant.errorEMA = 0;
            variant.lastSucceededEpoch = 0;
            variant.successEMA = 0;
            if (!variant.numberOfTimesPlayed) {
                variant.numberOfTimesPlayed = 0;
            }
        }

        // Ensure fsrsCards is always present.
        if (!repertoireData.fsrsCards) {
            repertoireData.fsrsCards = {};
        }

        // Reconcile FSRS cards with current repertoire positions
        RepertoireDataUtils.reconcileCards(repertoireData);

        // Check whether we started a new day — update lastPlayedDate.
        const currentDate = RepertoireDataUtils.getCurrentDateOnly();
        if (currentDate > repertoireData.lastPlayedDate) {
            repertoireData.lastPlayedDate = currentDate;
        }

        // Initialize activity structure (does not create a today entry — that
        // only happens when actual activity is recorded, to avoid blank rows
        // consuming the 30-entry practice log cap).
        ensureActivity(repertoireData);

        // Hydrate in-memory settings from backend (settings preferred, trainingSettings as legacy fallback)
        const s = repertoireData.settings ?? repertoireData.trainingSettings;
        if (s) {
            if (typeof s.contextDepth === 'number') TrainingEngine.setContextDepth(s.contextDepth);
            if (typeof s.retention === 'number') {
                // Presets control both retention and maxInterval. Snap to the closest
                // preset's values; the stored maxInterval (if any) is ignored.
                const presetId = FSRSService.getPresetForRetention(s.retention);
                const cfg = FSRSService.getPresetConfig(presetId);
                FSRSService.setRetention(cfg.retention);
                FSRSService.setMaxInterval(cfg.maxInterval);
            }
            if (Array.isArray(s.linkedAccounts)) setLinkedAccounts(s.linkedAccounts);
        }

        // Migrate: ensure we use `settings` going forward
        if (repertoireData.trainingSettings && !repertoireData.settings) {
            repertoireData.settings = repertoireData.trainingSettings;
        }
        delete repertoireData.trainingSettings;
    }

    public static convertToVariantData(repertoireData: RepertoireData): OpeningVariant[] {
        const variants = repertoireData.data.map(data => {
            const variant = new OpeningVariant(data.pgn, data.orientation, data.classifications);
            variant.numberOfTimesPlayed = data.numberOfTimesPlayed;
            return variant;
        });

        variants.sort((a, b) => a.pgn.localeCompare(b.pgn))

        return variants;
    }

    /**
     * Build current AppSettings from in-memory state.
     * Merges into existing settings to preserve unknown fields.
     */
    public static buildCurrentSettings(existing?: AppSettings | null): AppSettings {
        return {
            ...(existing ?? {}),
            contextDepth: TrainingEngine.getContextDepth(),
            retention: FSRSService.getRetention(),
            maxInterval: FSRSService.getMaxInterval(),
            linkedAccounts: getLinkedAccounts(),
        };
    }

    public static convertToRepertoireData(
        variants: OpeningVariant[],
        fsrsCards?: Record<string, FSRSCardData>,
        existingSettings?: AppSettings | null,
        existingData?: RepertoireData | null,
    ): RepertoireData {
        const data: OpeningVariantData[] = variants.map(variant => ({
            pgn: variant.pgn,
            orientation: variant.orientation,
            classifications: variant.classifications,
            numberOfTimesPlayed: variant.numberOfTimesPlayed,
            // V1 stubs — backend requires these as numbers
            errorEMA: 0,
            lastSucceededEpoch: 0,
            successEMA: 0,
        }));

        return {
            data,
            currentEpoch: 0, // V1 stub
            lastPlayedDate: RepertoireDataUtils.getCurrentDateOnly(),
            // Backward compat: derive from activity for backend (always 0)
            dailyPlayCount: 0,
            fsrsCards: fsrsCards ?? {},
            settings: RepertoireDataUtils.buildCurrentSettings(existingSettings),
            activity: existingData?.activity,
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
        currentDate.setHours(0, 0, 0, 0);
        return new Date(currentDate.getTime());
    }
}
