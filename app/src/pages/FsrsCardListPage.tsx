import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { State, Rating } from 'ts-fsrs';
import { getSessionStore } from '../data/SessionStore';
import { DataAccessError } from '../data/DataAccessLayer';
import { RepertoireData } from '../models/RepertoireData';
import { FSRSCardData } from '../models/FSRSCardData';
import { AuditEntry, AuditEvent, AUDIT_MAX_ENTRIES } from '../models/AuditData';
import { FSRSService } from '../services/FSRSService';
import { AuditService } from '../services/AuditService';
import { ExplorerService, Orientation } from '../services/ExplorerService';
import { unpackCardForAudit } from '../utils/BlobCodec';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import { formatDueRelative, formatLastReviewed } from '../utils/ExplorerRelativeTime';
import './FsrsCardListPage.css';

// ── Types ─────────────────────────────────────────────────────────────

type StateLabel = 'New' | 'Learning' | 'Review' | 'Relearning';

interface CardRow {
    key: string;
    fen: string;
    san: string;
    repertoire: Orientation;
    card: FSRSCardData;
    stateLabel: StateLabel;
    dueAt?: Date;
    retrievability?: number;
    intervalDays?: number;
    lastReviewedAt?: Date;
    tracked: boolean;
    trackedEntry?: AuditEntry;
}

type SortField =
    | 'due'
    | 'retrievability'
    | 'stability'
    | 'difficulty'
    | 'reps'
    | 'lapses'
    | 'lastReviewed'
    | 'state';

type SortDir = 'asc' | 'desc';

const SORT_OPTIONS: { value: SortField; label: string }[] = [
    { value: 'due', label: 'Due' },
    { value: 'retrievability', label: 'Retrievability' },
    { value: 'stability', label: 'Stability' },
    { value: 'difficulty', label: 'Difficulty' },
    { value: 'reps', label: 'Reps' },
    { value: 'lapses', label: 'Lapses' },
    { value: 'lastReviewed', label: 'Last reviewed' },
    { value: 'state', label: 'State' },
];

const STATE_LABELS: Record<number, StateLabel> = {
    [State.New]: 'New',
    [State.Learning]: 'Learning',
    [State.Review]: 'Review',
    [State.Relearning]: 'Relearning',
};

// ── Helpers ───────────────────────────────────────────────────────────

function repertoireForFen(fen: string): Orientation {
    const active = fen.split(' ')[1] ?? 'w';
    return active === 'b' ? 'black' : 'white';
}

