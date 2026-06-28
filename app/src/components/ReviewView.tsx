import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import ChessboardControl from './ChessboardControl';
import AnimatedAddedLine from './AnimatedAddedLine';
import { PendingDelta, EditChain, AnnotationDiff, EditedEdge, Orientation } from '../services/PendingEditModel';
import { isSingleAddedLine, buildAddedLineFrames, AddedLineFrames } from '../utils/ReviewAnimation';
import { Annotation } from '../models/Annotation';

/**
 * "Open in Explorer" deep-link for a reviewed position. Reuses the same
 * `?o=&fen=` query contract the Explorer reads from the URL. Because the
 * Review view is itself rendered inside `/explorer`, this stays on the same
 * route — the SPA nav gate permits same-route Explorer navigation and the
 * pending delta survives — and dropping `?review=1` returns the user to the
 * main Edit view focused on the linked position.
 */
const OpenInExplorerLink: React.FC<{ fen: string; orientation: Orientation }> = ({ fen, orientation }) => (
    <Link
        className="explorer-review-open-link"
        to={{ pathname: '/explorer', search: `?o=${orientation}&fen=${encodeURIComponent(fen)}` }}
        title="Open this position in Explorer"
    >
        Open in Explorer ↗
    </Link>
);

interface ReviewViewProps {
    delta: PendingDelta;
    rootFen: string;
    onCancel: () => void;
    onSave: () => void | Promise<void>;
    onDiscard: () => void;
    saveInFlight: boolean;
    /**
     * True when the Review pane was reached via the /games "Add to repertoire"
     * deep-link. In that flow Cancel keeps the user in the Explorer Edit view
     * (it does not return to /games — that's Discard's job), so the back
     * control is relabelled to "Continue editing" to match.
     */
    fromGames?: boolean;
}

/**
 * Full-page Review surface that the user reaches from the sticky save bar.
 * Three lists (Added / Removed / Edited) with chain collapsing for the
 * structural changes and side-by-side annotation comparison for the
 * annotation changes. Cancel returns to the Edit main view with the delta
 * intact; Save commits and clears the delta; Discard prompts confirmation
 * (handled by the parent).
 */
