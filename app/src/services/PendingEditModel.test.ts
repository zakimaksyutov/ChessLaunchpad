import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { PendingEditModel } from './PendingEditModel';
import {
    createEmptyRepertoires,
    RepertoireEntry,
    findRepertoire,
} from '../models/Repertoires';
import {
    extractFsrsCardsFromRepertoires,
} from '../utils/RepertoiresSerde';
import { pgnToRepertoires } from '../test-utils/repertoireBuilders';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import { FSRSService } from './FSRSService';
import { Annotation } from '../models/Annotation';
import { State, createEmptyCard } from 'ts-fsrs';

// ── Helpers ───────────────────────────────────────────────────────────

const startFen = normalizeFenResetHalfmoveClock(new Chess().fen());

function fenAfter(sans: string[]): string {
    const chess = new Chess();
    for (const s of sans) chess.move(s);
    return normalizeFenResetHalfmoveClock(chess.fen());
}

function buildRepertoires(variants: Array<{ pgn: string; orientation: 'white' | 'black' }>): {
    repertoires: RepertoireEntry[];
    fsrsCards: Record<string, ReturnType<typeof FSRSService.serialize> extends infer T ? T : never>;
} {
    const reps = pgnToRepertoires(
        variants.map(v => ({ pgn: v.pgn, orientation: v.orientation })),
    );
    // Build FSRS cards from the dict so the model sees a populated baseFsrsCards.
    const fsrsCards = extractFsrsCardsFromRepertoires(reps);
    return { repertoires: reps, fsrsCards };
}

function emptyModel(): PendingEditModel {
    return new PendingEditModel(createEmptyRepertoires(), {});
}

// ── isEmpty ───────────────────────────────────────────────────────────

describe('PendingEditModel.isEmpty', () => {
    it('returns true on a fresh model with empty base', () => {
        const m = emptyModel();
        expect(m.isEmpty()).toBe(true);
    });

    it('returns true after add+delete that cancel out', () => {
        const m = emptyModel();
        const after = m.addEdge(startFen, 'e4', 'white');
        expect(after).toBe(fenAfter(['e4']));
        m.deleteEdge(startFen, 'e4', 'white');
        expect(m.isEmpty()).toBe(true);
    });

    it('returns false after a single add', () => {
        const m = emptyModel();
        m.addEdge(startFen, 'e4', 'white');
        expect(m.isEmpty()).toBe(false);
    });

    it('returns false on annotation-only change', () => {
        const m = emptyModel();
        m.setAnnotations(startFen, 'white', [
            { brush: 'G', orig: 'e2', dest: 'e4' },
        ]);
        expect(m.isEmpty()).toBe(false);
    });
});

// ── addEdge ───────────────────────────────────────────────────────────

