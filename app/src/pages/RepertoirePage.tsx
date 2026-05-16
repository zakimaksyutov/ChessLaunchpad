// RepertoirePage.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IDataAccessLayer, createDataAccessLayer } from '../data/DataAccessLayer';
import { RepertoireData } from '../models/RepertoireData';
import { useNavigate } from 'react-router-dom';
import { FaEdit, FaTrashAlt, FaInfoCircle, FaExternalLinkAlt } from 'react-icons/fa';

import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import { buildNormalizedFensFromPgn, isLikelyFen, normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import PgnControl from '../components/PgnControl';
import { ExplorerEvals, getExplorerEvals } from '../models/ExplorerEvals';
import { EvalDrop, computeEvalDrops } from '../services/EvalDropService';
import { getMeasurePerf } from '../utils/PerfUtils';
import AnalysisPopover from '../components/AnalysisPopover';
import './RepertoirePage.css';

interface ParsedVariant {
    orientation: 'white' | 'black';
    pgn: string;
    numberOfTimesPlayed: number;
    classifications: string[];
    fensNormalized: string[];
    recencyFactor: number;
    frequencyFactor: number;
    errorFactor: number;
    newnessFactor: number;
    weight: number;
}

const FILE_EXTENSION = 'chess';


// This page will do the following:
// - Load repertoire data from the server
// - Display the data in a table
// - Allow hovering over a PGN to preview the board position (with a ChessboardControl)
//   - The ChessboardControl will be a floating popover
//   - PGN is split into half moves and the board will show the position after each half move
// - The table will show the orientation, PGN, and number of times played
// - At the top there is a menu bar with New, Export, and Import buttons
const RepertoirePage: React.FC = () => {
    const navigate = useNavigate();
    const measurePerf = useMemo(() => getMeasurePerf(), []);

    const [repData, setRepData] = useState<RepertoireData | null>(null);
    const [variants, setVariants] = useState<ParsedVariant[]>([]);
    const [filter, setFilter] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [showStats, setShowStats] = useState(false);

    // Explorer evals — lazy loaded
    const [explorerEvals, setExplorerEvals] = useState<ExplorerEvals | null>(null);
    const [evalsLoading, setEvalsLoading] = useState(true);

    // We'll store the FEN we're previewing (clicked).
    const [hoveredFen, setHoveredFen] = useState<string | null>(null);
    const [hoveredOrientation, setHoveredOrientation] = useState<'white' | 'black' | null>(null);
    const [previousFen, setPreviousFen] = useState<string | null>(null);
    const [playedMoveSan, setPlayedMoveSan] = useState<string | null>(null);
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

    // For file selection when importing
    const importInputRef = useRef<HTMLInputElement>(null);

    // Build the Data Access Layer. This is the same approach as in TrainingPage:
    const dal: IDataAccessLayer = useMemo(() => {
        const username = localStorage.getItem('username') || '';
        const hashedPassword = localStorage.getItem('hashedPassword') || '';
        return createDataAccessLayer(username, hashedPassword);
    }, []);

    const filteredVariants = useMemo(() => {
        if (!filter.trim()) {
            return variants;
        }
        const trimmed = filter.trim();
        if (isLikelyFen(trimmed)) {
            const normalizedFilter = normalizeFenResetHalfmoveClock(trimmed);
            return variants.filter((v) => v.fensNormalized.includes(normalizedFilter));
        }
        const f = trimmed.toLowerCase();
        return variants.filter((v) =>
            v.classifications.some((cls) => cls.toLowerCase().includes(f))
        );
    }, [variants, filter]);

    // On mount, load repertoire data
    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const repDataFromServer: RepertoireData = await dal.retrieveRepertoireData();
                setRepData(repDataFromServer);

                // Convert to OpeningVariant objects:
                const allVariants = RepertoireDataUtils.convertToVariantData(repDataFromServer);
                for (const ov of allVariants) {
                    ov.calculateWeight();
                }

                // Map them to your ParsedVariant structure:
                const parsed = allVariants.map((ov) => ({
                    orientation: ov.orientation,
                    pgn: ov.pgn,
                    numberOfTimesPlayed: ov.numberOfTimesPlayed,
                    classifications: ov.classifications ?? [],
                    fensNormalized: buildNormalizedFensFromPgn(ov.pgn),
                    recencyFactor: ov.recencyFactor,
                    frequencyFactor: ov.frequencyFactor,
                    errorFactor: ov.errorFactor,
                    newnessFactor: ov.newnessFactor,
                    weight: ov.weight
                })).sort((a, b) => {
                    // Sort so that 'white' comes before 'black'.
                    // If orientation is the same, then sort by pgn lexicographically.
                    if (a.orientation === b.orientation) {
                        return a.pgn.localeCompare(b.pgn);
                    } else if (a.orientation === 'white' && b.orientation === 'black') {
                        return -1;
                    } else {
                        return 1;
                    }
                });

                setVariants(parsed);
            } catch (e: any) {
                setError(`Failed to load repertoire: ${e.message}`);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [dal]);

    // Lazy-load explorer evals (separate from repertoire data)
    useEffect(() => {
        const t0 = performance.now();
        getExplorerEvals()
            .then((ev) => {
                if (measurePerf) console.log('[Perf]', JSON.stringify({ step: 'explorer-evals', totalMs: Math.round(performance.now() - t0) }));
                setExplorerEvals(ev);
            })
            .catch((e) => console.warn('Failed to load explorer evals:', e))
            .finally(() => setEvalsLoading(false));
    }, []);

    // Pre-compute eval drops for all variants once evals are loaded
    const variantEvalDrops = useMemo(() => {
        if (!explorerEvals) return new Map<string, Map<string, EvalDrop>>();
        const t0 = performance.now();
        const map = new Map<string, Map<string, EvalDrop>>();
        for (const v of variants) {
            const drops = computeEvalDrops(v.pgn, explorerEvals, v.orientation);
            if (drops.size > 0) {
                map.set(`${v.orientation}::${v.pgn}`, drops);
            }
        }
        if (measurePerf) console.log('[Perf]', JSON.stringify({
            step: 'eval-drops',
            totalMs: Math.round(performance.now() - t0),
            variants: variants.length,
            withDrops: map.size,
        }));
        return map;
    }, [variants, explorerEvals]);

    const handleExport = () => {
        if (!repData) {
            return;
        }

        const json = JSON.stringify(repData, null, 2);
        const blob = new Blob([json], { type: 'application/json' });

        const username = localStorage.getItem('username') || 'user';
        const now = new Date().toISOString();
        const count = variants.length;
        const filename = `Repertoire-${username}-${now}-${count} variants.${FILE_EXTENSION}`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleImportFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) {
            return;
        }
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = async (event) => {
            if (!event.target?.result) {
                return;
            }
            try {
                const data: RepertoireData = JSON.parse(event.target.result as string);
                await dal.storeRepertoireData(data);

                // Instead of updating our state or the UI here, simply reload the page.
                // This ensures we fetch fresh data from the backend and re-render.
                // This also should make it clear to a user that import succeeded.
                navigate(0);
            } catch (ex: any) {
                alert('Failed to import: ' + ex.message);
            }
        };
        reader.readAsText(file);
    };


    const handleTrain = () => {
        if (filteredVariants.length === 0) {
            alert("No variants match your filter. Please adjust your filter before training.");
            return;
        }
        navigate(`/training?filter=${encodeURIComponent(filter.trim())}`);
    };

    const handleNew = () => {
        navigate('/repertoire/variant?mode=new');
    };

    const handleEdit = (v: ParsedVariant) => {
        navigate(
            `/repertoire/variant?mode=edit&pgn=${encodeURIComponent(v.pgn)}&orientation=${v.orientation}`
        );
    };

    const handleDelete = async (v: ParsedVariant) => {
        const confirmed = window.confirm(
            `Are you sure you want to permanently delete this variant?\n\n` +
            `Orientation: ${v.orientation}\nPGN: ${v.pgn}\n\n` +
            `You may want to export first if you plan to restore later.`
        );
        if (!confirmed) {
            return;
        }

        if (!repData) {
            console.error("No repData loaded. Cannot delete variant.");
            return;
        }

        // Create a new RepertoireData without the selected variant
        const updatedData: RepertoireData = {
            ...repData,
            data: repData.data.filter((od) =>
                !(od.orientation === v.orientation && od.pgn === v.pgn)
            ),
        };

        try {
            await dal.storeRepertoireData(updatedData);
            // Force a reload so we fetch fresh data and reflect the deletion
            navigate(0);
        } catch (ex: any) {
            alert(`Failed to delete variant: ${ex.message}`);
        }
    };

    if (loading) {
        return <div className="repertoire-loading">Loading repertoire...</div>;
    }
    if (error) {
        return (
            <div className="repertoire-error">
                <div className="repertoire-error-card">Error: {error}</div>
            </div>
        );
    }

    return (
        <div className="repertoire-page">
            <div className="repertoire-card">
                {/* Toolbar */}
                <div className="repertoire-toolbar">
                    <button className="rp-primary" onClick={handleNew}>New</button>
                    <button className="rp-secondary" onClick={handleExport}>Export</button>
                    <button className="rp-secondary" onClick={() => importInputRef.current?.click()}>Import</button>

                    <input
                        type="file"
                        ref={importInputRef}
                        style={{ display: 'none' }}
                        accept={`.${FILE_EXTENSION}`}
                        onChange={handleImportFileSelected}
                    />
                    <input
                        type="text"
                        className="repertoire-filter-input"
                        placeholder="Enter opening name or FEN"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                    />
                    <button className="rp-primary" onClick={handleTrain}>
                        Train
                    </button>
                    <label className="repertoire-stats-toggle">
                        <input
                            type="checkbox"
                            checked={showStats}
                            onChange={(e) => setShowStats(e.target.checked)}
                        />
                        Internal stats
                    </label>
                </div>
                {evalsLoading && (
                    <div className="repertoire-evals-loading">
                        Loading move evaluations…
                    </div>
                )}
                {variants.length === 0 ? (
                    <p className="repertoire-empty">No variants found.</p>
                ) : (
                    <div className="repertoire-table-wrapper">
                        <table className="repertoire-table">
                            <thead>
                                <tr>
                                    <th>Orientation</th>
                                    <th>PGN</th>
                                    <th className="col-nowrap">Actions</th>
                                    <th className="col-played">Times Played</th>
                                    {showStats && (
                                        <>
                                            <th>
                                                _nf
                                                <FaInfoCircle title="Newness Factor - If a variant has been played successfully fewer than 7 times, the factor is higher. Formula: (1 + max(7 - num, 0))^2."
                                                    style={{ marginLeft: '4px', color: '#888' }}
                                                />
                                            </th>
                                            <th>
                                                _rf
                                                <FaInfoCircle title="Recency Factor - The longer it has been since last played, the higher the factor. Formula: 1 + (number of days since last played)."
                                                    style={{ marginLeft: '4px', color: '#888' }}
                                                />
                                            </th>
                                            <th>
                                                _ff
                                                <FaInfoCircle title="Frequency Factor - The more often a variant is played, the lower the factor. It is internally tracked as an Exponential Moving Average (EMA) with α = 0.6667 (averaging across three days). Any error resets the factor to 0, and it increases daily. Formula: 1 / (1 + EMA)^2."
                                                    style={{ marginLeft: '4px', color: '#888' }}
                                                />
                                            </th>
                                            <th>
                                                _ef
                                                <FaInfoCircle title="Error Factor - The more errors recorded, the higher the factor. It is internally tracked as a decaying sum of errors. Formula: (1 + sum of errors)^2."
                                                    style={{ marginLeft: '4px', color: '#888' }}
                                                />
                                            </th>
                                            <th>
                                                _w
                                                <FaInfoCircle title="Weight - Used to calculate the probability of selecting the next move from available variants. Formula: _w = _nf * _rf * _ff * _ef."
                                                    style={{ marginLeft: '4px', color: '#888' }}
                                                />
                                            </th>
                                        </>
                                    )}
                                </tr>
                            </thead>
                            <tbody>
                                {filteredVariants.map((v, i) => (
                                    <tr key={i}>
                                        <td>
                                            <span className={`orientation-chip ${v.orientation}`}>
                                                {v.orientation}
                                            </span>
                                        </td>
                                        <td>
                                            <PgnControl
                                                pgn={v.pgn}
                                                onClickMove={(fen, prevFen, moveSan, rect) => {
                                                    setHoveredFen(fen);
                                                    setHoveredOrientation(v.orientation);
                                                    setPreviousFen(prevFen);
                                                    setPlayedMoveSan(moveSan);
                                                    setAnchorRect(rect);
                                                }}
                                                onLeavePgn={() => {
                                                    // Popover is dismissed via click-away or Escape
                                                }}
                                                evalDrops={variantEvalDrops.get(`${v.orientation}::${v.pgn}`)}
                                            />
                                        </td>
                                        <td className="col-actions">
                                            <FaEdit className="actionsIcon"
                                                style={{ cursor: 'pointer', marginRight: '8px' }}
                                                onClick={() => handleEdit(v)}
                                            />
                                            <FaTrashAlt className="actionsIcon"
                                                style={{ cursor: 'pointer', marginRight: '8px' }}
                                                onClick={() => handleDelete(v)}
                                            />
                                            <a
                                                href={`https://lichess.org/analysis/pgn/${encodeURIComponent(v.pgn)}?color=${v.orientation}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                title="Analyze on Lichess"
                                            >
                                                <FaExternalLinkAlt className="actionsIcon"
                                                    style={{ cursor: 'pointer' }}
                                                />
                                            </a>
                                        </td>
                                        <td className="col-played">{v.numberOfTimesPlayed}</td>
                                        {showStats && (
                                            <>
                                                <td className="col-stat">{v.newnessFactor !== undefined ? v.newnessFactor.toFixed(4) : '-'}</td>
                                                <td className="col-stat">{v.recencyFactor !== undefined ? v.recencyFactor.toFixed(4) : '-'}</td>
                                                <td className="col-stat">{v.frequencyFactor !== undefined ? v.frequencyFactor.toFixed(4) : '-'}</td>
                                                <td className="col-stat">{v.errorFactor !== undefined ? v.errorFactor.toFixed(4) : '-'}</td>
                                                <td className="col-stat">{v.weight !== undefined ? v.weight.toFixed(4) : '-'}</td>
                                            </>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {/* Analysis popover for the clicked position */}
                {hoveredFen && previousFen && playedMoveSan && anchorRect && (
                    <AnalysisPopover
                        clickedFen={hoveredFen}
                        previousFen={previousFen}
                        playedMoveSan={playedMoveSan}
                        orientation={hoveredOrientation === 'black' ? 'black' : 'white'}
                        anchorRect={anchorRect}
                        onClose={() => {
                            setHoveredFen(null);
                            setHoveredOrientation(null);
                            setPreviousFen(null);
                            setPlayedMoveSan(null);
                            setAnchorRect(null);
                        }}
                    />
                )}
            </div>
        </div>
    );
};

export default RepertoirePage;
