import { Chess } from 'chess.js';
import { Annotation } from '../models/Annotation';
import { RepertoireEntry } from '../models/Repertoires';
import { normalizeFenResetHalfmoveClock } from './FenUtils';

/**
 * Per-repertoire PGN export/import. See `docs/product-specs/REPERTOIRE-PGN.md`.
 *
 * One repertoire (one orientation) per file. Round-trips:
 *   • the DAG of positions (rendered as a spanning tree on disk),
 *   • per-position annotations using the lichess `[%cal …][%csl …]`
 *     comment convention.
 *
 * Does NOT carry FSRS card state — newly-added user-turn edges get a
 * fresh `New` card via the normal `normalize()` pass downstream.
 */

const HEADER_REPERTOIRE = 'Repertoire';
const HEADER_REPERTOIRE_WHITE = 'White';
const HEADER_REPERTOIRE_BLACK = 'Black';

/** Edge collected by the decoder. `from` is a normalized FEN. */
interface DecodedEdge {
    from: string;
    san: string;
}

/**
 * Pair of orientation + edges + structured-annotation map produced by
 * `decodeRepertoirePgn`. The merge layer applies these to a repertoire.
 *
 * `annotationsByFen` only carries entries for FENs whose imported comment
 * contained at least one `[%cal …]` / `[%csl …]` token — empty `{}`,
 * plain-text comments, and "no comment" are not recorded here, by design,
 * so the merge step can replace existing annotations only when the import
 * truly conveys an annotation set (see spec: "Empty comments, plain-text
 * comments, and the absence of a comment all leave existing annotations
 * untouched").
 */
interface DecodedRepertoirePgn {
    orientation: 'white' | 'black';
    edges: DecodedEdge[];
    annotationsByFen: Map<string, Annotation[]>;
}

export class RepertoirePgnError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RepertoirePgnError';
    }
}

// ── Encode ──────────────────────────────────────────────────────────────

/**
 * Encode `repertoire` as a single-game PGN string. The output is portable
 * to standard tools (lichess Studio, ChessBase, SCID) and round-trips
 * losslessly through `decodeRepertoirePgn` for the position DAG +
 * structured annotations.
 *
 * Determinism: outgoing SANs at each FEN are sorted lex; the lex-smallest
 * SAN is emitted on the main line and the others become variations. The
 * same in-memory model always produces byte-identical output.
 */