describe('PendingEditModel.addEdge', () => {
    it('returns null on illegal SAN', () => {
        const m = emptyModel();
        expect(m.addEdge(startFen, 'e5', 'white')).toBeNull();
    });

    it('attaches a fresh New-state card on user-turn add', () => {
        const m = emptyModel();
        m.addEdge(startFen, 'e4', 'white');
        const key = FSRSService.makeCardKey(startFen, 'e4');
        expect(m.newCardsByKey[key]).toBeDefined();
        expect(m.newCardsByKey[key].state).toBe(State.New);
        // Working copy carries the card on the edge.
        const rep = m.getCurrentRepertoire('white');
        expect(rep.positions[startFen].moves['e4'].card).toBeDefined();
    });

    it('does not attach a card on opponent-turn add', () => {
        const m = emptyModel();
        m.addEdge(startFen, 'e4', 'black'); // start position is white-to-move
        const key = FSRSService.makeCardKey(startFen, 'e4');
        expect(m.newCardsByKey[key]).toBeUndefined();
        const rep = m.getCurrentRepertoire('black');
        expect(rep.positions[startFen].moves['e4'].card).toBeUndefined();
    });

    it('resurrects a base card on delete-then-readd (no card-history reset)', () => {
        // Base repertoire has 1.e4 with a Learning-state card.
        const { repertoires, fsrsCards } = buildRepertoires([
            { pgn: '1. e4', orientation: 'white' },
        ]);
        // Rate the card once so it's no longer New.
        const fsrs = new FSRSService(fsrsCards);
        fsrs.rateCardByKey(FSRSService.makeCardKey(startFen, 'e4'), true, new Date());

        const m = new PendingEditModel(repertoires, fsrs.getCards());

        m.deleteEdge(startFen, 'e4', 'white');
        const after = m.addEdge(startFen, 'e4', 'white');
        expect(after).toBe(fenAfter(['e4']));

        const rep = m.getCurrentRepertoire('white');
        const card = rep.positions[startFen].moves['e4'].card;
        expect(card).toBeDefined();
        // Re-uses the existing card object — not a fresh New.
        expect(card!.state).not.toBe(State.New);
        // The newCardsByKey ledger is empty — base resurrection, not new.
        expect(Object.keys(m.newCardsByKey)).toHaveLength(0);
        // Cancel-out: delete+readd → isEmpty().
        expect(m.isEmpty()).toBe(true);
    });

    it('is idempotent if called twice for the same edge', () => {
        const m = emptyModel();
        m.addEdge(startFen, 'e4', 'white');
        const repAfterFirst = m.getCurrentRepertoire('white');
        const cardRefAfterFirst = repAfterFirst.positions[startFen].moves['e4'].card;
        m.addEdge(startFen, 'e4', 'white');
        const delta = m.computeDelta();
        expect(delta.counts.added).toBe(1);
        // Card reference must be the same — a second addEdge call on an
        // existing edge must not re-mint or re-assign the FSRS card.
        const cardRefAfterSecond = repAfterFirst.positions[startFen].moves['e4'].card;
        expect(cardRefAfterSecond).toBe(cardRefAfterFirst);
    });

    it('re-adding an edge that exists in base preserves the base FSRS card', () => {
        // Simulates the PGN re-import scenario: a move with real review
        // history is re-applied via addEdge. The card on the working copy
        // must remain the base card, never get overwritten with a fresh
        // New-state card.
        const reps = createEmptyRepertoires();
        const whiteRep = findRepertoire(reps, 'white')!;
        const afterE4 = fenAfter(['e4']);
        const trackedBase = {
            ...FSRSService.serialize(createEmptyCard()),
            stability: 42,
            reps: 7,
            state: State.Review,
        };
        whiteRep.positions[startFen] = { moves: { e4: { to: afterE4, card: trackedBase } } };
        whiteRep.positions[afterE4] = { moves: {} };
        const fsrsCards = { [FSRSService.makeCardKey(startFen, 'e4')]: trackedBase };

        const m = new PendingEditModel(reps, fsrsCards);
        const rep = m.getCurrentRepertoire('white');
        // Snapshot the working-copy card reference BEFORE re-adding — addEdge
        // must leave this exact reference in place (no re-clone, no mint).
        const workingCardBefore = rep.positions[startFen].moves['e4'].card;
        m.addEdge(startFen, 'e4', 'white');
        expect(rep.positions[startFen].moves['e4'].card).toBe(workingCardBefore);
        // Content must still match the base — i.e., not a fresh New-state card.
        expect(rep.positions[startFen].moves['e4'].card).toEqual(trackedBase);
        // No pending churn — re-adding a base edge must stay a true no-op.
        expect(m.isEmpty()).toBe(true);
    });

    it('refuses to add from a FEN not reachable from root (no orphan)', () => {
        const m = emptyModel();
        // FEN reached by 1.e4 — never added to the repertoire, so unreachable.
        const orphanFrom = fenAfter(['e4']);
        const result = m.addEdge(orphanFrom, 'e5', 'white');
        expect(result).toBeNull();
        // Working copy must not have been mutated — no orphan position
        // and no orphan child position created.
        const rep = m.getCurrentRepertoire('white');
        expect(rep.positions[orphanFrom]).toBeUndefined();
        expect(rep.positions[fenAfter(['e4', 'e5'])]).toBeUndefined();
        // Model is still empty — save would not throw.
        expect(m.isEmpty()).toBe(true);
    });
});

// ── deleteEdge cascade & transposition ────────────────────────────────

