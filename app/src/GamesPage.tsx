import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChessBoard } from 'chess-control';
import type { Annotation as ChessControlAnnotation, Square } from 'chess-control';
import { createDataAccessLayer } from './DataAccessLayer';
import { getLinkedAccounts, LinkedAccount, advanceSyncWatermark, Platform } from './LinkedAccountsService';
import { getAllGames, groomGames, updateAnnotations, clearAnnotation, StoredGame } from './GamesDB';
import { syncGamesForUser, SyncProgress } from './LichessGamesService';
import { syncChesscomGamesForUser } from './ChesscomGamesService';
import { buildRepertoireFenSets, RepertoireFenSets } from './RepertoireFenSet';
import {
    annotateGame,
    GameAnnotation,
    GameMetadata,
    getGameMetadata,
    getUserColor,
    AnnotatedMove,
} from './GameAnnotationService';
import { getExplorerEvals, ExplorerEvals } from './ExplorerEvals';
import { EvalDropCategory } from './EvalDropService';
import { getMeasurePerf } from './PerfUtils';
import { useLichessAuth } from './LichessAuthContext';
import {
    MastersCache,
} from './MastersExplorerService';
import './GamesPage.css';

const END_OF_THEORY_CLASSES: Record<EvalDropCategory, string> = {
    ok: 'move-out-of-theory',
    inaccuracy: 'move-eot-inaccuracy',
    mistake: 'move-eot-mistake',
    blunder: 'move-eot-blunder',
};

const EOT_ICON_COLORS: Record<EvalDropCategory, string> = {
    ok: '#888',
    inaccuracy: '#b8860b',
    mistake: '#c0392b',
    blunder: '#7b3f9e',
};

function getMoveClassName(move: AnnotatedMove): string {
    if (!move.isUserMove) return 'move-token move-opponent';

    switch (move.highlight) {
        case 'in-repertoire':
            return 'move-token move-in-repertoire';
        case 'deviation':
            return 'move-token move-deviation';
        case 'out-of-repertoire-response': {
            const category = move.evalDrop?.category ?? 'ok';
            return `move-token ${END_OF_THEORY_CLASSES[category]}`;
        }
        case 'out-of-repertoire':
        case 'out-of-theory':
            return 'move-token move-out-of-theory';
    }
}

function formatPlayerLabel(name: string, rating: number | undefined, isUser: boolean): React.ReactNode {
    return (
        <span className={isUser ? 'player-user' : 'player-opponent'}>
            {name}
            {rating !== undefined && (
                <span className="player-rating"> ({rating})</span>
            )}
        </span>
    );
}

interface GameRowProps {
    game: StoredGame;
    annotation: GameAnnotation | null;
    username: string;
    onReannotate: (gameId: string) => void;
}