export function encodeRepertoirePgn(
    repertoire: RepertoireEntry,
): string {
    const orientation = repertoire.orientation;
    const root = normalizeFenResetHalfmoveClock(new Chess().fen());

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    const headers = [
        `[Event "ChessLaunchpad Repertoire"]`,
        `[Site "?"]`,
        `[Date "${today}"]`,
        `[Round "-"]`,
        `[White "?"]`,
        `[Black "?"]`,
        `[Result "*"]`,
        `[${HEADER_REPERTOIRE} "${orientation === 'white' ? HEADER_REPERTOIRE_WHITE : HEADER_REPERTOIRE_BLACK}"]`,
    ];

    // Walk the DAG as a spanning tree. visited holds normalized FENs we've
    // already emitted moves FROM; on a repeat visit we stop silently
    // (transposition).
    const visited = new Set<string>();

    // Movetext is built incrementally with care for spacing & numbering.
    // We don't rely on chess.js's PGN serializer because it doesn't
    // round-trip variations (chess.js #beta limitation).
    const pieces: string[] = [];

    const rootAnnotations = repertoire.positions[root]?.annotations ?? [];
    if (rootAnnotations.length > 0) {
        // Pre-move "starting comment". Standard PGN: a comment before the
        // first move applies to the initial position.
        pieces.push(`{${formatAnnotationsComment(rootAnnotations)}}`);
    }

    // Recursive emit helper.
    //
    //   fen: parent FEN we're emitting moves FROM.
    //   plyBefore: number of plies played to reach `fen` (0 at root).
    //   isFirstAfterDelim: true when the NEXT move is the first token of
    //     a new variation (`(`) or the very first token of the game.
    //     White moves always get "N.", black moves get "N..." iff
    //     `isFirstAfterDelim`.
    //
    // The caller is responsible for any leading whitespace; this fn
    // appends whitespace before its own emissions.
    const emit = (fen: string, plyBefore: number, isFirstAfterDelim: boolean): void => {
        if (visited.has(fen)) return; // transposition or revisit: stop
        visited.add(fen);

        const pos = repertoire.positions[fen];
        if (!pos) return;

        const sans = Object.keys(pos.moves).sort();
        if (sans.length === 0) return;

        const [mainSan, ...altSans] = sans;

        // Emit mainline edge.
        writeMoveToken(pieces, mainSan, plyBefore, isFirstAfterDelim);
        const mainChild = resolveChildFen(fen, mainSan);
        const childPos = repertoire.positions[mainChild];
        const childAnnotations = childPos?.annotations ?? [];
        if (childAnnotations.length > 0) {
            pieces.push(` {${formatAnnotationsComment(childAnnotations)}}`);
        }

        // Emit alternative SANs as parenthesized variations BEFORE recursing
        // into the main child. Standard PGN convention: a variation '('
        // that appears after a move is an alternative to that move,
        // branching from the SAME parent position. So inside the variation
        // we restart the side-to-move using the parent's ply count.
        for (const altSan of altSans) {
            pieces.push(' (');
            writeMoveToken(pieces, altSan, plyBefore, true);
            const altChild = resolveChildFen(fen, altSan);
            const altChildPos = repertoire.positions[altChild];
            const altChildAnnotations = altChildPos?.annotations ?? [];
            if (altChildAnnotations.length > 0) {
                pieces.push(` {${formatAnnotationsComment(altChildAnnotations)}}`);
            }
            // Continue the variation down its own main line.
            emit(altChild, plyBefore + 1, false);
            pieces.push(')');
        }

        // Recurse into the main child to continue the spanning tree.
        emit(mainChild, plyBefore + 1, false);
    };

    emit(root, 0, true);

    // Termination marker (we always export with result "*" — no game result).
    pieces.push(' *');

    return headers.join('\n') + '\n\n' + pieces.join('').trim() + '\n';
}