describe('PendingEditModel.deleteEdge cascade', () => {
    it('drops all descendants when the deleted edge is the only path', () => {
        // 1.e4 c5 2.Nf3 — pure linear, white repertoire.
        const { repertoires, fsrsCards } = buildRepertoires([
            { pgn: '1. e4 c5 2. Nf3', orientation: 'white' },
        ]);
        const m = new PendingEditModel(repertoires, fsrsCards);
        const result = m.deleteEdge(startFen, 'e4', 'white');
        // Removed positions: after-e4, after-e4 c5, after-e4 c5 Nf3 (3).
        expect(result.removedPositions).toHaveLength(3);

        const delta = m.computeDelta();
        // Removed *edges* in the delta: 3 (one per ply).
        expect(delta.counts.removed).toBe(3);
        expect(delta.counts.added).toBe(0);
        // Single chain (linear).
        expect(delta.removedChains).toHaveLength(1);
        const chain = delta.removedChains[0];
        expect(chain.head.san).toBe('e4');
        expect(chain.tail.map(e => e.san)).toEqual(['c5', 'Nf3']);
        expect(chain.tailHint).toBeUndefined();
    });

    it('keeps transposition-protected subtrees alive and annotates the chain tail', () => {
        // Two paths to the same 4-ply position via different move orders:
        //   1.e4 c5 2.Nf3 Nc6   (Sicilian via e4)
        //   1.Nf3 c5 2.e4 Nc6   (transposes into the same position via Nf3)
        // Deleting 1.e4 should NOT prune positions reachable from 1.Nf3, and
        // the deeper transposed position survives and can still be reached
        // via 1.Nf3 c5 2.e4 Nc6.
        const { repertoires, fsrsCards } = buildRepertoires([
            { pgn: '1. e4 c5 2. Nf3 Nc6 3. d4', orientation: 'white' },
            { pgn: '1. Nf3 c5 2. e4 Nc6 3. d4', orientation: 'white' },
        ]);
        const m = new PendingEditModel(repertoires, fsrsCards);

        // Sanity: position after 1.e4 c5 2.Nf3 Nc6 exists in base.
        const transFen = fenAfter(['e4', 'c5', 'Nf3', 'Nc6']);
        expect(m.getCurrentRepertoire('white').positions[transFen]).toBeDefined();

        // Delete 1.e4 — the after-e4 chain is pruned; the transposition-
        // protected deeper position survives via 1.Nf3 c5 2.e4 Nc6.
        const result = m.deleteEdge(startFen, 'e4', 'white');
        expect(result.removedPositions).toContain(fenAfter(['e4']));
        expect(result.removedPositions).toContain(fenAfter(['e4', 'c5']));
        // Critical: the transposition-protected position survives.
        expect(result.removedPositions).not.toContain(transFen);

        const delta = m.computeDelta();
        expect(delta.counts.removed).toBeGreaterThan(0);
        expect(delta.removedChains).toHaveLength(1);
        const chain = delta.removedChains[0];
        expect(chain.head.san).toBe('e4');
        // Tail hint: cascade stopped on a transposition — the chain's last
        // pruned edge points to transFen which is still reachable via 1.Nf3 …
        expect(chain.tailHint?.kind).toBe('survives-via');
        if (chain.tailHint?.kind === 'survives-via') {
            expect(chain.tailHint.viaPgn).toContain('Nf3');
        }
    });

    it('cascade prunes new cards minted for descendants (no leak)', () => {
        const m = emptyModel();
        // Build a small chain in the white repertoire.
        m.addEdge(startFen, 'e4', 'white');
        m.addEdge(fenAfter(['e4']), 'e5', 'white');           // opponent move
        m.addEdge(fenAfter(['e4', 'e5']), 'Nf3', 'white');     // user move → card
        const nf3Key = FSRSService.makeCardKey(fenAfter(['e4', 'e5']), 'Nf3');
        expect(m.newCardsByKey[nf3Key]).toBeDefined();

        // Delete the root edge → entire chain prunes; Nf3 card is dropped.
        m.deleteEdge(startFen, 'e4', 'white');
        expect(m.newCardsByKey[nf3Key]).toBeUndefined();
        expect(m.isEmpty()).toBe(true);
    });

    it('returns empty on no-op delete', () => {
        const m = emptyModel();
        const r = m.deleteEdge(startFen, 'e4', 'white');
        expect(r.removedPositions).toEqual([]);
    });
});

// ── Annotation diffs (set semantics) ──────────────────────────────────

