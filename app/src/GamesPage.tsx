import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChessBoard } from 'chess-control';
import type { Annotation as ChessControlAnnotation } from 'chess-control';
import { createDataAccessLayer } from './DataAccessLayer';
import { getLinkedAccounts, LinkedAccount } from './LinkedAccountsService';
import { getAllGames, StoredGame } from './GamesDB';
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
import './GamesPage.css';

const END_OF_THEORY_CLASSES: Record<EvalDropCategory, string> = {
    ok: 'move-out-of-theory',
    inaccuracy: 'move-eot-inaccuracy',
    mistake: 'move-eot-mistake',
    blunder: 'move-eot-blunder',
};

function getMoveClassName(move: AnnotatedMove): string {
    if (!move.isUserMove) return 'move-token move-opponent';

    switch (move.highlight) {
        case 'in-repertoire':
            return 'move-token move-in-repertoire';
        case 'deviation':
            return 'move-token move-deviation';
        case 'end-of-theory-response': {
            const category = move.evalDrop?.category ?? 'ok';
            return `move-token ${END_OF_THEORY_CLASSES[category]}`;
        }
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
}

const GameRow: React.FC<GameRowProps> = ({ game, annotation, username }) => {
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
            arrows.push({ color: 'green', from: rm.from as any, to: rm.to as any });
        }
        arrows.push({ color: 'red', from: annotation.deviation.userMove.from as any, to: annotation.deviation.userMove.to as any });
        return arrows;
    }, [annotation]);

    const boardFen = annotation?.miniBoardFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

    return (
        <div className={`game-row${hasDeviation ? ' game-row-deviation' : ''}`}>
            {/* Mini board */}
            <div className="game-mini-board">
                <ChessBoard
                    fen={boardFen}
                    orientation={annotation?.miniBoardOrientation ?? meta.userColor ?? 'white'}
                    interactive={false}
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
                    <span className="game-meta-right">
                        {topRightParts.join(' | ')}
                    </span>
                </div>

                <div className="game-details-row">
                    {meta.openingName && (
                        <span className="game-opening">{meta.openingName}</span>
                    )}
                    <a
                        className="game-lichess-link"
                        href={meta.gameUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {platform === 'chess.com' ? '♔ View on Chess.com' : '♞ View on Lichess'}
                    </a>
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
    const [fenSets, setFenSets] = useState<RepertoireFenSets | null>(null);
    const [explorerEvals, setExplorerEvals] = useState<ExplorerEvals | null>(null);
    const infoClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
                setFenSets(sets);
            } catch (err) {
                console.warn('Failed to load repertoire data for game annotation:', err);
            }
        };
        load();
    }, []);

    // Load explorer evals
    useEffect(() => {
        getExplorerEvals()
            .then(setExplorerEvals)
            .catch(err => console.warn('Failed to load explorer evals:', err));
    }, []);

    // Load games from IndexedDB
    useEffect(() => {
        const load = async () => {
            setLoading(true);
            try {
                const storedGames = await getAllGames();
                setGames(storedGames);
            } catch (err) {
                setError(`Failed to load games: ${err}`);
            } finally {
                setLoading(false);
            }
        };
        load();
    }, []);

    // Filter games to only show those from currently linked accounts,
    // and skip games where the user can't be identified as a player.
    const linkedUsernames = useMemo(
        () => new Set(linkedAccounts.map(a => `${a.platform}:${a.username}`)),
        [linkedAccounts]
    );
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
        }),
        [games, linkedUsernames]
    );

    // Compute annotations for all displayed games (memoized)
    const annotations = useMemo(() => {
        if (!fenSets) return new Map<string, GameAnnotation | null>();
        const map = new Map<string, GameAnnotation | null>();
        for (const game of filteredGames) {
            const gamePlatform = game.platform ?? 'lichess';
            const userColor = getUserColor(game.data, game.username, gamePlatform);

            const repertoireFens = userColor === 'white' ? fenSets.whiteFens
                : userColor === 'black' ? fenSets.blackFens
                    : new Set<string>();

            map.set(
                game.id,
                annotateGame(game.data, game.username, repertoireFens, explorerEvals, 30, gamePlatform)
            );
        }
        return map;
    }, [filteredGames, fenSets, explorerEvals]);

    const handleSync = async () => {
        if (syncing) return;
        const accounts = getLinkedAccounts();
        if (accounts.length === 0) {
            setError('No linked accounts. Add an account in Settings first.');
            return;
        }

        setSyncing(true);
        setError('');
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

            // Reload games from IndexedDB
            const storedGames = await getAllGames();
            setGames(storedGames);
            setLinkedAccounts(getLinkedAccounts());

            setSyncProgress(null);
            if (failures.length > 0) {
                setError(`Sync failed for: ${failures.join('; ')}`);
            } else if (totalGames === 0) {
                setError('No new games found.');
                infoClearTimerRef.current = setTimeout(() => setError(''), 3000);
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

            {error && <div className="games-error">{error}</div>}

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
                    />
                ))
            )}
        </div>
    );
};

export default GamesPage;