function writeMoveToken(
    pieces: string[],
    san: string,
    plyBefore: number,
    isFirstAfterDelim: boolean,
): void {
    const isWhiteMove = plyBefore % 2 === 0;
    const moveNumber = Math.floor(plyBefore / 2) + 1;
    // Token spacing: leading space iff this isn't the first piece written
    // and the previous piece doesn't already end with whitespace or '('.
    const last = pieces[pieces.length - 1];
    if (last && !/[\s(]$/.test(last)) pieces.push(' ');
    if (isWhiteMove) {
        pieces.push(`${moveNumber}. ${san}`);
    } else if (isFirstAfterDelim) {
        pieces.push(`${moveNumber}... ${san}`);
    } else {
        pieces.push(san);
    }
}

function formatAnnotationsComment(anns: Annotation[]): string {
    const arrows: Annotation[] = [];
    const squares: Annotation[] = [];
    for (const a of anns) {
        if (a.dest) arrows.push(a);
        else squares.push(a);
    }
    const out: string[] = [];
    if (arrows.length > 0) {
        const parts = arrows
            .map(a => `${a.brush}${a.orig}${a.dest}`)
            .sort();
        out.push(`[%cal ${parts.join(',')}]`);
    }
    if (squares.length > 0) {
        const parts = squares
            .map(a => `${a.brush}${a.orig}`)
            .sort();
        out.push(`[%csl ${parts.join(',')}]`);
    }
    return out.join('');
}

function resolveChildFen(fen: string, san: string): string {
    const chess = new Chess(fen);
    const moved = chess.move(san);
    if (!moved) {
        throw new RepertoirePgnError(
            `encodeRepertoirePgn: illegal SAN "${san}" from FEN "${fen}".`,
        );
    }
    return normalizeFenResetHalfmoveClock(chess.fen());
}

// ── Decode ──────────────────────────────────────────────────────────────

/**
 * Parse a one-game repertoire PGN. Rejects (by throwing
 * `RepertoirePgnError`):
 *   • missing `[Repertoire]` header AND no `options.defaultOrientation`,
 *   • non-"White"/"Black" `[Repertoire]` header value,
 *   • `[FEN]` / `[SetUp]` headers (non-standard starting position),
 *   • multiple games in the same payload,
 *   • illegal SAN that does not parse on the current position.
 *
 * `defaultOrientation`, if supplied, is used as the orientation when the
 * PGN omits the `[Repertoire]` header — this makes the paste-box flow
 * (Edit mode) accept a bare movetext snippet scoped to the orientation
 * the user is editing, while file uploads (which always go through
 * `encodeRepertoirePgn` and therefore carry a header) keep the
 * strict-header behaviour. A mismatched header (PGN says "Black" but
 * `defaultOrientation` is `white`) still throws — the explicit header is
 * treated as a safety net and wins over the default.
 *
 * Returns the decoded edge list (in encounter order — BFS-ish; the merge
 * step doesn't require any particular order) and the per-FEN annotation
 * map populated only from structured `[%cal …]` / `[%csl …]` comments.
 */
export function decodeRepertoirePgn(
    text: string,
    options: { defaultOrientation?: 'white' | 'black' } = {},
): DecodedRepertoirePgn {
    if (typeof text !== 'string' || text.trim().length === 0) {
        throw new RepertoirePgnError('decodeRepertoirePgn: empty input.');
    }

    const { headers, body, gameCount } = splitHeadersAndBody(text);

    if (gameCount > 1) {
        throw new RepertoirePgnError(
            `decodeRepertoirePgn: file contains ${gameCount} games — only ` +
            `single-game PGNs are accepted.`,
        );
    }

    if (headers.has('FEN') || headers.has('SetUp')) {
        throw new RepertoirePgnError(
            'decodeRepertoirePgn: non-standard starting position ' +
            '([FEN] / [SetUp] header) is not supported — repertoires ' +
            'always root at the standard initial position.',
        );
    }

    const repHeader = headers.get(HEADER_REPERTOIRE);
    let orientation: 'white' | 'black';
    if (repHeader === undefined) {
        if (options.defaultOrientation) {
            orientation = options.defaultOrientation;
        } else {
            throw new RepertoirePgnError(
                `decodeRepertoirePgn: missing [${HEADER_REPERTOIRE} "White"|"Black"] header.`,
            );
        }
    } else if (repHeader === HEADER_REPERTOIRE_WHITE) {
        orientation = 'white';
    } else if (repHeader === HEADER_REPERTOIRE_BLACK) {
        orientation = 'black';
    } else {
        throw new RepertoirePgnError(
            `decodeRepertoirePgn: [${HEADER_REPERTOIRE}] header must be ` +
            `"White" or "Black" (got ${JSON.stringify(repHeader)}).`,
        );
    }

    const tokens = tokenizeMovetext(body);

    // Stronger multi-game detection: count depth-0 result markers, and
    // reject if any "real" content (SAN, comment, variation open) appears
    // AFTER the first depth-0 result token. The header-block-only
    // detector in `splitHeadersAndBody` misses cases where two games are
    // concatenated within a single header block, e.g.
    //   1. e4 e5 * 1. d4 d5 *
    // which the standard PGN tokenizer would otherwise silently merge.
    {
        let depth = 0;
        let sawDepth0Result = false;
        for (const t of tokens) {
            if (t.kind === 'open') { depth++; continue; }
            if (t.kind === 'close') { if (depth > 0) depth--; continue; }
            if (depth > 0) continue;
            if (t.kind === 'result') {
                if (sawDepth0Result) {
                    throw new RepertoirePgnError(
                        `decodeRepertoirePgn: file contains multiple games — ` +
                        `only single-game PGNs are accepted.`,
                    );
                }
                sawDepth0Result = true;
                continue;
            }
            // SAN / comment after a depth-0 result is a second game.
            if (sawDepth0Result && (t.kind === 'san' || t.kind === 'comment')) {
                throw new RepertoirePgnError(
                    `decodeRepertoirePgn: file contains multiple games — ` +
                    `only single-game PGNs are accepted.`,
                );
            }
        }
    }

    const edges: DecodedEdge[] = [];
    const edgeKeySeen = new Set<string>();
    const annotationsByFen = new Map<string, Annotation[]>();

    // Variation stack: each entry holds the Chess() instance to resume
    // from when the matching ')' is encountered, plus the position the
    // most-recent move at that level STARTED from. `prevFen` is per-frame
    // so a sequence like `(...)(...)` after the same parent move correctly
    // branches BOTH variations from the same source position.
    type Frame = { chess: Chess; prevFen: string };
    const root = normalizeFenResetHalfmoveClock(new Chess().fen());
    let cur: Frame = { chess: new Chess(), prevFen: root };
    const stack: Frame[] = [];
    // Pending comments before the first move attach to root.
    let pendingCommentTarget: string = root;

    for (const tok of tokens) {
        if (tok.kind === 'open') {
            // Branch as an alternative to the LAST move at this level. The
            // outer frame is preserved on the stack so a later ')' restores
            // it exactly, including its `prevFen` so any sibling `(...)`
            // following it branches from the same source position.
            stack.push(cur);
            const branchedChess = new Chess(cur.prevFen);
            cur = { chess: branchedChess, prevFen: cur.prevFen };
            // The next SAN inside this variation moves FROM cur.prevFen.
            pendingCommentTarget = cur.prevFen;
            continue;
        }
        if (tok.kind === 'close') {
            const popped = stack.pop();
            if (!popped) {
                throw new RepertoirePgnError(
                    `decodeRepertoirePgn: unmatched ')' in movetext.`,
                );
            }
            cur = popped;
            // Pending comment after a ')' attaches to the position
            // currently held by the resumed frame (i.e. the position
            // reached by the last move at the outer level).
            pendingCommentTarget = normalizeFenResetHalfmoveClock(cur.chess.fen());
            continue;
        }
        if (tok.kind === 'comment') {
            const parsed = parseAnnotationsFromComment(tok.text);
            if (parsed) {
                // Replace the entry — within one PGN, the LAST encountered
                // structured comment at a given FEN wins.
                annotationsByFen.set(pendingCommentTarget, parsed);
            }
            continue;
        }
        if (tok.kind === 'result') {
            // The multi-game detector earlier already ensured there's at
            // most one depth-0 result token with no further content after
            // it; nested-level results (rare) are tolerated and ignored.
            continue;
        }
        // SAN token.
        const san = tok.text;
        const from = normalizeFenResetHalfmoveClock(cur.chess.fen());
        let moved;
        try {
            moved = cur.chess.move(san);
        } catch {
            moved = null;
        }
        if (!moved) {
            throw new RepertoirePgnError(
                `decodeRepertoirePgn: illegal move "${san}" from FEN "${from}".`,
            );
        }
        const to = normalizeFenResetHalfmoveClock(cur.chess.fen());
        const key = `${from}::${san}`;
        if (!edgeKeySeen.has(key)) {
            edgeKeySeen.add(key);
            edges.push({ from, san });
        }
        // Update this frame's source-of-last-move so the NEXT `(` at
        // this level branches from `from` (the position the move that
        // was just played started from).
        cur.prevFen = from;
        pendingCommentTarget = to;
    }

    if (stack.length > 0) {
        throw new RepertoirePgnError(
            `decodeRepertoirePgn: unmatched '(' in movetext (${stack.length} unclosed).`,
        );
    }

    return { orientation, edges, annotationsByFen };
}

// ── Header / body split ──────────────────────────────────────────────

/**
 * Split PGN text into the first game's tag-pair set (headers) and
 * movetext body, and count the total number of games in the file.
 *
 * Game-counting state machine — each game is "header block (optional)
 * + movetext block (optional)":
 *
 *   `phase: 'pre'` — nothing seen yet.
 *   `phase: 'headers'` — we're collecting tag pairs for game N.
 *   `phase: 'movetext'` — we're inside game N's movetext.
 *
 * Transitions:
 *   pre → headers     (a tag-pair line arrives)
 *   pre → movetext    (a non-blank, non-header line arrives → game 1 begins)
 *   headers → movetext (blank line followed by a non-header line, OR a
 *                       non-header line directly)
 *   movetext → pre    (blank line — next content (header OR movetext)
 *                      starts a new game)
 *
 * `gameCount` is incremented on every transition into `headers` or
 * `movetext` from `pre`. Only game 1's headers + movetext are retained
 * (game ≥ 2 content is discarded — the caller throws on `gameCount > 1`
 * anyway).
 */
function splitHeadersAndBody(text: string): {
    headers: Map<string, string>;
    body: string;
    gameCount: number;
} {
    // Strip BOM if present.
    const cleaned = text.replace(/^\uFEFF/, '');
    const lines = cleaned.split(/\r?\n/);

    const headers = new Map<string, string>();
    const movetextLines: string[] = [];
    let gameCount = 0;
    // Phases used by the game-counting state machine:
    //   - 'pre': start of file, OR just left a movetext block via blank
    //     line. The next content (headers OR movetext) starts a new game.
    //   - 'headers': inside the current game's tag-pair block.
    //   - 'pre-movetext': current game's header block just ended (blank
    //     line). The next non-blank, non-header line attaches to THIS
    //     game's movetext (no new game).
    //   - 'movetext': inside the current game's movetext.
    type Phase = 'pre' | 'headers' | 'pre-movetext' | 'movetext';
    let phase: Phase = 'pre';

    const beginNewGame = () => {
        gameCount++;
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0) {
            // Blank line resets phase to 'pre' only from `movetext`.
            // Inside a header block, blank line just transitions us out
            // of headers — the next content (headers OR movetext) is
            // still part of THIS game, so we stay implicitly in the
            // current game.
            if (phase === 'movetext') {
                phase = 'pre';
            } else if (phase === 'headers') {
                // Header block closed — keep phase=headers so a
                // subsequent movetext line on this game still attaches
                // to game N rather than starting a new game.
                phase = 'pre-movetext';
            }
            continue;
        }
        const headerMatch = line.match(/^\[([A-Za-z][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\]$/);
        if (headerMatch) {
            if (phase === 'pre' || phase === 'pre-movetext') {
                // Starting a NEW game (either the first, or one after a
                // movetext + blank-line gap).
                beginNewGame();
                phase = 'headers';
            }
            // We allow tag-pair lines that immediately follow another
            // tag-pair line without a blank gap — common in handwritten
            // PGN. Just stay in 'headers'.
            if (gameCount === 1 && phase === 'headers') {
                headers.set(headerMatch[1], headerMatch[2].replace(/\\(.)/g, '$1'));
            }
            continue;
        }
        // Non-blank, non-header line = movetext.
        if (phase === 'pre' || phase === 'pre-movetext' || phase === 'headers') {
            if (phase === 'pre' || phase === 'pre-movetext') {
                // Either game 1 starting with movetext only (no
                // headers), or we entered a fresh game after a
                // movetext + blank-line gap.
                if (phase === 'pre') beginNewGame();
                // 'pre-movetext' means we just left a header block of
                // the CURRENT game and are now entering its movetext —
                // do NOT increment.
            }
            phase = 'movetext';
        }
        if (gameCount === 1) {
            movetextLines.push(rawLine);
        }
    }

    return { headers, body: movetextLines.join('\n'), gameCount };
}

// ── Movetext tokenizer ────────────────────────────────────────────────

type Token =
    | { kind: 'san'; text: string }
    | { kind: 'comment'; text: string }
    | { kind: 'open' }
    | { kind: 'close' }
    | { kind: 'result'; text: string };

/**
 * Tokenize movetext into SANs / comments / `(` / `)` / result markers.
 * Skips move numbers and NAGs (`$N`). Result markers (`1-0`, `0-1`,
 * `1/2-1/2`, `*`) are emitted as their own token so the decoder can
 * detect multi-game files (two result tokens at depth 0 → ambiguous,
 * reject).
 *
 * Brace comments `{ … }` are returned verbatim (without the braces).
 * Semicolon comments are dropped (lichess does not use them for `%cal`
 * markup, so we ignore them entirely).
 */
function tokenizeMovetext(movetext: string): Token[] {
    const out: Token[] = [];
    let i = 0;
    while (i < movetext.length) {
        const c = movetext[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '{') {
            let depth = 1;
            i++;
            let s = '';
            while (i < movetext.length && depth > 0) {
                const d = movetext[i];
                if (d === '{') depth++;
                else if (d === '}') { depth--; if (depth === 0) { i++; break; } }
                s += d;
                i++;
            }
            out.push({ kind: 'comment', text: s });
            continue;
        }
        if (c === ';') {
            while (i < movetext.length && movetext[i] !== '\n') i++;
            continue;
        }
        if (c === '(') { out.push({ kind: 'open' }); i++; continue; }
        if (c === ')') { out.push({ kind: 'close' }); i++; continue; }
        if (c === '$') {
            i++;
            while (i < movetext.length && /\d/.test(movetext[i])) i++;
            continue;
        }
        // Read a word.
        let word = '';
        while (
            i < movetext.length &&
            !/\s/.test(movetext[i]) &&
            movetext[i] !== '(' &&
            movetext[i] !== ')' &&
            movetext[i] !== '{' &&
            movetext[i] !== ';'
        ) {
            word += movetext[i];
            i++;
        }
        if (!word) continue;
        if (word === '...') continue;
        if (word === '1-0' || word === '0-1' || word === '1/2-1/2' || word === '*') {
            out.push({ kind: 'result', text: word });
            continue;
        }
        // PGN allows the move-number indication and the SAN to be written
        // with no whitespace between them ("1.e4", "1...e5"). Without this
        // strip, the whole token is treated as SAN and chess.js rejects it
        // — atomically failing the import for a perfectly valid PGN. Strip
        // a leading "<digits>(...|.+)" prefix; if anything remains, the
        // remainder is the SAN, otherwise the token was a bare move number.
        const stripped = word.replace(/^\d+(?:\.{3}|\.+)/, '');
        if (!stripped) continue; // bare move number ("1.", "1...", "12..")
        out.push({ kind: 'san', text: stripped });
    }
    return out;
}

// ── Annotation comment parsing ────────────────────────────────────────

/**
 * Parse `[%cal …]` and `[%csl …]` markers out of a comment body. Returns
 * the merged annotation list, or `null` if no structured marker was
 * present (plain-text or empty comments → null, so the caller knows not
 * to replace existing annotations).
 */
function parseAnnotationsFromComment(comment: string): Annotation[] | null {
    const result: Annotation[] = [];

    // Match [%cal G a1a2 , R b1b2] and similar; tolerate whitespace and
    // multiple groups in one comment.
    const reCal = /\[%cal\s+([^\]]*)\]/g;
    const reCsl = /\[%csl\s+([^\]]*)\]/g;

    let m: RegExpExecArray | null;
    while ((m = reCal.exec(comment)) !== null) {
        const items = m[1].split(',').map(s => s.trim()).filter(Boolean);
        for (const item of items) {
            // BRUSH + FROM + TO  (e.g., Ge2e4, Yh1h8). Brush is one char G/Y/R/B.
            const cm = /^([GYRB])([a-h][1-8])([a-h][1-8])$/.exec(item);
            if (!cm) continue;
            result.push({ brush: cm[1] as Annotation['brush'], orig: cm[2], dest: cm[3] });
        }
    }
    while ((m = reCsl.exec(comment)) !== null) {
        const items = m[1].split(',').map(s => s.trim()).filter(Boolean);
        for (const item of items) {
            const cm = /^([GYRB])([a-h][1-8])$/.exec(item);
            if (!cm) continue;
            result.push({ brush: cm[1] as Annotation['brush'], orig: cm[2] });
        }
    }

    // Gate the "we have an annotation set to replace with" signal on the
    // presence of at least one VALID annotation. The spec is explicit
    // (REPERTOIRE-PGN.md): import can add or replace annotations but
    // cannot CLEAR them. An empty `[%cal ]` token, a malformed
    // `[%cal Xe2e4]`, or any structured marker that parses to zero
    // valid annotations therefore returns null — the merge layer
    // treats null as "no annotation supplied" and leaves the existing
    // set untouched.
    if (result.length === 0) return null;
    return result;
}