describe('PendingEditModel.setAnnotations and annotation diff', () => {
    it('treats annotations as a set — order/duplicates don\'t register as changes', () => {
        const baseAnn: Annotation[] = [
            { brush: 'G', orig: 'e2', dest: 'e4' },
            { brush: 'R', orig: 'd2', dest: 'd4' },
        ];
        const reps = createEmptyRepertoires();
        const whiteRep = findRepertoire(reps, 'white')!;
        whiteRep.positions[startFen] = { moves: {}, annotations: baseAnn };

        const m = new PendingEditModel(reps, {});

        // Reorder + duplicate the same annotations.
        m.setAnnotations(startFen, 'white', [
            { brush: 'R', orig: 'd2', dest: 'd4' },
            { brush: 'G', orig: 'e2', dest: 'e4' },
            { brush: 'G', orig: 'e2', dest: 'e4' }, // duplicate
        ]);
        expect(m.isEmpty()).toBe(true);
        const delta = m.computeDelta();
        expect(delta.editedAnnotations).toHaveLength(0);
    });

    it('counts a single change per position even if multiple arrows are added then cleared', () => {
        const reps = createEmptyRepertoires();
        const whiteRep = findRepertoire(reps, 'white')!;
        whiteRep.positions[startFen] = { moves: {} };

        const m = new PendingEditModel(reps, {});
        m.setAnnotations(startFen, 'white', [
            { brush: 'G', orig: 'e2', dest: 'e4' },
            { brush: 'R', orig: 'd2', dest: 'd4' },
        ]);
        // Clear one and add another.
        m.setAnnotations(startFen, 'white', [
            { brush: 'R', orig: 'd2', dest: 'd4' },
            { brush: 'B', orig: 'g1', dest: 'f3' },
        ]);
        const delta = m.computeDelta();
        expect(delta.counts.changed).toBe(1);
    });

    it('detects added annotations on a position previously without any', () => {
        const m = emptyModel();
        m.setAnnotations(startFen, 'white', [
            { brush: 'G', orig: 'e2', dest: 'e4' },
        ]);
        const delta = m.computeDelta();
        expect(delta.counts.changed).toBe(1);
        expect(delta.editedAnnotations[0].fen).toBe(startFen);
        expect(delta.editedAnnotations[0].before).toEqual([]);
        expect(delta.editedAnnotations[0].after).toHaveLength(1);
    });

    it('detects cleared annotations', () => {
        const reps = createEmptyRepertoires();
        const whiteRep = findRepertoire(reps, 'white')!;
        whiteRep.positions[startFen] = {
            moves: {},
            annotations: [{ brush: 'G', orig: 'e2', dest: 'e4' }],
        };

        const m = new PendingEditModel(reps, {});
        m.setAnnotations(startFen, 'white', []);
        const delta = m.computeDelta();
        expect(delta.counts.changed).toBe(1);
        expect(delta.editedAnnotations[0].after).toEqual([]);
    });

    it('does NOT count cascade-pruned annotated positions as "changed"', () => {
        // Regression: previously, deleting an edge that cascaded into an
        // annotated position would surface a phantom "changed" row whose
        // saved/staged boards weren't actually comparable. The removal is
        // already represented in `removedChains`; annotations ride along.
        const reps = createEmptyRepertoires();
        const whiteRep = findRepertoire(reps, 'white')!;
        // 1.e4 c5 — but stage the annotation on the after-c5 position.
        const baseReps = pgnToRepertoires(
            [{ pgn: '1. e4 c5', orientation: 'white' }],
        );
        const reuseWhite = findRepertoire(baseReps, 'white')!;
        const afterE4c5 = fenAfter(['e4', 'c5']);
        reuseWhite.positions[afterE4c5].annotations = [{ brush: 'G', orig: 'd2', dest: 'd4' }];
        const m = new PendingEditModel(baseReps, extractFsrsCardsFromRepertoires(baseReps));

        // Sanity: the annotated position is reachable.
        expect(m.getCurrentRepertoire('white').positions[afterE4c5]).toBeDefined();

        // Delete the root edge → cascade prunes the annotated position.
        m.deleteEdge(startFen, 'e4', 'white');
        const d = m.computeDelta();

        expect(d.counts.removed).toBe(2); // e4 + c5
        expect(d.counts.changed).toBe(0); // NOT 1 — the annotation went with the position
        expect(d.editedAnnotations).toHaveLength(0);
        void whiteRep; // keep the lint linter quiet on the helper alias
    });

    it('refuses to set annotations on a FEN not reachable from root (no orphan)', () => {
        const m = emptyModel();
        // FEN reached by 1.e4 — never added to the repertoire, so unreachable.
        const orphanFen = fenAfter(['e4']);
        m.setAnnotations(orphanFen, 'white', [
            { brush: 'G', orig: 'e2', dest: 'e4' },
        ]);
        const rep = m.getCurrentRepertoire('white');
        // Working copy must not have been mutated — no orphan position created.
        expect(rep.positions[orphanFen]).toBeUndefined();
        // Model is still empty — save would not throw.
        expect(m.isEmpty()).toBe(true);
    });
});

