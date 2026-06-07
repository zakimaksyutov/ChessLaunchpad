import { RepertoireData, AppSettings } from "../models/RepertoireData";
import { FSRSService } from "../services/FSRSService";
import { TrainingEngine } from "../services/TrainingEngine";
import { getLinkedAccounts, setLinkedAccounts } from "../services/LinkedAccountsService";
import { ensureActivity } from "../services/ActivityService";
import {
    bootstrapRepertoiresFromLegacy,
    extractFsrsCardsFromRepertoires,
    projectFsrsCardsIntoRepertoires,
    pruneEmptyAnnotations,
} from "./RepertoiresSerde";
import { RepertoireGraph } from "../services/RepertoireGraph";

export class RepertoireDataUtils {

    public static normalize(repertoireData: RepertoireData): void {
        // ── Position-centric migration ─────────────────────────────────
        //
        // Source-of-truth precedence:
        //   1. If `repertoires` is present, use it as-is.
        //   2. Else if legacy `data` (variants) is present, bootstrap.
        //   3. Else, seed with two empty entries (White, Black).
        //
        // After this block, `repertoires` is the in-memory authoritative
        // shape; `data` and (top-level) `fsrsCards` are stale and treated
        // as read-only. `prepareDataForSave` re-projects in-memory state
        // into `repertoires` on save and explicitly omits the legacy
        // fields from the persisted blob.
        if (!repertoireData.repertoires) {
            const legacyVariants = repertoireData.data ?? [];
            const legacyCards = repertoireData.fsrsCards ?? {};
            repertoireData.repertoires = bootstrapRepertoiresFromLegacy(legacyVariants, legacyCards);
        }

        // Build the in-memory FSRS flat map from the position dict. This is
        // the authoritative store FSRSService mutates during training.
        const cardsFromDict = extractFsrsCardsFromRepertoires(repertoireData.repertoires);
        repertoireData.fsrsCards = cardsFromDict;

        // Ensure cards exist for every user-turn edge in the graph so freshly
        // bootstrapped repertoires (or repertoires with new positions added
        // by import) have a New-state card for each. This replaces the
        // legacy `reconcileCards` pass — the dict is by-construction
        // consistent with the graph (no orphan cards to delete), but new
        // edges added without a card still need one.
        const graph = RepertoireGraph.fromRepertoires(repertoireData.repertoires);
        const fsrs = new FSRSService(repertoireData.fsrsCards);
        for (const key of graph.getCardKeys()) {
            fsrs.ensureCard(key);
        }

        // Legacy `data` is no longer the source of truth — strip it so any
        // consumer that still touches it gets an immediate signal. The
        // bootstrap above already pulled everything we need out of it.
        delete repertoireData.data;

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
        }
        // Always reset the LinkedAccountsService cache on every normalize() so a
        // logout → login flow in the same SPA process cannot carry the previous
        // user's accounts into the new user's session. If the new blob has no
        // linkedAccounts at all, reset to an empty array.
        setLinkedAccounts(Array.isArray(s?.linkedAccounts) ? s.linkedAccounts : []);

        // Migrate: ensure we use `settings` going forward
        if (repertoireData.trainingSettings && !repertoireData.settings) {
            repertoireData.settings = repertoireData.trainingSettings;
        }
        delete repertoireData.trainingSettings;
    }

    /**
     * Build current AppSettings from in-memory state.
     *
     * Behavior: if a field exists in `existing`, it wins; otherwise we fall
     * back to the live module-var state (TrainingEngine / FSRSService /
     * LinkedAccountsService).
     *
     * This precedence matters for **two** callers:
     *   - SettingsPage.handleSave writes draft values into `current.settings`
     *     BEFORE calling prepareDataForSave; those drafts must survive even
     *     though the module vars are still on the pre-save state (they're
     *     only updated after the PUT succeeds, so the save is reversible).
     *   - SettingsPage import path passes the imported file's settings
     *     verbatim; those should likewise be preserved over whatever the
     *     pre-import session had loaded.
     *
     * For TrainingPage / GameIngestService, `existing` comes from a
     * just-normalized blob whose values already match the module vars (since
     * normalize() hydrates the vars from `existing.settings`), so the
     * preference rule produces the same result either way.
     */
    public static buildCurrentSettings(existing?: AppSettings | null): AppSettings {
        const e = existing ?? {};
        return {
            ...e,
            contextDepth: typeof e.contextDepth === 'number'
                ? e.contextDepth
                : TrainingEngine.getContextDepth(),
            retention: typeof e.retention === 'number'
                ? e.retention
                : FSRSService.getRetention(),
            maxInterval: typeof e.maxInterval === 'number'
                ? e.maxInterval
                : FSRSService.getMaxInterval(),
            linkedAccounts: Array.isArray(e.linkedAccounts)
                ? e.linkedAccounts
                : getLinkedAccounts(),
        };
    }

    /**
     * Build the object to PUT to the backend from the in-memory state.
     *
     * The output uses the position-centric `repertoires` shape exclusively —
     * `data` and `fsrsCards` are NOT included. Consumers (TrainingPage,
     * GameIngestService, SettingsPage, importer) mutate `data.fsrsCards`
     * (the flat in-memory map) and the position dict in `data.repertoires`;
     * this function syncs the card map back into the dict before serialization.
     *
     * Defensively bootstraps from legacy fields if `repertoires` is missing
     * — this protects callers that pass a parsed-but-not-normalized blob
     * (e.g. the importer for legacy-shape files) from silently emitting an
     * empty repertoire and destroying the user's data.
     */
    public static prepareDataForSave(existingData: RepertoireData): RepertoireData {
        // Ensure both repertoires AND the flat card map are populated. If
        // the caller hands us a parsed blob in the new shape but never ran
        // through normalize(), `fsrsCards` will be missing — extract it from
        // the position dict so the projection below doesn't wipe the cards.
        let repertoires = existingData.repertoires;
        let fsrsCards = existingData.fsrsCards;
        if (!repertoires) {
            repertoires = bootstrapRepertoiresFromLegacy(
                existingData.data ?? [],
                existingData.fsrsCards ?? {},
            );
        }
        if (!fsrsCards) {
            fsrsCards = extractFsrsCardsFromRepertoires(repertoires);
        }
        projectFsrsCardsIntoRepertoires(repertoires, fsrsCards);
        pruneEmptyAnnotations(repertoires);
        return {
            repertoires,
            settings: RepertoireDataUtils.buildCurrentSettings(existingData.settings),
            activity: existingData.activity,
            games: existingData.games,
        };
    }

}
