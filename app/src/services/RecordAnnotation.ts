import { GameRecord } from '../models/RepertoireData';
import { ExplorerEvals } from '../models/ExplorerEvals';
import {
    annotateGame,
    deriveEotPositions as deriveEotPositionsImport,
    GameAnnotation,
    MastersLookupLike,
    getGameMetadata,
    GameMetadata,
} from './GameAnnotationService';
import { getRecordUserColor } from './GameRecordBuilder';

/**
 * Synthesize a Lichess-shaped raw `gameData` from a compact `GameRecord`
 * so the existing `annotateGame` / `getGameMetadata` consumers (which were
 * written against provider payloads) can be reused without duplicating the
 * annotation engine.
 *
 * The synthesis is intentionally Lichess-shaped regardless of original
 * platform (`record.p`) because:
 *
 *   - The annotation engine only needs SAN moves and (optionally) per-ply
 *     centipawn evals. Provider-specific dispatch in `buildPgn` and
 *     `getUserColor` is bypassed by going through Lichess's flatter shape.
 *   - Chess.com records have no `ev`; this falls through to the no-eval
 *     branch in the annotation engine (matches today's behavior).
 *   - The original platform is preserved separately on the metadata return
 *     so the UI can still render the correct "View on Chess.com" link, etc.
 */
function recordToLichessGameData(record: GameRecord): Record<string, unknown> {
    const waLower = record.wa.toLowerCase();
    const baLower = record.ba.toLowerCase();
    const gameData: Record<string, unknown> = {
        id: record.id,
        createdAt: record.t,
        moves: record.m,
        rated: record.rt === 1,
        speed: record.sp,
        variant: 'standard',
        players: {
            white: {
                user: { id: waLower, name: record.wa },
                rating: record.wr,
            },
            black: {
                user: { id: baLower, name: record.ba },
                rating: record.br,
            },
        },
        // `winner` / `status` intentionally omitted — `record.res` is the
        // authoritative user-POV result and downstream metadata callers
        // (`getRecordMetadata`) override the result computed by
        // `resolveLichessResult` to use it directly. Leaving these absent
        // means the synthetic payload never silently reports the wrong
        // winner if someone calls `getGameMetadata` on it directly.
        opening: record.o ? { name: record.o } : undefined,
        // Clock — synthesize from `tc` ("M+I") so `getGameMetadata` rebuilds
        // the same display string. Best-effort: omitted if `tc` is malformed.
        clock: parseTcToClock(record.tc),
        // Per-ply evals — synthesize the `analysis` shape (`{ eval: cp }`
        // for present values, `{}` for nulls so `extractEmbeddedEvals`
        // returns `null` at that ply). Mate scores were already coalesced
        // to ±MATE_CP when the record was built.
        analysis: record.ev?.map(cp => cp === null ? {} : { eval: cp }),
    };
    return gameData;
}

function parseTcToClock(tc: string | undefined): Record<string, unknown> | undefined {
    if (!tc) return undefined;
    // Accept decimal minutes (e.g. "0.5+0", "1.5+2") so non-integer-minute
    // Lichess time controls round-trip without losing the chip display.
    const m = tc.match(/^(\d+(?:\.\d+)?)\+(\d+)$/);
    if (!m) return undefined;
    const minutes = parseFloat(m[1]);
    const increment = parseInt(m[2], 10);
    if (isNaN(minutes) || isNaN(increment)) return undefined;
    return { initial: Math.round(minutes * 60), increment };
}

/**
 * Annotate a `GameRecord` against a repertoire FEN set, plus an optional
 * masters-lookup for the ambiguous-zone (15–44 cp opponent drop) verdict.
 *
 * `accountUsernameLower` is the linked-account name (lowercase) that this
 * record was ingested under — used to determine `userColor` from
 * `record.wa`/`record.ba`. Returns `null` when the user can't be matched
 * (record corruption — should not happen since ingest already filtered).
 *
 * `debug` enables the ply-by-ply `console.groupCollapsed` trace in the
 * underlying annotation engine — used by the /games page's Re-annotate
 * action to surface a one-shot log for the targeted record.
 */
export function annotateRecord(
    record: GameRecord,
    accountUsernameLower: string,
    repertoireFens: Set<string>,
    explorerEvals: ExplorerEvals | null,
    mastersLookup?: MastersLookupLike,
    maxPlies: number = 30,
    debug?: boolean,
): GameAnnotation | null {
    const userColor = getRecordUserColor(record, accountUsernameLower);
    if (!userColor) return null;
    const gameData = recordToLichessGameData(record);
    // Pass the user's actual name (lowercase) so `getUserColor` resolves
    // correctly through the synthesized Lichess shape.
    return annotateGame(
        gameData,
        accountUsernameLower,
        repertoireFens,
        explorerEvals,
        maxPlies,
        'lichess',
        mastersLookup,
        debug,
    );
}

/**
 * Compute display metadata for a record, overriding the result with the
 * record's authoritative `res` field. Preserves the original `record.p`
 * for platform-specific bits (game URL, "View on" link).
 */
export function getRecordMetadata(
    record: GameRecord,
    accountUsernameLower: string,
): GameMetadata {
    const userColor = getRecordUserColor(record, accountUsernameLower);
    const gameData = recordToLichessGameData(record);
    // Use existing metadata builder for the common fields, then patch.
    const meta = getGameMetadata(gameData, accountUsernameLower, 'lichess');
    return {
        ...meta,
        // Authoritative from record; the synthesized `winner` was a placeholder.
        result: record.res,
        userColor,
        platform: record.p === 'c' ? 'chess.com' : 'lichess',
        // Correct platform-native game URL. Chess.com requires the
        // provider-supplied URL (`record.u`) because public URLs use a
        // numeric live-game id that's not derivable from the stored UUID.
        // Lichess URLs are stable and id-based, so we synthesize them.
        gameUrl: record.p === 'c'
            ? (record.u ?? `https://www.chess.com/game/live/${record.id}`)
            : `https://lichess.org/${record.id}${userColor === 'black' ? '/black' : ''}`,
        // The record stores the opening name authoritatively.
        openingName: record.o ?? '',
    };
}

/**
 * Compute the opponent's display name from a record. Provider casing is
 * preserved (`wa`/`ba`), matching the spec's display goal.
 */
export function getRecordOpponentName(
    record: GameRecord,
    accountUsernameLower: string,
): string {
    const color = getRecordUserColor(record, accountUsernameLower);
    if (!color) {
        // Unknown — fall back to white (display only).
        return record.wa;
    }
    return color === 'white' ? record.ba : record.wa;
}

/**
 * Derive the end-of-theory positions for the first out-of-rep eval-drop
 * move in an annotated record — mirrors `deriveEotPositions` but works
 * from a `GameRecord` instead of raw `gameData`.
 *
 * The synthesized Lichess shape is bytewise compatible with
 * `deriveEotPositions`, which only reads `moves` (the SAN string) and
 * the players block, so we can delegate to the existing helper.
 */
export function deriveRecordEotPositions(
    record: GameRecord,
    accountUsernameLower: string,
    annotation: GameAnnotation,
): ReturnType<typeof deriveEotPositionsImport> | null {
    const gameData = recordToLichessGameData(record);
    return deriveEotPositionsImport(gameData, annotation, accountUsernameLower, 'lichess');
}