const ReviewView: React.FC<ReviewViewProps> = ({ delta, rootFen, onCancel, onSave, onDiscard, saveInFlight, fromGames }) => {
    const totalCount = delta.counts.added + delta.counts.removed + delta.counts.changed;
    const empty = totalCount === 0;

    // The common "added a single line" case (one added chain, nothing removed
    // or edited) gets a friendlier animated big-board preview instead of the
    // collapsible chain tile. Falls back to the standard layout if the line's
    // frames can't be reconstructed.
    const singleLine = isSingleAddedLine(delta);
    const animFrames = useMemo(
        () => (singleLine ? buildAddedLineFrames(delta.addedChains[0]) : null),
        [singleLine, delta],
    );
    const useAnimated = singleLine && animFrames !== null;

    return (
        <div className="explorer-review">
            <div className="explorer-review-header">
                <button
                    type="button"
                    className="explorer-btn explorer-btn--xs explorer-btn--neutral-ghost"
                    onClick={onCancel}
                    aria-label={fromGames
                        ? 'Return to Explorer to continue editing'
                        : 'Cancel review and return to Edit'}
                >
                    {fromGames ? '← Continue editing' : '← Back to edit'}
                </button>
                <div className="explorer-review-counts">
                    Review pending edits:&nbsp;
                    {delta.counts.added > 0 && <span>{delta.counts.added} added</span>}
                    {delta.counts.added > 0 && (delta.counts.removed > 0 || delta.counts.changed > 0) && ' · '}
                    {delta.counts.removed > 0 && <span>{delta.counts.removed} removed</span>}
                    {delta.counts.removed > 0 && delta.counts.changed > 0 && ' · '}
                    {delta.counts.changed > 0 && <span>{delta.counts.changed} changed</span>}
                </div>
                <div className="explorer-review-actions">
                    <button
                        type="button"
                        className="explorer-btn explorer-btn--danger-ghost"
                        onClick={onDiscard}
                        disabled={saveInFlight || empty}
                    >
                        Discard
                    </button>
                    <button
                        type="button"
                        className="explorer-btn explorer-btn--primary"
                        onClick={() => void onSave()}
                        disabled={saveInFlight || empty}
                    >
                        {saveInFlight ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>

            {empty && (
                <div className="explorer-review-empty">
                    No pending edits to review.
                </div>
            )}

            {!empty && useAnimated && (
                <AddedLineAnimatedSection chain={delta.addedChains[0]} frames={animFrames!} />
            )}

            {!empty && !useAnimated && delta.addedChains.length > 0 && (
                <section className="explorer-review-section">
                    <h2 className="explorer-review-section-title">Added ({delta.counts.added})</h2>
                    <ul className="explorer-review-list">
                        {delta.addedChains.map((chain, i) => (
                            <li key={`a-${i}`}>
                                <ChainRow chain={chain} side="added" />
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {!empty && !useAnimated && delta.removedChains.length > 0 && (
                <section className="explorer-review-section">
                    <h2 className="explorer-review-section-title">Removed ({delta.counts.removed})</h2>
                    <ul className="explorer-review-list">
                        {delta.removedChains.map((chain, i) => (
                            <li key={`r-${i}`}>
                                <ChainRow chain={chain} side="removed" />
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {!empty && !useAnimated && delta.editedAnnotations.length > 0 && (
                <section className="explorer-review-section">
                    <h2 className="explorer-review-section-title">Edited ({delta.counts.changed})</h2>
                    <ul className="explorer-review-list">
                        {delta.editedAnnotations.map((diff, i) => (
                            <li key={`e-${i}`}>
                                <AnnotationDiffRow diff={diff} rootFen={rootFen} />
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
};

export default ReviewView;

// ── Single added-line animated view ──────────────────────────────────

/**
 * The optimized layout for "added exactly one line": a looping big animated
 * board and a collapsed "See details" disclosure that reveals the same
 * per-position rows used by the standard chain tail. No title, caption, or
 * controls — the animation is the whole story.
 */
const AddedLineAnimatedSection: React.FC<{
    chain: EditChain;
    frames: AddedLineFrames;
}> = ({ chain, frames }) => (
    <section className="explorer-review-section explorer-review-anim-section">
        <AnimatedAddedLine chain={chain} frames={frames} />
        <AddedLineDetails chain={chain} />
    </section>
);

/**
 * Collapsed-by-default disclosure listing every added position (head + tail)
 * as a flat plain list. Reuses `TailEdgeRow` so the rows behave exactly like
 * the existing expanded-chain rows.
 */
const AddedLineDetails: React.FC<{ chain: EditChain }> = ({ chain }) => {
    const [open, setOpen] = useState(false);
    const parentSans = chain.parentPgn ? sansFromPgn(chain.parentPgn) : [];
    const edges = [chain.head, ...chain.tail];
    return (
        <div className="explorer-review-anim-details">
            <button
                type="button"
                className="explorer-review-chain-expand"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                aria-controls={open ? 'explorer-review-anim-detail-list' : undefined}
            >
                {open ? 'Hide details' : `See details (${edges.length} position${edges.length === 1 ? '' : 's'})`}
            </button>
            {open && (
                <ul id="explorer-review-anim-detail-list" className="explorer-review-list explorer-review-anim-detail-list">
                    {edges.map((edge, i) => (
                        <li key={i}>
                            <TailEdgeRow
                                parentSans={[...parentSans, ...edges.slice(0, i).map(e => e.san)]}
                                edge={edge}
                                side="added"
                            />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

// ── Chain row ─────────────────────────────────────────────────────────

interface ChainRowProps {
    chain: EditChain;
    side: 'added' | 'removed';
}

const ChainRow: React.FC<ChainRowProps> = ({ chain, side }) => {
    const [expanded, setExpanded] = useState(false);
    const length = 1 + chain.tail.length;
    const isLong = length >= 2;

    const parentSans = chain.parentPgn ? sansFromPgn(chain.parentPgn) : [];
    const headPgn = pgnFromSans([...parentSans, chain.head.san]);

    return (
        <div className={`explorer-review-chain explorer-review-chain-${side}`}>
            <div className="explorer-review-chain-head">
                <ChainBoard
                    parentPgn={chain.parentPgn}
                    headEdge={chain.head}
                    side={side}
                />
                <div className="explorer-review-chain-body">
                    <div className="explorer-review-chain-orientation">
                        {chain.orientation === 'white' ? 'White' : 'Black'} repertoire
                    </div>
                    <div className="explorer-review-chain-pgn">{headPgn || '(start)'}</div>
                    <div className="explorer-review-chain-fen">FEN: <code>{chain.head.to}</code></div>
                    {side === 'added' && (
                        <OpenInExplorerLink fen={chain.head.to} orientation={chain.orientation} />
                    )}
                    {chain.tailHint && (
                        <div className="explorer-review-chain-hint">
                            {chain.tailHint.kind === 'joins-existing' && (
                                <>
                                    ↪ joins existing subtree — {chain.tailHint.movesBelow}{' '}
                                    move{chain.tailHint.movesBelow === 1 ? '' : 's'} below.
                                </>
                            )}
                            {chain.tailHint.kind === 'survives-via' && (
                                <>
                                    ↪ stopped at a surviving position — still reachable via{' '}
                                    <code>{chain.tailHint.viaPgn}</code>.
                                </>
                            )}
                        </div>
                    )}
                    {isLong && (
                        <button
                            type="button"
                            className="explorer-review-chain-expand"
                            onClick={() => setExpanded(v => !v)}
                            aria-expanded={expanded}
                        >
                            {expanded ? 'Collapse' : `+${chain.tail.length} more`}
                        </button>
                    )}
                </div>
            </div>

            {expanded && chain.tail.length > 0 && (
                <ul className="explorer-review-chain-tail">
                    {chain.tail.map((edge, i) => (
                        <li key={i}>
                            <TailEdgeRow
                                parentSans={runningSans(chain, i)}
                                edge={edge}
                                side={side}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

/** Reconstruct the parent path (as SAN list) for the i-th tail edge. */
function runningSans(chain: EditChain, tailIdx: number): string[] {
    // The parent path for tail edge at index `tailIdx`:
    //   parentPgn-as-sans + head.san + tail[0..tailIdx-1].san
    const parentSans = chain.parentPgn ? sansFromPgn(chain.parentPgn) : [];
    const prefix = [chain.head.san, ...chain.tail.slice(0, tailIdx).map(e => e.san)];
    return [...parentSans, ...prefix];
}

function sansFromPgn(pgn: string): string[] {
    try {
        const chess = new Chess();
        chess.loadPgn(pgn);
        return chess.history();
    } catch {
        return [];
    }
}

// ── Small "parent board + arrow" preview ─────────────────────────────

interface ChainBoardProps {
    parentPgn: string;
    headEdge: EditedEdge;
    side: 'added' | 'removed';
}

const ChainBoard: React.FC<ChainBoardProps> = ({ parentPgn, headEdge, side }) => {
    // Compute the parent FEN by replaying parentPgn.
    let parentFen = headEdge.from;
    try {
        if (parentPgn) {
            const chess = new Chess();
            chess.loadPgn(parentPgn);
            parentFen = chess.fen();
        }
    } catch {
        // Fall back to the edge's `from` FEN.
    }
    // Derive the arrow squares (from, to) by replaying the SAN on the parent.
    let arrow: Annotation | null = null;
    try {
        const chess = new Chess(parentFen);
        const move = chess.move(headEdge.san);
        if (move) {
            arrow = {
                brush: side === 'added' ? 'G' : 'R',
                orig: move.from,
                dest: move.to,
            };
        }
    } catch {
        /* leave arrow null */
    }

    return (
        <div className="explorer-review-mini-board">
            <ChessboardControl
                roundId={`review-${side}-${parentFen}-${headEdge.san}`}
                fen={parentFen}
                orientation={headEdge.orientation}
                movePlayed={() => false}
                annotations={arrow ? [arrow] : []}
                interactive={false}
            />
        </div>
    );
};

// ── Tail-edge row (rendered inside an expanded chain) ────────────────

interface TailEdgeRowProps {
    parentSans: string[];
    edge: EditedEdge;
    side: 'added' | 'removed';
}

const TailEdgeRow: React.FC<TailEdgeRowProps> = ({ parentSans, edge, side }) => {
    const parentPgn = pgnFromSans(parentSans);
    const fullPgn = pgnFromSans([...parentSans, edge.san]);
    const pgnLabel = fullPgn || [...parentSans, edge.san].join(' ');
    return (
        <div className="explorer-review-chain-head">
            <ChainBoard parentPgn={parentPgn} headEdge={edge} side={side} />
            <div className="explorer-review-chain-body">
                <div className="explorer-review-chain-pgn">{pgnLabel}</div>
                <div className="explorer-review-chain-fen">FEN: <code>{edge.to}</code></div>
                {side === 'added' && (
                    <OpenInExplorerLink fen={edge.to} orientation={edge.orientation} />
                )}
            </div>
        </div>
    );
};

function pgnFromSans(sans: string[]): string {
    if (sans.length === 0) return '';
    const chess = new Chess();
    for (const s of sans) {
        try { chess.move(s); } catch { return ''; }
    }
    return chess.pgn();
}

// ── Annotation diff row ──────────────────────────────────────────────

interface AnnotationDiffRowProps {
    diff: AnnotationDiff;
    rootFen: string;
}

const AnnotationDiffRow: React.FC<AnnotationDiffRowProps> = ({ diff, rootFen }) => {
    // Recover the position FEN by replaying the PGN; this also matches the
    // canonical labels we show.
    let positionFen = diff.fen;
    try {
        if (diff.pgn) {
            const chess = new Chess();
            chess.loadPgn(diff.pgn);
            positionFen = chess.fen();
        } else {
            positionFen = rootFen;
        }
    } catch {
        positionFen = diff.fen;
    }

    return (
        <div className="explorer-review-edit">
            <div className="explorer-review-edit-meta">
                <div className="explorer-review-chain-orientation">
                    {diff.orientation === 'white' ? 'White' : 'Black'} repertoire
                </div>
                <div className="explorer-review-chain-pgn">{diff.pgn || '(start)'}</div>
                <div className="explorer-review-chain-fen">FEN: <code>{diff.fen}</code></div>
                <OpenInExplorerLink fen={diff.fen} orientation={diff.orientation} />
            </div>
            <div className="explorer-review-edit-boards">
                <div className="explorer-review-edit-side">
                    <div className="explorer-review-edit-side-label">Saved</div>
                    <div className="explorer-review-mini-board">
                        <ChessboardControl
                            roundId={`review-anns-saved-${diff.fen}`}
                            fen={positionFen}
                            orientation={diff.orientation}
                            movePlayed={() => false}
                            annotations={diff.before}
                            interactive={false}
                        />
                    </div>
                </div>
                <div className="explorer-review-edit-side">
                    <div className="explorer-review-edit-side-label">Staged</div>
                    <div className="explorer-review-mini-board">
                        <ChessboardControl
                            roundId={`review-anns-staged-${diff.fen}`}
                            fen={positionFen}
                            orientation={diff.orientation}
                            movePlayed={() => false}
                            annotations={diff.after}
                            interactive={false}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};
