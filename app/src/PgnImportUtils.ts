import { Chess } from 'chess.js';
import { Annotation } from './Annotation';

export interface ParsedPgn {
    mainLinePgn: string;
    subvariantArrows: Map<string, Annotation[]>;
}

// Arrow brush colors for each pair of half-moves in a subvariant:
// Pair 1 (green)  = default right-click drag
// Pair 2 (red)    = Ctrl + right-click drag
// Pair 3 (blue)   = Alt + right-click drag
// Pair 4 (yellow) = Shift+Alt + right-click drag
const PAIR_BRUSHES: Annotation['brush'][] = ['G', 'R', 'B', 'Y'];

function stripHeaders(pgnText: string): string {
    return pgnText.replace(/^\s*\[[A-Za-z].*\]\s*$/gm, '').trim();
}

export function tokenizePgn(movetext: string): string[] {
    const tokens: string[] = [];
    let i = 0;

    while (i < movetext.length) {
        if (/\s/.test(movetext[i])) {
            i++;
            continue;
        }

        // Skip brace comments { ... }
        if (movetext[i] === '{') {
            let d = 1;
            i++;
            while (i < movetext.length && d > 0) {
                if (movetext[i] === '{') d++;
                if (movetext[i] === '}') d--;
                i++;
            }
            continue;
        }

        // Skip semicolon comments (rest of line)
        if (movetext[i] === ';') {
            while (i < movetext.length && movetext[i] !== '\n') i++;
            continue;
        }

        // Parentheses are structural tokens
        if (movetext[i] === '(' || movetext[i] === ')') {
            tokens.push(movetext[i]);
            i++;
            continue;
        }

        // Skip NAGs ($N)
        if (movetext[i] === '$') {
            i++;
            while (i < movetext.length && /\d/.test(movetext[i])) i++;
            continue;
        }

        // Read a word (move number or SAN move)
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

        if (word) {
            tokens.push(word);
        }
    }

    return tokens;
}

function isMoveNumberOrResult(token: string): boolean {
    return (
        /^\d+\.+$/.test(token) ||
        ['1-0', '0-1', '1/2-1/2', '*'].includes(token)
    );
}

function variationMovesToArrows(
    branchFen: string,
    moves: string[]
): Annotation[] {
    const arrows: Annotation[] = [];
    const chess = new Chess(branchFen);

    const maxHalfMoves = Math.min(moves.length, PAIR_BRUSHES.length * 2);

    for (let i = 0; i < maxHalfMoves; i++) {
        const pairIndex = Math.floor(i / 2);
        const brush = PAIR_BRUSHES[pairIndex];

        try {
            const moveResult = chess.move(moves[i]);
            if (!moveResult) break;

            arrows.push({
                brush,
                orig: moveResult.from,
                dest: moveResult.to,
            });
        } catch {
            break;
        }
    }

    return arrows;
}

/**
 * Parses a PGN string that may contain variations (parenthesized alternatives).
 *
 * Returns the main-line PGN (without variations) and a map of
 * branch-point FEN → arrow annotations that visualize the first
 * subvariant at each branch point.
 *
 * Sub-sub-variants (depth ≥ 2) are ignored.
 * Only the first variation per branch position is used.
 */
export function parsePgnWithVariations(pgnText: string): ParsedPgn {
    const movetext = stripHeaders(pgnText);
    const tokens = tokenizePgn(movetext);

    const chess = new Chess();
    let depth = 0;
    let previousFen = chess.fen();
    const subvariantArrows = new Map<string, Annotation[]>();
    let currentVariationMoves: string[] = [];
    let currentVariationBranchFen = '';

    for (const token of tokens) {
        if (token === '(') {
            if (depth === 0) {
                currentVariationBranchFen = previousFen;
                currentVariationMoves = [];
            }
            depth++;
            continue;
        }

        if (token === ')') {
            if (depth <= 0) {
                // Unmatched closing paren — skip rather than going negative
                continue;
            }
            if (depth === 1 && currentVariationMoves.length > 0) {
                // Only use the first variation per branch position
                if (!subvariantArrows.has(currentVariationBranchFen)) {
                    const arrows = variationMovesToArrows(
                        currentVariationBranchFen,
                        currentVariationMoves
                    );
                    if (arrows.length > 0) {
                        subvariantArrows.set(
                            currentVariationBranchFen,
                            arrows
                        );
                    }
                }
            }
            depth--;
            continue;
        }

        if (isMoveNumberOrResult(token)) continue;

        if (depth === 0) {
            previousFen = chess.fen();
            try {
                chess.move(token);
            } catch {
                break;
            }
        } else if (depth === 1) {
            currentVariationMoves.push(token);
        }
        // depth >= 2: sub-sub-variants are ignored
    }

    return {
        mainLinePgn: chess.pgn(),
        subvariantArrows,
    };
}