// ── Chain decomposition (Added) ───────────────────────────────────────

describe('PendingEditModel chain decomposition (Added)', () => {
    it('a length-1 add is a length-1 chain (head only)', () => {
        const m = emptyModel();
        m.addEdge(startFen, 'e4', 'white');
        const d = m.computeDelta();
        expect(d.addedChains).toHaveLength(1);
        expect(d.addedChains[0].head.san).toBe('e4');
        expect(d.addedChains[0].tail).toHaveLength(0);
        expect(d.counts.added).toBe(1);
    });

    it('a forced sequence of new plies is a single chain', () => {
        const m = emptyModel();
        m.addEdge(startFen, 'e4', 'white');
        m.addEdge(fenAfter(['e4']), 'e5', 'white');
        m.addEdge(fenAfter(['e4', 'e5']), 'Nf3', 'white');
        const d = m.computeDelta();
        expect(d.addedChains).toHaveLength(1);
        expect(d.addedChains[0].head.san).toBe('e4');
        expect(d.addedChains[0].tail.map(e => e.san)).toEqual(['e5', 'Nf3']);
        expect(d.counts.added).toBe(3);
    });

    it('branching splits a chain', () => {
        const m = emptyModel();
        m.addEdge(startFen, 'e4', 'white');                  // head 1
        m.addEdge(fenAfter(['e4']), 'e5', 'white');           // branch 1
        m.addEdge(fenAfter(['e4']), 'c5', 'white');           // branch 2 — splits
        const d = m.computeDelta();
        // The "1.e4" head can no longer absorb its descendants into one
        // chain because the branch starts immediately after. We expect:
        //   chain 1: e4 (head, length 1)
        //   chain 2: e5 (head, length 1)
        //   chain 3: c5 (head, length 1)
        expect(d.addedChains).toHaveLength(3);
        expect(d.counts.added).toBe(3);
    });

    it('annotates a chain that joins an existing subtree (with movesBelow count)', () => {
        // Base has a deeper subtree under the join point so we can verify
        // the movesBelow accounting exposes a real count, not 0.
        //   base: 1.e4 e5 2.Nf3 Nc6 3.Bb5    (user-turn edges below join: 3.Bb5 = 1)
        //   add:  1.Nf3 e5 2.e4              (joins at after-1.e4-e5-2.Nf3)
        const { repertoires, fsrsCards } = buildRepertoires([
            { pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5', orientation: 'white' },
        ]);
        const m = new PendingEditModel(repertoires, fsrsCards);
        m.addEdge(startFen, 'Nf3', 'white');
        m.addEdge(fenAfter(['Nf3']), 'e5', 'white');
        m.addEdge(fenAfter(['Nf3', 'e5']), 'e4', 'white');
        const d = m.computeDelta();
        const joining = d.addedChains.find(c => c.tailHint?.kind === 'joins-existing');
        expect(joining).toBeDefined();
        if (joining?.tailHint?.kind === 'joins-existing') {
            expect(joining.tailHint.movesBelow).toBe(1);
        }
    });
});

// ── Chain decomposition (Removed) ─────────────────────────────────────

describe('PendingEditModel chain decomposition (Removed)', () => {
    it('removed-side branching splits into separate chains', () => {
        // Symmetric to the Added branching test. The deleted root has two
        // children; the cascade prunes both, yielding three length-1 chains.
        // PGN labels for e5/c5 must fall back to baseRep since their `from`
        // is pruned from curRep.
        const { repertoires, fsrsCards } = buildRepertoires([
            { pgn: '1. e4 e5', orientation: 'white' },
            { pgn: '1. e4 c5', orientation: 'white' },
        ]);
        const m = new PendingEditModel(repertoires, fsrsCards);
        m.deleteEdge(startFen, 'e4', 'white');
        const d = m.computeDelta();
        expect(d.removedChains).toHaveLength(3);
        expect(d.counts.removed).toBe(3);
        const heads = d.removedChains.map(c => c.head.san).sort();
        expect(heads).toEqual(['c5', 'e4', 'e5']);
        // Parents of e5/c5 chains were pruned from curRep — PGN labels must
        // fall back to baseRep so the row stays informative.
        const e5chain = d.removedChains.find(c => c.head.san === 'e5')!;
        expect(e5chain.chainPgn).toBe('1. e4 e5');
        const c5chain = d.removedChains.find(c => c.head.san === 'c5')!;
        expect(c5chain.chainPgn).toBe('1. e4 c5');
    });

    it('deletes an opponent-turn edge (no FSRS card on the edge) with cascade', () => {
        // Delete the opponent reply `e5` from after 1.e4 — cascade should
        // drop afterE4e5 + afterE4e5Nf3 from the saved blob; no new cards
        // were minted so newCardsByKey accounting stays clean.
        const { repertoires, fsrsCards } = buildRepertoires([
            { pgn: '1. e4 e5 2. Nf3', orientation: 'white' },
        ]);
        const m = new PendingEditModel(repertoires, fsrsCards);
        const result = m.deleteEdge(fenAfter(['e4']), 'e5', 'white');
        // Removed positions: afterE4e5 (opponent target) and afterE4e5Nf3 (user move below).
        expect(result.removedPositions).toContain(fenAfter(['e4', 'e5']));
        expect(result.removedPositions).toContain(fenAfter(['e4', 'e5', 'Nf3']));
        expect(Object.keys(m.newCardsByKey)).toHaveLength(0);
        const d = m.computeDelta();
        // 2 edges removed: (afterE4, e5) and (afterE4e5, Nf3).
        expect(d.counts.removed).toBe(2);
    });
});

// ── Multi-orientation ─────────────────────────────────────────────────

describe('PendingEditModel multi-orientation', () => {
    it('mints a card for a black-orientation user-turn add and sums both sides', () => {
        const m = emptyModel();
        m.addEdge(startFen, 'e4', 'white');             // white user-turn
        const afterE4 = fenAfter(['e4']);
        // For the black repertoire, e4 must exist as the opponent edge so
        // afterE4 is reachable before we can add a user-turn response.
        m.addEdge(startFen, 'e4', 'black');             // black opponent-turn (no card)
        m.addEdge(afterE4, 'c5', 'black');              // black user-turn (black to move)
        expect(m.newCardsByKey[FSRSService.makeCardKey(afterE4, 'c5')]).toBeDefined();
        const d = m.computeDelta();
        expect(d.counts.added).toBe(3);
        expect(d.addedChains.some(c => c.orientation === 'white')).toBe(true);
        expect(d.addedChains.some(c => c.orientation === 'black')).toBe(true);
    });
});

// ── Tighten transposition-survival assertions ────────────────────────

describe('PendingEditModel transposition survival (exact values)', () => {
    it('pins down the exact edges/positions removed and the canonical via-path', () => {
        const { repertoires, fsrsCards } = buildRepertoires([
            { pgn: '1. e4 c5 2. Nf3 Nc6 3. d4', orientation: 'white' },
            { pgn: '1. Nf3 c5 2. e4 Nc6 3. d4', orientation: 'white' },
        ]);
        const m = new PendingEditModel(repertoires, fsrsCards);
        const result = m.deleteEdge(startFen, 'e4', 'white');
        // Two positions pruned (after-e4, after-e4-c5). transFen survives.
        expect(result.removedPositions).toHaveLength(2);

        const d = m.computeDelta();
        // Three edges removed along the e4 path: e4, c5, Nf3.
        expect(d.counts.removed).toBe(3);
        expect(d.removedChains).toHaveLength(1);
        const chain = d.removedChains[0];
        expect(chain.head.san).toBe('e4');
        expect(chain.tail.map(e => e.san)).toEqual(['c5', 'Nf3']);
        expect(chain.tailHint).toEqual({
            kind: 'survives-via',
            viaPgn: '1. Nf3 c5 2. e4',
            viaSan: 'e4',
        });
    });
});

// ── Tail hints (Removed) ──────────────────────────────────────────────

describe('PendingEditModel removed chain tail hints', () => {
    it('absent tailHint when chain ends at a true leaf', () => {
        const { repertoires, fsrsCards } = buildRepertoires([
            { pgn: '1. e4', orientation: 'white' },
        ]);
        const m = new PendingEditModel(repertoires, fsrsCards);
        m.deleteEdge(startFen, 'e4', 'white');
        const d = m.computeDelta();
        expect(d.removedChains).toHaveLength(1);
        expect(d.removedChains[0].tailHint).toBeUndefined();
    });
});

// ── Snapshot immutability ─────────────────────────────────────────────

describe('PendingEditModel.applyImportedPgn', () => {
    it('re-importing an edge already in base preserves its FSRS card (no history reset)', () => {
        // The live PGN re-import scenario: a user re-uploads a file that
        // overlaps with their saved repertoire. Every overlapping edge
        // hits this code path and must NOT mint a fresh New-state card
        // (which would wipe stability/reps/state). Pin down the contract
        // the gating comment in `addEdge` warns about.
        const reps = createEmptyRepertoires();
        const whiteRep = findRepertoire(reps, 'white')!;
        const afterE4 = fenAfter(['e4']);
        const trackedBase = {
            ...FSRSService.serialize(createEmptyCard()),
            stability: 42,
            reps: 7,
            state: State.Review,
        };
        whiteRep.positions[startFen] = { moves: { e4: { to: afterE4, card: trackedBase } } };
        whiteRep.positions[afterE4] = { moves: {} };
        const fsrsCards = { [FSRSService.makeCardKey(startFen, 'e4')]: trackedBase };

        const m = new PendingEditModel(reps, fsrsCards);
        const cardBefore = m.getCurrentRepertoire('white').positions[startFen].moves['e4'].card;

        const result = m.applyImportedPgn(
            'white',
            [{ from: startFen, san: 'e4' }],
            new Map(),
        );

        const cardAfter = m.getCurrentRepertoire('white').positions[startFen].moves['e4'].card;
        // Same reference — not a re-clone, not a fresh New-state card.
        expect(cardAfter).toBe(cardBefore);
        expect(cardAfter).toEqual(trackedBase);
        // Re-importing an existing edge is a true no-op.
        expect(result.addedEdges).toBe(0);
        expect(m.isEmpty()).toBe(true);
        expect(Object.keys(m.newCardsByKey)).toHaveLength(0);
    });

    it('addedEdges counts only brand-new edges; replacedAnnotations excludes unreachable no-ops', () => {
        // Base has 1.e4. Import {e4 (overlap), e4 e5 (new opponent), e4 e5 Nf3 (new user)}
        // plus an annotation on a reachable FEN and one on an unreachable FEN.
        // The counts must reflect actual mutations, not call counts — the
        // sticky bar and toast both read these numbers verbatim.
        const { repertoires, fsrsCards } = buildRepertoires([
            { pgn: '1. e4', orientation: 'white' },
        ]);
        const m = new PendingEditModel(repertoires, fsrsCards);

        const afterE4 = fenAfter(['e4']);
        const afterE4e5 = fenAfter(['e4', 'e5']);
        const unreachable = fenAfter(['d4']); // never added to the rep
        const annReachable: Annotation[] = [{ brush: 'G', orig: 'e2', dest: 'e4' }];
        const annUnreachable: Annotation[] = [{ brush: 'R', orig: 'd2', dest: 'd4' }];

        const result = m.applyImportedPgn(
            'white',
            [
                { from: startFen, san: 'e4' }, // already present → not counted
                { from: afterE4, san: 'e5' }, // new opponent edge → counted
                { from: afterE4e5, san: 'Nf3' }, // new user edge → counted
            ],
            new Map([
                [startFen, annReachable],
                [unreachable, annUnreachable],
            ]),
        );

        expect(result.addedEdges).toBe(2);
        expect(result.replacedAnnotations).toBe(1);

        // The unreachable annotation must not have created an orphan position.
        const rep = m.getCurrentRepertoire('white');
        expect(rep.positions[unreachable]).toBeUndefined();
        // The reachable annotation landed.
        expect(rep.positions[startFen].annotations).toEqual(annReachable);
    });

    it('replaces annotations on imported FENs but leaves un-mentioned FENs untouched (never clears)', () => {
        // Spec asymmetry: import can add/replace annotations but never CLEAR them.
        // A FEN absent from `annotationsByFen` must keep its existing annotations
        // verbatim — even if the user re-imports an overlapping subtree.
        const reps = createEmptyRepertoires();
        const whiteRep = findRepertoire(reps, 'white')!;
        const afterE4 = fenAfter(['e4']);
        const afterE4e5 = fenAfter(['e4', 'e5']);
        const existingOnE4: Annotation[] = [{ brush: 'G', orig: 'g1', dest: 'f3' }];
        const existingOnE4e5: Annotation[] = [{ brush: 'R', orig: 'd2', dest: 'd4' }];
        whiteRep.positions[startFen] = { moves: { e4: { to: afterE4 } } };
        whiteRep.positions[afterE4] = {
            moves: { e5: { to: afterE4e5 } },
            annotations: existingOnE4,
        };
        whiteRep.positions[afterE4e5] = { moves: {}, annotations: existingOnE4e5 };

        const m = new PendingEditModel(reps, {});

        const replacement: Annotation[] = [{ brush: 'B', orig: 'a1', dest: 'h8' }];
        const result = m.applyImportedPgn(
            'white',
            [], // no edge changes — only annotation replay
            new Map([[afterE4, replacement]]), // afterE4e5 absent from import
        );

        const rep = m.getCurrentRepertoire('white');
        // afterE4 was in the import → REPLACED with the new set.
        expect(rep.positions[afterE4].annotations).toEqual(replacement);
        // afterE4e5 was NOT in the import → untouched (never cleared).
        expect(rep.positions[afterE4e5].annotations).toEqual(existingOnE4e5);
        expect(result.replacedAnnotations).toBe(1);
    });

    it('re-importing identical annotations is not counted as a replacement', () => {
        // Set-equality semantics, mirroring computeDelta: importing the same
        // arrows/squares already on a position is a true no-op and must not
        // inflate the toast count. Order- and duplicate-insensitive.
        const reps = createEmptyRepertoires();
        const whiteRep = findRepertoire(reps, 'white')!;
        const afterE4 = fenAfter(['e4']);
        const existing: Annotation[] = [
            { brush: 'G', orig: 'g1', dest: 'f3' },
            { brush: 'R', orig: 'd2', dest: 'd4' },
        ];
        whiteRep.positions[startFen] = { moves: { e4: { to: afterE4 } } };
        whiteRep.positions[afterE4] = { moves: {}, annotations: existing };

        const m = new PendingEditModel(reps, {});
        // Capture the stored reference (the constructor deep-clones).
        const storedBefore = m.getCurrentRepertoire('white').positions[afterE4].annotations;

        // Same set, reversed order + a duplicate — equal under annotationSetsEqual.
        const reimported: Annotation[] = [
            { brush: 'R', orig: 'd2', dest: 'd4' },
            { brush: 'G', orig: 'g1', dest: 'f3' },
            { brush: 'G', orig: 'g1', dest: 'f3' },
        ];
        const result = m.applyImportedPgn(
            'white',
            [],
            new Map([[afterE4, reimported]]),
        );

        expect(result.replacedAnnotations).toBe(0);
        // Stored annotations untouched — same reference, no needless re-clone.
        expect(m.getCurrentRepertoire('white').positions[afterE4].annotations).toBe(storedBefore);
        expect(m.isEmpty()).toBe(true);
    });

    it('only mutates the supplied orientation', () => {
        // Both orientations have 1.e4 in base. Import only into 'white' —
        // the 'black' repertoire (and any FSRS cards minted on its behalf)
        // must remain byte-identical to the base snapshot.
        const { repertoires, fsrsCards } = buildRepertoires([
            { pgn: '1. e4', orientation: 'white' },
            { pgn: '1. e4', orientation: 'black' },
        ]);
        const m = new PendingEditModel(repertoires, fsrsCards);
        const blackBefore = JSON.stringify(findRepertoire(m.baseRepertoires, 'black')!);

        const afterE4 = fenAfter(['e4']);
        m.applyImportedPgn(
            'white',
            [{ from: afterE4, san: 'e5' }], // new opponent edge in white only
            new Map([[startFen, [{ brush: 'G', orig: 'e2', dest: 'e4' }]]]),
        );

        // Black working copy is unchanged vs. base.
        const blackAfter = JSON.stringify(m.getCurrentRepertoire('black'));
        expect(blackAfter).toBe(blackBefore);
        // White did change.
        expect(m.getCurrentRepertoire('white').positions[afterE4].moves['e5']).toBeDefined();
        expect(m.getCurrentRepertoire('white').positions[startFen].annotations).toHaveLength(1);
    });
});

describe('PendingEditModel snapshot immutability', () => {
    it('mutations on the working copy do not leak into the base snapshot', () => {
        const { repertoires, fsrsCards } = buildRepertoires([
            { pgn: '1. e4 c5', orientation: 'white' },
        ]);
        const m = new PendingEditModel(repertoires, fsrsCards);
        const baseRep = findRepertoire(m.baseRepertoires, 'white')!;
        const baseE4Moves = Object.keys(baseRep.positions[startFen].moves);
        expect(baseE4Moves).toEqual(['e4']);

        // Delete on the working copy.
        m.deleteEdge(startFen, 'e4', 'white');

        // Base is unchanged.
        const baseAfter = findRepertoire(m.baseRepertoires, 'white')!;
        expect(Object.keys(baseAfter.positions[startFen].moves)).toEqual(['e4']);
    });
});