const GameRow: React.FC<GameRowProps> = ({ game, annotation, username, onReannotate }) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const platform = game.platform ?? 'lichess';
    const meta: GameMetadata = useMemo(
        () => getGameMetadata(game.data, username, platform),
        [game.data, username, platform]
    );

    const dateStr = useMemo(() => {
        const d = new Date(meta.createdAt);
        return d.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }, [meta.createdAt]);

    // Build board arrows from deviation info
    const boardAnnotations: ChessControlAnnotation[] = useMemo(() => {
        if (!annotation?.deviation) return [];
        const arrows: ChessControlAnnotation[] = [];
        for (const rm of annotation.deviation.repertoireMoves) {
            arrows.push({ color: 'green', from: rm.from as Square, to: rm.to as Square });
        }
        arrows.push({ color: 'red', from: annotation.deviation.userMove.from as Square, to: annotation.deviation.userMove.to as Square });
        return arrows;
    }, [annotation]);

    const boardFen = annotation?.miniBoardFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    // Find first end-of-theory eval drop for summary
    const eotSummary = useMemo(() => {
        if (!annotation) return null;
        const moves = annotation.moves;
        for (let i = 0; i < moves.length; i++) {
            if (moves[i].highlight === 'out-of-repertoire-response' && moves[i].evalDrop && moves[i].evalDrop!.category !== 'ok') {
                // Find the preceding opponent out-of-repertoire move
                let opponentMove: string | null = null;
                for (let j = i - 1; j >= 0; j--) {
                    if (!moves[j].isUserMove) {
                        opponentMove = moves[j].san;
                        break;
                    }
                }
                return {
                    userSan: moves[i].san,
                    opponentSan: opponentMove,
                    category: moves[i].evalDrop!.category,
                    drop: moves[i].evalDrop!.evalDrop,
                };
            }
        }
        return null;
    }, [annotation]);

    const resultLabel = meta.result.toUpperCase();
    const speedLabel = meta.speed ? meta.speed.charAt(0).toUpperCase() + meta.speed.slice(1) : '';

    const topRightParts: string[] = [resultLabel];
    if (meta.rated !== undefined) {
        topRightParts.push(meta.rated ? 'Rated' : 'Casual');
    }
    if (speedLabel) {
        topRightParts.push(speedLabel);
    }
    if (meta.timeControl) {
        topRightParts.push(meta.timeControl);
    }
    topRightParts.push(dateStr);

    const whiteIsUser = meta.userColor === 'white';
    const blackIsUser = meta.userColor === 'black';

    const hasDeviation = annotation?.deviation != null;
    const tileClass = hasDeviation ? ' game-row-deviation'
        : eotSummary ? ` game-row-eot-${eotSummary.category}`
        : '';

    // Close overflow menu on outside click
    useEffect(() => {
        if (!menuOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [menuOpen]);

    return (
        <div className={`game-row${tileClass}`}>
            {/* Mini board */}
            <div className="game-mini-board">
                <ChessBoard
                    fen={boardFen}
                    orientation={annotation?.miniBoardOrientation ?? meta.userColor ?? 'white'}
                    interactive={false}
                    coordinates={false}
                    turnColor="white"
                    legalMoves={new Map()}
                    annotations={boardAnnotations}
                />
            </div>

            {/* Game info */}
            <div className="game-info">
                <div className="game-header-row">
                    <div className="game-players">
                        {formatPlayerLabel(meta.whiteName, meta.whiteRating, whiteIsUser)}
                        <span className="game-vs"> vs </span>
                        {formatPlayerLabel(meta.blackName, meta.blackRating, blackIsUser)}
                    </div>
                    <div className="game-right-column">
                        <span className="game-meta-right">
                            {topRightParts.join(' | ')}
                        </span>
                        <span className="game-source-row">
                            <a
                                className="game-source-link"
                                href={meta.gameUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {platform === 'chess.com' ? '♔ View on Chess.com' : '♞ View on Lichess'}
                            </a>
                            <div className="game-overflow-menu" ref={menuRef}>
                                <button
                                    className="game-overflow-button"
                                    onClick={() => setMenuOpen(prev => !prev)}
                                    aria-label="Game options"
                                >⋯</button>
                                {menuOpen && (
                                    <div className="game-overflow-dropdown">
                                        <button onClick={() => { setMenuOpen(false); onReannotate(game.id); }}>
                                            Re-annotate
                                        </button>
                                    </div>
                                )}
                            </div>
                        </span>
                    </div>
                </div>

                <div className="game-details-row">
                    {meta.openingName && (
                        <span className="game-opening">{meta.openingName}</span>
                    )}
                </div>

                {/* Annotated PGN */}
                {annotation && annotation.moves.length > 0 && (
                    <div className="game-pgn">
                        {annotation.moves.map((move, idx) => (
                            <React.Fragment key={idx}>
                                {move.moveNumber !== undefined && (
                                    <span className="move-number">{move.moveNumber}.&nbsp;</span>
                                )}
                                <span className={getMoveClassName(move)}>
                                    {move.san}
                                </span>
                                {' '}
                            </React.Fragment>
                        ))}
                    </div>
                )}

                {/* Deviation summary */}
                {annotation?.deviation && (
                    <div className="game-deviation-summary">
                        <svg className="game-deviation-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 2L1 21h22L12 2z" fill="#9b59b6"/>
                            <text x="12" y="18" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="700">!</text>
                        </svg>
                        Repertoire has{' '}
                        <strong>
                            {annotation.deviation.repertoireMoves.map(m => m.san).join(', ') || '?'}
                        </strong>
                        {' '}but you played{' '}
                        <strong>{annotation.deviation.userMove.san}</strong>
                    </div>
                )}

                {/* End-of-theory eval drop summary */}
                {eotSummary && (
                    <div className="game-eot-summary">
                        <svg className="game-deviation-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 2L1 21h22L12 2z" fill={EOT_ICON_COLORS[eotSummary.category]}/>
                            <text x="12" y="18" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="700">!</text>
                        </svg>
                        Out of repertoire – you played <strong>{eotSummary.userSan}</strong>
                        {' '}({eotSummary.category})
                    </div>
                )}
            </div>
        </div>
    );
};

const GamesPage: React.FC = () => {
    const [games, setGames] = useState<StoredGame[]>([]);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
    const [error, setError] = useState<string>('');
    const [info, setInfo] = useState<string>('');
    const [fenSets, setFenSets] = useState<RepertoireFenSets | null>(null);
    const [explorerEvals, setExplorerEvals] = useState<ExplorerEvals | null>(null);
    const [mastersCache, setMastersCache] = useState<MastersCache | undefined>(undefined);
    const [mastersCacheVersion, setMastersCacheVersion] = useState(0);
    const [mastersProgress, setMastersProgress] = useState<{ fetched: number; total: number } | null>(null);
    const mastersFetchStartedRef = useRef(false);
    const purgePendingRef = useRef(false);
    const infoClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const debugGameIdsRef = useRef<Set<string>>(new Set());

    const measurePerf = useMemo(() => getMeasurePerf(), []);
    const perfT0Ref = useRef(measurePerf ? performance.now() : 0);

    const { token: lichessToken } = useLichessAuth();

    const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>(() => getLinkedAccounts());

    // Refresh linked accounts when the page gains focus (picks up Settings changes).
    useEffect(() => {
        const refresh = () => setLinkedAccounts(getLinkedAccounts());
        window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
    }, []);

    // Cleanup informational timer on unmount
    useEffect(() => {
        return () => {
            if (infoClearTimerRef.current) clearTimeout(infoClearTimerRef.current);
        };
    }, []);

    // Load repertoire data and build FEN sets
    useEffect(() => {
        const load = async () => {
            try {
                const username = localStorage.getItem('username') || '';
                const hashedPassword = localStorage.getItem('hashedPassword') || '';
                if (!username || !hashedPassword) return;

                const dal = createDataAccessLayer(username, hashedPassword);
                const repertoireData = await dal.retrieveRepertoireData();
                const sets = buildRepertoireFenSets(repertoireData.data);
                if (measurePerf) console.log(`[Perf] ${JSON.stringify({ step: "fenSets-ready", totalMs: Math.round(performance.now() - perfT0Ref.current), whiteFens: sets.whiteFens.size, blackFens: sets.blackFens.size })}`);
                setFenSets(sets);
            } catch (err) {
                console.warn('Failed to load repertoire data for game annotation:', err);
            }
        };
        load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Load explorer evals
    useEffect(() => {
        getExplorerEvals()
            .then(ev => {
                if (measurePerf) console.log(`[Perf] ${JSON.stringify({ step: "explorerEvals-ready", totalMs: Math.round(performance.now() - perfT0Ref.current) })}`);
                setExplorerEvals(ev);
            })
            .catch(err => console.warn('Failed to load explorer evals:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Load all masters positions from IndexedDB into cache on mount
    useEffect(() => {
        MastersCache.loadAll()
            .then(mc => {
                if (measurePerf) console.log(`[Perf] ${JSON.stringify({ step: "mastersCache-ready", totalMs: Math.round(performance.now() - perfT0Ref.current), positions: mc.size })}`);
                setMastersCache(mc);
            })
            .catch(err => console.warn('Failed to load masters cache:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Load games from IndexedDB
    useEffect(() => {
        const load = async () => {
            setLoading(true);
            try {
                const storedGames = await getAllGames();
                const cachedCount = storedGames.filter(g => 'annotation' in g).length;
                if (measurePerf) console.log(`[Perf] ${JSON.stringify({ step: "games-loaded", totalMs: Math.round(performance.now() - perfT0Ref.current), games: storedGames.length, withCachedAnnotation: cachedCount })}`);
                setGames(storedGames);
            } catch (err) {
                setError(`Failed to load games: ${err}`);
            } finally {
                setLoading(false);
            }
        };
        load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Filter games to only show those from currently linked accounts,
    // and skip games where the user can't be identified as a player.
    const linkedUsernames = useMemo(
        () => new Set(linkedAccounts.map(a => `${a.platform}:${a.username}`)),
        [linkedAccounts]
    );
    const MAX_DISPLAY_GAMES = 100;
    const filteredGames = useMemo(
        () => games.filter(g => {
            const gamePlatform = g.platform ?? 'lichess';
            const accountKey = `${gamePlatform}:${g.username}`;
            if (!linkedUsernames.has(accountKey)) return false;
            if (!getUserColor(g.data, g.username, gamePlatform)) {
                console.warn(
                    `[GamesPage] Skipping game ${g.id}: user "${g.username}" not found as either player`
                );
                return false;
            }
            return true;
        }).slice(0, MAX_DISPLAY_GAMES),
        [games, linkedUsernames]
    );

    // Compute annotations for displayed games, using cached annotations when available.
    // This useMemo is kept pure — persistence happens in a separate useEffect.
    // Wait for all annotation inputs before computing — otherwise incomplete annotations
    // would be cached permanently.
    const { annotationMap: baseAnnotations, pendingWrites } = useMemo(() => {
        const empty = { annotationMap: new Map<string, GameAnnotation | null>(), pendingWrites: [] as { id: string; annotation: GameAnnotation | null }[] };
        if (!fenSets || !explorerEvals || mastersCache === undefined) return empty;
        const t0 = measurePerf ? performance.now() : 0;
        const map = new Map<string, GameAnnotation | null>();
        const writes: { id: string; annotation: GameAnnotation | null }[] = [];
        let fromCache = 0;
        let computed = 0;
        for (const game of filteredGames) {
            // Use cached annotation if present
            if ('annotation' in game) {
                map.set(game.id, game.annotation ?? null);
                fromCache++;
                continue;
            }
            const gamePlatform = game.platform ?? 'lichess';
            const userColor = getUserColor(game.data, game.username, gamePlatform);

            const repertoireFens = userColor === 'white' ? fenSets.whiteFens
                : userColor === 'black' ? fenSets.blackFens
                    : new Set<string>();

            const result = annotateGame(game.data, game.username, repertoireFens, explorerEvals, 30, gamePlatform, mastersCache, debugGameIdsRef.current.has(game.id));
            map.set(game.id, result);
            writes.push({ id: game.id, annotation: result });
            computed++;
        }
        debugGameIdsRef.current.clear();
        if (measurePerf) console.log(`[Perf] ${JSON.stringify({ step: "annotations-ready", totalMs: Math.round(performance.now() - perfT0Ref.current), computeMs: Math.round(performance.now() - t0), fromCache, computed, total: map.size })}`);
        return { annotationMap: map, pendingWrites: writes };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filteredGames, fenSets, explorerEvals, mastersCache, mastersCacheVersion]);

    // Persist newly computed annotations to IndexedDB and update local state
    useEffect(() => {
        if (pendingWrites.length === 0) return;
        updateAnnotations(pendingWrites).catch(err =>
            console.warn('Failed to persist annotations:', err)
        );
        // Update local games state so the cache is warm for future renders
        setGames(prev => {
            const writeMap = new Map(pendingWrites.map(w => [w.id, w.annotation]));
            return prev.map(g => writeMap.has(g.id) ? { ...g, annotation: writeMap.get(g.id) } : g);
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingWrites]);

    // Masters explorer async patching: fetch masters data for ambiguous opponent moves
    // (eval drop 15–44 cp) that aren't already in the cache.
    // Uses a ref guard (instead of effect cleanup) so the fetch completes even when
    // React StrictMode double-fires effects.
    useEffect(() => {
        if (!lichessToken || !mastersCache) return;
        if (mastersFetchStartedRef.current) return;

        // Collect ambiguous positions that are NOT already in cache
        // Track which game IDs need re-annotation after masters data arrives
        const uncachedAmbiguous: { fen: string }[] = [];
        const gamesNeedingPatch = new Set<string>();
        for (const [gameId, annotation] of baseAnnotations.entries()) {
            if (annotation?.ambiguousTheoryPositions) {
                for (const pos of annotation.ambiguousTheoryPositions) {
                    if (!mastersCache.has(pos.fenBefore)) {
                        uncachedAmbiguous.push({ fen: pos.fenBefore });
                        gamesNeedingPatch.add(gameId);
                    }
                }
            }
        }
        if (uncachedAmbiguous.length === 0) return;

        mastersFetchStartedRef.current = true;
        // Capture the patch set locally so the async callback uses the correct set
        // even if a new masters fetch starts before this one completes.
        const patchGameIds = gamesNeedingPatch;

        // Deduplicate
        const seen = new Set<string>();
        const unique = uncachedAmbiguous.filter(p => {
            const key = p.fen.split(' ').slice(0, 4).join(' ');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const total = unique.length;
        let fetched = 0;

        (async () => {
            for (const pos of unique) {
                await mastersCache.fetchOrGet(pos.fen, lichessToken);
                fetched++;
                setMastersProgress({ fetched, total });
            }
            // Clear cached annotations in IndexedDB for games that had ambiguous positions
            await Promise.all([...patchGameIds].map(id => clearAnnotation(id)));
            // Clear in React state, then bump version to trigger re-annotation with masters data
            setGames(prev => prev.map(g => {
                if (!patchGameIds.has(g.id)) return g;
                const updated = { ...g };
                delete updated.annotation;
                return updated;
            }));
            setMastersCacheVersion(v => v + 1);
            setMastersProgress(null);
        })();
    }, [baseAnnotations, lichessToken, mastersCache]);

    // Cloud eval patching: disabled for now.
    // When re-enabled, this fetches Lichess cloud evals for positions where
    // sources 1 (ExplorerEvals) and 2 (embedded game analysis) had no data.
    // See git history for the full implementation with rate limiting and progress bar.
    const annotations = baseAnnotations;

    // Purge unused masters positions after Sync Games triggers re-annotation.
    // The purge is deferred: handleSync sets purgePendingRef=true, then on the next
    // render cycle baseAnnotations re-computes (incrementing hitCounts), and this
    // effect fires to delete positions with hitCount=0.
    useEffect(() => {
        if (!purgePendingRef.current || !mastersCache) return;
        purgePendingRef.current = false;
        mastersCache.purgeUnused();
    }, [baseAnnotations, mastersCache]);

    // Re-annotate a single game: clear its cached annotation and let the useMemo recompute
    const handleReannotate = async (gameId: string) => {
        debugGameIdsRef.current.add(gameId);
        await clearAnnotation(gameId);
        setGames(prev => prev.map(g => {
            if (g.id !== gameId) return g;
            const updated = { ...g };
            delete updated.annotation;
            return updated;
        }));
        // Allow masters fetches for newly discovered ambiguous positions
        mastersFetchStartedRef.current = false;
    };

    const handleSync = async () => {
        if (syncing) return;
        const accounts = getLinkedAccounts();
        if (accounts.length === 0) {
            setError('No linked accounts. Add an account in Settings first.');
            return;
        }

        setSyncing(true);
        setError('');
        setInfo('');
        setSyncProgress(null);
        if (infoClearTimerRef.current) {
            clearTimeout(infoClearTimerRef.current);
            infoClearTimerRef.current = null;
        }

        try {
            let totalGames = 0;
            const failures: string[] = [];
            for (const account of accounts) {
                try {
                    let count: number;
                    if (account.platform === 'chess.com') {
                        count = await syncChesscomGamesForUser(account.username, (progress) => {
                            setSyncProgress(progress);
                        });
                    } else {
                        count = await syncGamesForUser(account.username, (progress) => {
                            setSyncProgress(progress);
                        });
                    }
                    totalGames += count;
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    failures.push(`${account.username} (${account.platform}): ${msg}`);
                }
            }

            // Groom old games: keep only what's needed for display
            const groomResult = await groomGames(MAX_DISPLAY_GAMES);
            if (groomResult.deletedCount > 0) {
                for (const [accountKey, maxTs] of groomResult.deletedMaxTimestamps) {
                    const [platform, username] = accountKey.split(':') as [Platform, string];
                    advanceSyncWatermark(platform, username, maxTs);
                }
            }

            // Reset masters hit counts before re-annotation so we can detect unused positions.
            // Allow masters fetches to run again for new ambiguous positions.
            if (mastersCache) {
                mastersCache.resetHitCounts();
                purgePendingRef.current = true;
                mastersFetchStartedRef.current = false;
            }

            // Reload games from IndexedDB
            const storedGames = await getAllGames();
            setGames(storedGames);
            setLinkedAccounts(getLinkedAccounts());

            setSyncProgress(null);
            if (failures.length > 0) {
                setError(`Sync failed for: ${failures.join('; ')}`);
            } else if (totalGames === 0) {
                setInfo('No new games found.');
                infoClearTimerRef.current = setTimeout(() => setInfo(''), 3000);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setError(`Sync failed: ${message}`);
        } finally {
            setSyncing(false);
        }
    };

    return (
        <div className="games-page">
            <div className="games-header">
                <h1>Games</h1>
                <button
                    className="sync-button"
                    onClick={handleSync}
                    disabled={syncing}
                >
                    {syncing ? 'Syncing…' : '↻ Sync Games'}
                </button>
            </div>

            {syncProgress && !syncProgress.done && (
                <div className="sync-progress">
                    Downloading… {syncProgress.gamesDownloaded} games from {syncProgress.username}
                </div>
            )}

            {mastersProgress && (
                <div className="sync-progress">
                    Checking master games… {mastersProgress.fetched}/{mastersProgress.total}
                </div>
            )}

            {error && <div className="games-error">{error}</div>}
            {info && <div className="games-info">{info}</div>}

            {loading ? (
                <div className="games-empty"><p>Loading games…</p></div>
            ) : filteredGames.length === 0 ? (
                <div className="games-empty">
                    <p>No games downloaded yet.</p>
                    {linkedAccounts.length === 0 ? (
                        <p className="no-accounts-hint">
                            <Link to="/settings">Add an account</Link> in Settings first, then click Sync Games.
                        </p>
                    ) : (
                        <p className="no-accounts-hint">
                            Click "Sync Games" to download your recent games.
                        </p>
                    )}
                </div>
            ) : (
                filteredGames.map((game) => (
                    <GameRow
                        key={game.id}
                        game={game}
                        annotation={annotations.get(game.id) ?? null}
                        username={game.username}
                        onReannotate={handleReannotate}
                    />
                ))
            )}
        </div>
    );
};

export default GamesPage;
