import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChessBoard } from 'chess-control';
import { createDataAccessLayer } from './DataAccessLayer';
import { getLinkedAccounts } from './LinkedAccountsService';
import { getAllGames, StoredGame } from './GamesDB';
import { syncGamesForUser, SyncProgress } from './LichessGamesService';
import { buildRepertoireFenSets, RepertoireFenSets } from './RepertoireFenSet';
import {
    annotateGame,
    GameAnnotation,
    getGameMetadata,
    getUserColor,
    AnnotatedMove,
} from './GameAnnotationService';
import { getExplorerEvals, ExplorerEvals } from './ExplorerEvals';
import { EvalDropCategory } from './EvalDropService';
import './GamesPage.css';

const EVAL_DROP_CLASSES: Record<EvalDropCategory, string> = {
    ok: 'move-deviation-ok',
    inaccuracy: 'move-deviation-inaccuracy',
    mistake: 'move-deviation-mistake',
    blunder: 'move-deviation-blunder',
};

function getMoveClassName(move: AnnotatedMove): string {
    if (!move.isUserMove) return 'move-token move-opponent';

    switch (move.highlight) {
        case 'in-repertoire':
            return 'move-token move-in-repertoire';
        case 'deviation':
            return `move-token ${EVAL_DROP_CLASSES[move.evalDrop?.category ?? 'ok']}`;
        case 'out-of-theory':
            return 'move-token move-out-of-theory';
    }
}

interface GameRowProps {
    game: StoredGame;
    annotation: GameAnnotation | null;
    username: string;
}

const GameRow: React.FC<GameRowProps> = ({ game, annotation, username }) => {
    const meta = useMemo(
        () => getGameMetadata(game.data, username),
        [game.data, username]
    );

    const dateStr = useMemo(() => {
        const d = new Date(meta.createdAt);
        return d.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }, [meta.createdAt]);

    return (
        <div className="game-row">
            {/* Mini board */}
            <div className="game-mini-board">
                {annotation ? (
                    <ChessBoard
                        fen={annotation.miniBoardFen}
                        orientation={annotation.miniBoardOrientation}
                        interactive={false}
                        turnColor="white"
                        legalMoves={new Map()}
                    />
                ) : (
                    <ChessBoard
                        fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
                        orientation={meta.userColor || 'white'}
                        interactive={false}
                        turnColor="white"
                        legalMoves={new Map()}
                    />
                )}
            </div>

            {/* Game info */}
            <div className="game-info">
                <div className="game-meta-row">
                    <span className="game-opponent">{meta.opponentName}</span>
                    {meta.opponentRating && (
                        <span className="game-rating">({meta.opponentRating})</span>
                    )}
                    <span className={`game-result ${meta.result}`}>
                        {meta.result}
                    </span>
                    {meta.timeControl && (
                        <span className="game-time-control">⏱ {meta.timeControl}</span>
                    )}
                    {meta.rated && (
                        <span className="game-rated-badge">Rated</span>
                    )}
                </div>

                {meta.openingName && (
                    <div className="game-opening">{meta.openingName}</div>
                )}

                <div className="game-date">{dateStr}</div>

                {/* Annotated PGN */}
                {annotation && annotation.moves.length > 0 && (
                    <div className="game-pgn">
                        {annotation.moves.map((move, idx) => (
                            <span
                                key={idx}
                                className={getMoveClassName(move)}
                            >
                                {move.text}{' '}
                            </span>
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

    // Read linked accounts fresh each render so Settings changes are visible
    // without a full page reload.
    const linkedAccounts = getLinkedAccounts();

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

    // Filter games to only show those from currently linked accounts
    const linkedUsernames = useMemo(
        () => new Set(linkedAccounts.map(a => a.username)),
        [linkedAccounts]
    );
    const filteredGames = useMemo(
        () => games.filter(g => linkedUsernames.has(g.username)),
        [games, linkedUsernames]
    );

    // Compute annotations for all displayed games (memoized)
    const annotations = useMemo(() => {
        if (!fenSets) return new Map<string, GameAnnotation | null>();
        const map = new Map<string, GameAnnotation | null>();
        for (const game of filteredGames) {
            const userColor = getUserColor(game.data, game.username);

            const repertoireFens = userColor === 'white' ? fenSets.whiteFens
                : userColor === 'black' ? fenSets.blackFens
                    : new Set<string>();

            map.set(
                game.id,
                annotateGame(game.data, game.username, repertoireFens, explorerEvals)
            );
        }
        return map;
    }, [filteredGames, fenSets, explorerEvals]);

    const handleSync = async () => {
        if (syncing) return;
        const accounts = getLinkedAccounts();
        if (accounts.length === 0) {
            setError('No linked accounts. Add a Lichess username in Settings first.');
            return;
        }

        setSyncing(true);
        setError('');
        setSyncProgress(null);

        try {
            let totalGames = 0;
            for (const account of accounts) {
                const count = await syncGamesForUser(account.username, (progress) => {
                    setSyncProgress(progress);
                });
                totalGames += count;
            }

            // Reload games from IndexedDB
            const storedGames = await getAllGames();
            setGames(storedGames);

            setSyncProgress(null);
            if (totalGames === 0) {
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
                            <Link to="/settings">Add a Lichess account</Link> in Settings first, then click Sync Games.
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