function formatAbsolute(d: Date): string {
    return d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/**
 * Per-field comparable value. `undefined` always sorts last regardless of
 * direction. New cards lack due / retrievability / stability / difficulty /
 * reps / lapses / last-review values for sorting, so they fall to the bottom
 * on every field except `state` (where ordering New by its state number is the
 * point of an explicit State sort).
 */
function sortValue(row: CardRow, field: SortField): number | undefined {
    const isNew = row.card.state === State.New;
    switch (field) {
        case 'due': return row.dueAt?.getTime();
        case 'retrievability': return row.retrievability;
        case 'stability': return isNew ? undefined : row.card.stability;
        case 'difficulty': return isNew ? undefined : row.card.difficulty;
        case 'reps': return isNew ? undefined : row.card.reps;
        case 'lapses': return isNew ? undefined : row.card.lapses;
        case 'lastReviewed': return row.lastReviewedAt?.getTime();
        case 'state': return row.card.state;
    }
}

function compareRows(a: CardRow, b: CardRow, field: SortField, dir: SortDir): number {
    const va = sortValue(a, field);
    const vb = sortValue(b, field);
    // Undefined always last (stable across asc/desc).
    if (va === undefined && vb === undefined) return tieBreak(a, b);
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    if (va !== vb) return dir === 'asc' ? va - vb : vb - va;
    return tieBreak(a, b);
}

function tieBreak(a: CardRow, b: CardRow): number {
    if (a.fen !== b.fen) return a.fen < b.fen ? -1 : 1;
    return a.san < b.san ? -1 : a.san > b.san ? 1 : 0;
}

function ratingLabel(r: number): string {
    if (r === Rating.Again) return 'Again';
    if (r === Rating.Good) return 'Good';
    return `r${r}`;
}

// ── Tracked-event log ─────────────────────────────────────────────────

/**
 * Decode the packed `before` snapshot for a one-line baseline summary. The
 * blob is the source of truth for deeper offline analysis; here we surface a
 * compact "tracked from" line so the captured trajectory has a reference
 * point. Tolerant of a malformed snapshot (returns null).
 */
function describeSnapshot(entry: AuditEntry): string | null {
    try {
        const c = unpackCardForAudit(entry.before);
        const label = STATE_LABELS[c.state] ?? 'New';
        return `${label} · S ${c.stability.toFixed(2)} · D ${c.difficulty.toFixed(2)}`;
    } catch {
        return null;
    }
}

const TrackLog: React.FC<{ entry: AuditEntry; now: Date }> = ({ entry, now }) => {
    const events: AuditEvent[] = Array.isArray(entry.events) ? entry.events : [];
    // Display strictly by timestamp — ingest can append events out of date
    // order (games are stamped with their played time), so insertion order
    // isn't always chronological. Sort a copy to leave the blob untouched.
    const ordered = [...events].sort((a, b) => a.ts - b.ts);
    const snapshot = describeSnapshot(entry);
    return (
        <div className="fsrs-tracklog">
            <div className="fsrs-tracklog-title">
                Tracked · {events.length === 0
                    ? 'no events yet'
                    : `${events.length} event${events.length === 1 ? '' : 's'}`}
            </div>
            {snapshot && (
                <div className="fsrs-tracklog-baseline">tracked from {snapshot}</div>
            )}
            {ordered.length > 0 && (
                <ol className="fsrs-tracklog-events">
                    {ordered.map((e, i) => (
                        <li key={i} className={`fsrs-event fsrs-event--${ratingLabel(e.r).toLowerCase()}`}>
                            <span className="fsrs-event-rating">{ratingLabel(e.r)}</span>
                            <span className="fsrs-event-when">{formatLastReviewed(new Date(e.ts), now)}</span>
                            <span className="fsrs-event-source">{e.s}</span>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
};

// ── Per-card overflow menu ────────────────────────────────────────────

const CardMenu: React.FC<{
    row: CardRow;
    full: boolean;
    busy: boolean;
    onTrack: (row: CardRow) => void;
    onUntrack: (row: CardRow) => void;
}> = ({ row, full, busy, onTrack, onUntrack }) => {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const onDocDown = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDocDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const isNew = row.card.state === State.New;
    const trackDisabled = isNew || (!row.tracked && full) || busy;
    const trackDisabledReason = isNew
        ? 'New cards have no FSRS snapshot yet — rate it at least once first.'
        : (!row.tracked && full)
            ? `Tracking is full (${AUDIT_MAX_ENTRIES}). Untrack a card to free a slot.`
            : undefined;

    return (
        <div className="fsrs-menu-wrap" ref={wrapRef}>
            <button
                type="button"
                className="fsrs-menu-trigger"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Card actions"
                title="Card actions"
                onClick={() => setOpen(o => !o)}
            >
                ⋯
            </button>
            {open && (
                <div className="fsrs-menu" role="menu">
                    {row.tracked ? (
                        <button
                            type="button"
                            role="menuitem"
                            className="fsrs-menu-item"
                            disabled={busy}
                            onClick={() => { setOpen(false); onUntrack(row); }}
                        >
                            Untrack
                            <span className="fsrs-menu-item-hint">Remove audit capture</span>
                        </button>
                    ) : (
                        <button
                            type="button"
                            role="menuitem"
                            className="fsrs-menu-item"
                            disabled={trackDisabled}
                            title={trackDisabledReason}
                            onClick={() => { setOpen(false); onTrack(row); }}
                        >
                            Track
                            <span className="fsrs-menu-item-hint">
                                {trackDisabledReason ?? 'Capture this card’s trajectory'}
                            </span>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

// ── Card block ────────────────────────────────────────────────────────

const Detail: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
    <div className="fsrs-detail">
        <dt>{label}</dt>
        <dd>{value}</dd>
    </div>
);

const CardBlock: React.FC<{
    row: CardRow;
    now: Date;
    full: boolean;
    busy: boolean;
    onTrack: (row: CardRow) => void;
    onUntrack: (row: CardRow) => void;
}> = ({ row, now, full, busy, onTrack, onUntrack }) => {
    const isNew = row.card.state === State.New;
    const explorerSearch = `?o=${row.repertoire}&fen=${encodeURIComponent(row.fen)}`;

    return (
        <li className="fsrs-block">
            <div className="fsrs-block-head">
                <span className={`fsrs-pill fsrs-rep fsrs-rep--${row.repertoire}`}>
                    {row.repertoire === 'white' ? 'White' : 'Black'}
                </span>
                <span className={`fsrs-pill fsrs-state state-${row.stateLabel.toLowerCase()}`}>
                    {row.stateLabel}
                </span>
                <span className="fsrs-move" title="Move (SAN)">{row.san}</span>
                {row.tracked && <span className="fsrs-tracked-badge" title="Tracked">●&nbsp;tracked</span>}
                <div className="fsrs-block-actions">
                    <Link
                        className="fsrs-open-link"
                        to={{ pathname: '/explorer', search: explorerSearch }}
                    >
                        Open in Explorer ↗
                    </Link>
                    <CardMenu
                        row={row}
                        full={full}
                        busy={busy}
                        onTrack={onTrack}
                        onUntrack={onUntrack}
                    />
                </div>
            </div>

            <div className="fsrs-fen" title="Normalized FEN">{row.fen}</div>

            {isNew ? (
                <p className="fsrs-new-note">Not yet reviewed — no scheduling data.</p>
            ) : (
                <dl className="fsrs-details">
                    {row.dueAt && (
                        <Detail
                            label="Due"
                            value={<>
                                <span className="fsrs-rel">{formatDueRelative(row.dueAt, now)}</span>
                                <span className="fsrs-abs">{formatAbsolute(row.dueAt)}</span>
                            </>}
                        />
                    )}
                    {row.retrievability !== undefined && (
                        <Detail label="Retrievability" value={`${(row.retrievability * 100).toFixed(1)}%`} />
                    )}
                    <Detail label="Stability" value={`${row.card.stability.toFixed(2)}d`} />
                    <Detail label="Difficulty" value={row.card.difficulty.toFixed(2)} />
                    {row.intervalDays !== undefined && (
                        <Detail label="Interval" value={`${row.intervalDays}d`} />
                    )}
                    <Detail label="Reps" value={row.card.reps} />
                    <Detail label="Lapses" value={row.card.lapses} />
                    {row.lastReviewedAt && (
                        <Detail
                            label="Last reviewed"
                            value={<>
                                <span className="fsrs-rel">{formatLastReviewed(row.lastReviewedAt, now)}</span>
                                <span className="fsrs-abs">{formatAbsolute(row.lastReviewedAt)}</span>
                            </>}
                        />
                    )}
                </dl>
            )}

            {row.tracked && row.trackedEntry && <TrackLog entry={row.trackedEntry} now={now} />}
        </li>
    );
};

// ── Orphaned tracked entry (card removed from repertoire) ─────────────

const OrphanBlock: React.FC<{
    entry: AuditEntry;
    now: Date;
    busy: boolean;
    onUntrack: (key: string) => void;
}> = ({ entry, now, busy, onUntrack }) => {
    const { fen, san } = FSRSService.parseCardKey(entry.k);
    const repertoire = repertoireForFen(fen);
    return (
        <li className="fsrs-block fsrs-block--orphan">
            <div className="fsrs-block-head">
                <span className={`fsrs-pill fsrs-rep fsrs-rep--${repertoire}`}>
                    {repertoire === 'white' ? 'White' : 'Black'}
                </span>
                <span className="fsrs-pill state-orphan">Removed</span>
                <span className="fsrs-move" title="Move (SAN)">{san}</span>
                <div className="fsrs-block-actions">
                    <button
                        type="button"
                        className="fsrs-btn fsrs-btn--ghost"
                        disabled={busy}
                        onClick={() => onUntrack(entry.k)}
                    >
                        Untrack
                    </button>
                </div>
            </div>
            <div className="fsrs-fen" title="Normalized FEN">{fen}</div>
            <p className="fsrs-new-note">
                This position is no longer in your repertoire — untrack to free a slot.
            </p>
            <TrackLog entry={entry} now={now} />
        </li>
    );
};

// ── Page ──────────────────────────────────────────────────────────────

const FsrsCardListPage: React.FC = () => {
    const [data, setData] = useState<RepertoireData | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);

    const [findInput, setFindInput] = useState('');
    const [findError, setFindError] = useState<string | null>(null);
    const [filterFen, setFilterFen] = useState<string | null>(null);

    const [sortField, setSortField] = useState<SortField>('due');
    const [sortDir, setSortDir] = useState<SortDir>('asc');

    const [busyKey, setBusyKey] = useState<string | null>(null);

    // A single clock for the whole page so relative times are consistent and
    // refresh periodically without re-fetching the blob.
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const id = window.setInterval(() => setNow(new Date()), 60_000);
        return () => window.clearInterval(id);
    }, []);

    const dal = useMemo(() => getSessionStore().createDataAccessProxyLayer(), []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                setLoading(true);
                const d = await dal.retrieveRepertoireData();
                if (cancelled) return;
                setData(d);
                setLoadError(null);
            } catch (e: unknown) {
                if (cancelled) return;
                setLoadError(e instanceof Error ? e.message : String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [dal]);

    // FSRSService + ExplorerService over the loaded blob. Rebuilt whenever the
    // blob reference changes (Track/Untrack swaps in a new object).
    const fsrs = useMemo(
        () => (data ? new FSRSService(data.fsrsCards ?? {}) : null),
        [data],
    );
    const explorer = useMemo(
        () => (data ? new ExplorerService(data, []) : null),
        [data],
    );

    const auditByKey = useMemo(() => {
        const m = new Map<string, AuditEntry>();
        for (const e of data?.audit ?? []) {
            if (e && typeof e.k === 'string' && !m.has(e.k)) m.set(e.k, e);
        }
        return m;
    }, [data]);

    const trackedCount = data?.audit?.length ?? 0;
    const full = trackedCount >= AUDIT_MAX_ENTRIES;

    // Tracked audit entries whose card no longer exists in the repertoire
    // (e.g. the move was deleted in the Explorer). They still occupy a
    // tracking slot, so the spec requires the user be able to Untrack them —
    // otherwise the cap could lock Track out permanently. Surfaced in their
    // own section below the main list.
    const orphanEntries = useMemo(() => {
        const cards = data?.fsrsCards ?? {};
        const seen = new Set<string>();
        const out: AuditEntry[] = [];
        for (const e of data?.audit ?? []) {
            if (!e || typeof e.k !== 'string') continue;
            if (cards[e.k]) continue;
            if (seen.has(e.k)) continue;
            seen.add(e.k);
            out.push(e);
        }
        return out;
    }, [data]);

    const rows = useMemo<CardRow[]>(() => {
        if (!data || !fsrs) return [];
        const out: CardRow[] = [];
        for (const [key, card] of Object.entries(data.fsrsCards ?? {})) {
            const { fen, san } = FSRSService.parseCardKey(key);
            const stateLabel = STATE_LABELS[card.state] ?? 'New';
            const isNew = card.state === State.New;
            const dueAt = isNew ? undefined : FSRSService.computeDueDate(card);
            const interval = FSRSService.computeInterval(card);
            const retr = fsrs.getDisplayRetrievabilityByKey(key, now);
            const trackedEntry = auditByKey.get(key);
            out.push({
                key,
                fen,
                san,
                repertoire: repertoireForFen(fen),
                card,
                stateLabel,
                dueAt,
                retrievability: retr ?? undefined,
                intervalDays: interval ?? undefined,
                lastReviewedAt: card.lastReview ? new Date(card.lastReview) : undefined,
                tracked: !!trackedEntry,
                trackedEntry,
            });
        }
        return out;
        // `now` intentionally omitted: retrievability/due drift slowly and we
        // don't want to rebuild the whole list every clock tick. The minute
        // tick still refreshes rendered relative-time strings.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, fsrs, auditByKey]);

    const summary = useMemo(() => {
        let n = 0, learning = 0, due = 0;
        for (const r of rows) {
            if (r.card.state === State.New) { n++; continue; }
            if (r.card.state === State.Learning || r.card.state === State.Relearning) learning++;
            if (r.dueAt && r.dueAt.getTime() <= now.getTime()) due++;
        }
        return { n, learning, due };
    }, [rows, now]);

    const visibleRows = useMemo(() => {
        const filtered = filterFen ? rows.filter(r => r.fen === filterFen) : rows;
        return [...filtered].sort((a, b) => compareRows(a, b, sortField, sortDir));
    }, [rows, filterFen, sortField, sortDir]);

    const handleFind = useCallback((e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!explorer) return;
        const trimmed = findInput.trim();
        if (!trimmed) {
            setFilterFen(null);
            setFindError(null);
            return;
        }
        const result = explorer.findPosition(trimmed, 'white');
        if (!result) {
            setFilterFen(null);
            setFindError('No matching position found in either repertoire.');
            return;
        }
        // A resolved position can still carry no card — e.g. an opponent-turn
        // position (its side-to-move is the opponent's). Surface that plainly
        // instead of dropping the user into an empty filtered list.
        if (!rows.some(r => r.fen === result.fen)) {
            setFilterFen(null);
            setFindError('That position has no card — it may be the opponent’s move.');
            return;
        }
        setFilterFen(result.fen);
        setFindError(null);
    }, [explorer, findInput, rows]);

    const clearFilter = useCallback(() => {
        setFilterFen(null);
        setFindInput('');
        setFindError(null);
    }, []);

    // Track/Untrack: optimistic toggle on a cloned audit array, then persist.
    // Revert on any non-412 error (412 is owned by the global ConflictModal).
    const applyToggle = useCallback(async (
        key: string,
        beforeCard: FSRSCardData | undefined,
        wantTracked: boolean,
    ) => {
        if (!data || busyKey) return;
        setSaveError(null);

        const nextAudit: AuditEntry[] = data.audit ? [...data.audit] : [];
        const svc = new AuditService(nextAudit);
        const ok = wantTracked
            ? svc.track(key, beforeCard)
            : svc.untrack(key);
        if (!ok) {
            setSaveError(wantTracked
                ? 'Could not start tracking this card.'
                : 'Could not untrack this card.');
            return;
        }

        const prevData = data;
        const nextData: RepertoireData = { ...data, audit: nextAudit };
        setData(nextData);
        setBusyKey(key);
        try {
            const wire = RepertoireDataUtils.prepareDataForSave(nextData);
            await dal.storeRepertoireData(wire);
        } catch (err: unknown) {
            if (err instanceof DataAccessError && err.statusCode === 412) {
                // Global <ConflictModal> already fired; it owns recovery
                // (hard reload). Leave the optimistic state — the reload will
                // resync. Don't double-surface a page-local error.
            } else {
                setData(prevData);
                const msg = err instanceof Error ? err.message : String(err);
                setSaveError(`Save failed — ${msg}`);
            }
        } finally {
            setBusyKey(null);
        }
    }, [data, dal, busyKey]);

    const onTrack = useCallback((row: CardRow) => { void applyToggle(row.key, row.card, true); }, [applyToggle]);
    const onUntrack = useCallback((row: CardRow) => { void applyToggle(row.key, row.card, false); }, [applyToggle]);
    // Untrack by key only — used for orphaned entries whose card no longer
    // exists in the repertoire (so there's no CardRow to pass).
    const onUntrackKey = useCallback((key: string) => { void applyToggle(key, undefined, false); }, [applyToggle]);

    // ── Render ────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="fsrs-page">
                <div className="fsrs-card"><div className="fsrs-loading">Loading FSRS cards…</div></div>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="fsrs-page">
                <div className="fsrs-card"><div className="fsrs-error">Failed to load: {loadError}</div></div>
            </div>
        );
    }

    const totalCards = rows.length;

    return (
        <div className="fsrs-page">
            <div className="fsrs-card">
                <header className="fsrs-header">
                    <div className="fsrs-title-row">
                        <h1 className="fsrs-title">FSRS cards</h1>
                        <p className="fsrs-subtitle">
                            Diagnostic view of every scheduled card. Read-only except Track/Untrack.
                        </p>
                    </div>
                    <div className="fsrs-summary" role="group" aria-label="Card summary">
                        <span className="fsrs-summary-chip"><strong>{totalCards}</strong> total</span>
                        <span className="fsrs-summary-chip fsrs-chip-new" title="Cards in New state (never reviewed)"><strong>{summary.n}</strong> new</span>
                        <span className="fsrs-summary-chip fsrs-chip-learning" title="Cards in Learning or Relearning state"><strong>{summary.learning}</strong> learning</span>
                        <span className="fsrs-summary-chip fsrs-chip-due" title="Non-New cards whose due date has passed (overlaps learning)"><strong>{summary.due}</strong> due now</span>
                        <span className="fsrs-summary-chip fsrs-chip-tracked">
                            <strong>{trackedCount}</strong>/{AUDIT_MAX_ENTRIES} tracked
                        </span>
                    </div>
                </header>

                {saveError && (
                    <div className="fsrs-savebar" role="alert">
                        <span>{saveError}</span>
                        <button type="button" className="fsrs-savebar-dismiss" aria-label="Dismiss" onClick={() => setSaveError(null)}>×</button>
                    </div>
                )}

                {totalCards === 0 && orphanEntries.length === 0 ? (
                    <div className="fsrs-empty">
                        <p>No FSRS cards yet.</p>
                        <p className="fsrs-empty-hint">Add a repertoire in the Explorer to start scheduling cards.</p>
                    </div>
                ) : (
                    <>
                        {totalCards > 0 && (
                            <>
                                <div className="fsrs-controls">
                                    <form className="fsrs-find" onSubmit={handleFind}>
                                        <input
                                            type="text"
                                            className="fsrs-find-input"
                                            value={findInput}
                                            onChange={e => { setFindInput(e.target.value); if (findError) setFindError(null); }}
                                            placeholder="Find position — paste FEN or PGN…"
                                            aria-label="Find position by FEN or PGN"
                                        />
                                        <button type="submit" className="fsrs-btn fsrs-btn--primary">Find</button>
                                        {filterFen && (
                                            <button type="button" className="fsrs-btn fsrs-btn--ghost" onClick={clearFilter}>Clear</button>
                                        )}
                                    </form>

                                    <div className="fsrs-sort">
                                        <label htmlFor="fsrs-sort-field" className="fsrs-sort-label">Sort</label>
                                        <select
                                            id="fsrs-sort-field"
                                            className="fsrs-sort-select"
                                            value={sortField}
                                            onChange={e => setSortField(e.target.value as SortField)}
                                        >
                                            {SORT_OPTIONS.map(o => (
                                                <option key={o.value} value={o.value}>{o.label}</option>
                                            ))}
                                        </select>
                                        <button
                                            type="button"
                                            className="fsrs-sort-dir"
                                            onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
                                            aria-label={sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
                                            title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
                                        >
                                            {sortDir === 'asc' ? '↑' : '↓'}
                                        </button>
                                    </div>
                                </div>

                                {findError && <div className="fsrs-find-error" role="alert">{findError}</div>}
                                {filterFen && (
                                    <div className="fsrs-filter-note">
                                        Showing {visibleRows.length} card{visibleRows.length === 1 ? '' : 's'} at the filtered position.
                                    </div>
                                )}

                                {visibleRows.length === 0 ? (
                                    <div className="fsrs-empty"><p>No cards match the current filter.</p></div>
                                ) : (
                                    <ul className="fsrs-list">
                                        {visibleRows.map(row => (
                                            <CardBlock
                                                key={row.key}
                                                row={row}
                                                now={now}
                                                full={full}
                                                busy={busyKey !== null}
                                                onTrack={onTrack}
                                                onUntrack={onUntrack}
                                            />
                                        ))}
                                    </ul>
                                )}
                            </>
                        )}

                        {orphanEntries.length > 0 && (
                            <section className="fsrs-orphans" aria-label="Tracked positions no longer in repertoire">
                                <h2 className="fsrs-section-title">Tracked positions no longer in your repertoire</h2>
                                <ul className="fsrs-list">
                                    {orphanEntries.map(e => (
                                        <OrphanBlock
                                            key={e.k}
                                            entry={e}
                                            now={now}
                                            busy={busyKey !== null}
                                            onUntrack={onUntrackKey}
                                        />
                                    ))}
                                </ul>
                            </section>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default FsrsCardListPage;
