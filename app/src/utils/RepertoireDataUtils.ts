import { RepertoireData, AppSettings } from "../models/RepertoireData";
import { FSRSService } from "../services/FSRSService";
import { TrainingEngine } from "../services/TrainingEngine";
import { getLinkedAccounts, setLinkedAccounts } from "../services/LinkedAccountsService";
import { ensureActivity } from "../services/ActivityService";
import {
    extractFsrsCardsFromRepertoires,
    projectFsrsCardsIntoRepertoires,
    pruneEmptyAnnotations,
} from "./RepertoiresSerde";
import { createEmptyRepertoires } from "../models/Repertoires";
import { RepertoireGraph } from "../services/RepertoireGraph";

export class RepertoireDataUtils {

    public static normalize(repertoireData: RepertoireData): void {
        // Seed empty named repertoires for brand-new accounts. Existing
        // accounts always come back from the wire with `repertoires`
        // populated by `decodePersistedBlob`.
        if (!repertoireData.repertoires) {
            repertoireData.repertoires = createEmptyRepertoires();
        }

        // Build the in-memory FSRS flat map from the position dict. This is
        // the authoritative store FSRSService mutates during training.
        const cardsFromDict = extractFsrsCardsFromRepertoires(repertoireData.repertoires);
        repertoireData.fsrsCards = cardsFromDict;

        // Ensure cards exist for every user-turn edge in the graph so freshly
        // seeded repertoires (or repertoires with new positions added by
        // import) have a New-state card for each.
        const graph = RepertoireGraph.fromRepertoires(repertoireData.repertoires);
        const fsrs = new FSRSService(repertoireData.fsrsCards);
        for (const key of graph.getCardKeys()) {
            fsrs.ensureCard(key);
        }

        // Initialize activity structure (does not create a today entry — that
        // only happens when actual activity is recorded, to avoid blank rows
        // consuming the 30-entry practice log cap).
        ensureActivity(repertoireData);

        // Seed the FSRS audit array so AuditService can mutate a stable
        // reference. Decode preserves an existing array verbatim; this only
        // fires on fresh blobs or older blobs that predate the field.
        // See `docs/product-specs/FSRS-AUDIT.md`.
        if (!repertoireData.audit) {
            repertoireData.audit = [];
        }

        // Hydrate in-memory settings from backend.
        const s = repertoireData.settings;
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
     * Consumers (TrainingPage, GameIngestService, SettingsPage, importer)
     * mutate `data.fsrsCards` (the flat in-memory map) and the position
     * dict in `data.repertoires`; this function syncs the card map back
     * into the dict before serialization.
     *
     * Refuses to operate on an un-normalized blob (`repertoires` missing).
     * `normalize()` always seeds at least two empty repertoires, so a
     * missing field at this point is a programmer error — silently
     * substituting an empty pair would PUT an empty repertoire and
     * destroy the user's data.
     */
    public static prepareDataForSave(existingData: RepertoireData): RepertoireData {
        if (!existingData.repertoires) {
            throw new Error(
                'RepertoireDataUtils.prepareDataForSave: `repertoires` is missing. ' +
                'Callers must run `normalize()` on the blob first — refusing to save an ' +
                'empty repertoire that would overwrite the user\'s data.'
            );
        }
        const repertoires = existingData.repertoires;
        const fsrsCards = existingData.fsrsCards ?? extractFsrsCardsFromRepertoires(repertoires);
        projectFsrsCardsIntoRepertoires(repertoires, fsrsCards);
        pruneEmptyAnnotations(repertoires);
        return {
            repertoires,
            settings: RepertoireDataUtils.buildCurrentSettings(existingData.settings),
            activity: existingData.activity,
            games: existingData.games,
            // Pass `audit` through unchanged. The encoder drops empty arrays
            // so a user with no captures still ships a clean wire blob.
            audit: existingData.audit,
        };
    }

}
