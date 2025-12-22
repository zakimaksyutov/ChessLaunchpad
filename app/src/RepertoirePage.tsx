// RepertoirePage.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { IDataAccessLayer, createDataAccessLayer } from './DataAccessLayer';
import { RepertoireData } from './RepertoireData';
import { useNavigate } from 'react-router-dom';
import { FaEdit, FaTrashAlt, FaInfoCircle } from 'react-icons/fa';
import { DatabaseOpeningsUtils, DatabaseOpening } from './DatabaseOpeningsUtils';
import { RepertoireDataUtils } from './RepertoireDataUtils';
import { normalizeFenResetHalfmoveClock } from './FenUtils';
import ChessboardControl from './ChessboardControl';
import PgnControl from './PgnControl';
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

const isLikelyFen = (value: string): boolean => {
    // Heuristic check: FENs have 6 space-delimited fields and 8 ranks in the piece placement.
    // This avoids false positives on normal opening-name text while staying lightweight.
    const trimmed = value.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 6) {
        return false;
    }
    const ranks = parts[0].split('/');
    return ranks.length === 8;
};

const buildNormalizedFensFromPgn = (pgn: string): string[] => {
    const chess = new Chess();
    try {
        chess.loadPgn(pgn);
    } catch {
        return [];
    }
    chess.deleteComments();

    const moves = chess.history({ verbose: true });
    const temp = new Chess();
    const fens: string[] = [normalizeFenResetHalfmoveClock(temp.fen())];

    for (const move of moves) {
        temp.move(move);
        fens.push(normalizeFenResetHalfmoveClock(temp.fen()));
    }

    return Array.from(new Set(fens));
};

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

    const [repData, setRepData] = useState<RepertoireData | null>(null);
    const [variants, setVariants] = useState<ParsedVariant[]>([]);
    const [filter, setFilter] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [showStats, setShowStats] = useState(false);

    // We'll store the FEN we're previewing (hovered).
    const [hoveredFen, setHoveredFen] = useState<string | null>(null);
    const [hoveredOrientation, setHoveredOrientation] = useState<'white' | 'black' | null>(null);

    // We'll store the mouse position so we can pop up the board near the cursor.
    const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

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

    const handleClassify = async () => {
        try {
            if (!repData) {
                throw new Error('No repertoire data loaded. Cannot classify.');
            }

            // Load the openings database
            const openings: DatabaseOpening[] = await DatabaseOpeningsUtils.DownloadOpenings();

            // For each variant, classify the opening
            for (const variant of repData.data) {
                const classifications = DatabaseOpeningsUtils.ClassifyOpening(variant.pgn, openings);
                variant.classifications = classifications;
            }

            // Store the updated data
            await dal.storeRepertoireData(repData);

            // Instead of updating our state or the UI here, simply reload the page.
            // This ensures we fetch fresh data from the backend and re-render.
            // This also should make it clear to a user that import succeeded.
            //navigate(0);
        }
        catch (ex: any) {
            alert(`Failed to classify: ${ex.message}`);

            // We modified internal state, it is easier to reload the page.
            navigate(0);
        }
    };

    const handleTrain = () => {
        if (filteredVariants.length === 0) {
            alert("No variants match your filter. Please adjust your filter before training.");
            return;
        }
        navigate(`/training?filter=${encodeURIComponent(filter.trim())}`);
    };

    // Track mouse move to position the popover
    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        setMousePos({ x: e.clientX, y: e.clientY });
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
        return <div style={{ padding: '1rem' }}>Loading repertoire...</div>;
    }
    if (error) {
        return <div style={{ padding: '1rem', color: 'red' }}>Error: {error}</div>;
    }

    return (
        // We use onMouseMove at the container level
        <div
            style={{ padding: '1rem' }}
            onMouseMove={handleMouseMove}
        >
            {/* Menu bar at the top */}
            <div style={{ marginBottom: '1rem' }}>
                <button onClick={handleNew}>New</button>
                <button onClick={handleExport}>Export</button>
                <button onClick={() => importInputRef.current?.click()}>Import</button>
                <button onClick={handleClassify}>Classify</button>
                <input
                    type="file"
                    ref={importInputRef}
                    style={{ display: 'none' }}
                    accept={`.${FILE_EXTENSION}`}
                    onChange={handleImportFileSelected}
                />
                <input
                    type="text"
                    placeholder="Enter opening name or FEN"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    style={{ marginLeft: '1rem' }}
                />
                <button onClick={handleTrain} style={{ marginLeft: '8px' }}>
                    Train
                </button>
                <label style={{ marginLeft: '8px' }}>
                    <input
                        type="checkbox"
                        checked={showStats}
                        onChange={(e) => setShowStats(e.target.checked)}
                    />
                    Internal stats
                </label>            </div>
            {variants.length === 0 ? (
                <p>No variants found.</p>
            ) : (
                <table
                    style={{
                        borderCollapse: 'collapse',
                        minWidth: 600,
                        width: '100%',
                    }}
                >
                    <thead>
                        <tr style={{ backgroundColor: '#eee' }}>
                            <th style={thStyle}>Orientation</th>
                            <th style={thStyle}>PGN</th>
                            <th style={thStyle}>Actions</th>
                            <th style={thStyle}>Times Played</th>
                            {showStats && (
                                <>
                                    <th style={thStyle}>
                                        _nf
                                        <FaInfoCircle title="Newness Factor - If a variant has been played successfully fewer than 7 times, the factor is higher. Formula: (1 + max(7 - num, 0))^2."
                                            style={{ marginLeft: '4px', color: '#888' }}
                                        />
                                    </th>
                                    <th style={thStyle}>
                                        _rf
                                        <FaInfoCircle title="Recency Factor - The longer it has been since last played, the higher the factor. Formula: 1 + (number of days since last played)."
                                            style={{ marginLeft: '4px', color: '#888' }}
                                        />
                                    </th>
                                    <th style={thStyle}>
                                        _ff
                                        <FaInfoCircle title="Frequency Factor - The more often a variant is played, the lower the factor. It is internally tracked as an Exponential Moving Average (EMA) with α = 0.6667 (averaging across three days). Any error resets the factor to 0, and it increases daily. Formula: 1 / (1 + EMA)^2."
                                            style={{ marginLeft: '4px', color: '#888' }}
                                        /></th>
                                    <th style={thStyle}>
                                        _ef
                                        <FaInfoCircle title="Error Factor - The more errors recorded, the higher the factor. It is internally tracked as a decaying sum of errors. Formula: (1 + sum of errors)^2."
                                            style={{ marginLeft: '4px', color: '#888' }}
                                        /></th>
                                    <th style={thStyle}>
                                        _w
                                        <FaInfoCircle title="Weight - Used to calculate the probability of selecting the next move from available variants. Formula: _w = _nf * _rf * _ff * _ef."
                                            style={{ marginLeft: '4px', color: '#888' }}
                                        /></th>
                                </>
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {filteredVariants.map((v, i) => (
                            <tr key={i}>
                                <td style={tdStyle}>
                                    {v.orientation}
                                </td>
                                <td style={tdStyle}>
                                    <PgnControl
                                        pgn={v.pgn}
                                        onClickMove={(fen) => {
                                            setHoveredFen(fen);
                                            setHoveredOrientation(v.orientation);
                                        }}
                                        onLeavePgn={() => {
                                            setHoveredFen(null);
                                            setHoveredOrientation(null);
                                        }}
                                    />
                                </td>
                                <td style={tdStyle}>
                                    <FaEdit className="actionsIcon"
                                        style={{ cursor: 'pointer', marginRight: '8px' }}
                                        onClick={() => handleEdit(v)}
                                    />
                                    <FaTrashAlt className="actionsIcon"
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => handleDelete(v)}
                                    />
                                </td>
                                <td style={tdStyle}>{v.numberOfTimesPlayed}</td>
                                {showStats && (
                                    <>
                                        <td style={{ ...tdStyle, whiteSpace: 'nowrap', width: '1%' }}>{v.newnessFactor !== undefined ? v.newnessFactor.toFixed(4) : '-'}</td>
                                        <td style={{ ...tdStyle, whiteSpace: 'nowrap', width: '1%' }}>{v.recencyFactor !== undefined ? v.recencyFactor.toFixed(4) : '-'}</td>
                                        <td style={{ ...tdStyle, whiteSpace: 'nowrap', width: '1%' }}>{v.frequencyFactor !== undefined ? v.frequencyFactor.toFixed(4) : '-'}</td>
                                        <td style={{ ...tdStyle, whiteSpace: 'nowrap', width: '1%' }}>{v.errorFactor !== undefined ? v.errorFactor.toFixed(4) : '-'}</td>
                                        <td style={{ ...tdStyle, whiteSpace: 'nowrap', width: '1%' }}>{v.weight !== undefined ? v.weight.toFixed(4) : '-'}</td>
                                    </>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {/* Floating popover for the hovered position */}
            {hoveredFen && (() => {
                // Here we detect if the popover would go off-screen, and adjust.
                const popoverWidth = 250;
                const popoverHeight = 250;
                const offset = 20;

                let top = mousePos.y + offset;
                let left = mousePos.x + offset;

                // If popover bottom goes beyond the window height, show it above instead.
                if (top + popoverHeight > window.innerHeight) {
                    top = mousePos.y - offset - popoverHeight;
                }

                // If it goes off the right edge...
                if (left + popoverWidth > window.innerWidth) {
                    left = mousePos.x - offset - popoverWidth;
                }

                return (
                    <div
                        style={{
                            position: 'fixed',
                            left,
                            top,
                            border: '1px solid #ccc',
                            backgroundColor: '#fff',
                            zIndex: 9999,
                            width: popoverWidth,
                            height: popoverHeight,
                            pointerEvents: 'none',
                        }}
                    >
                        <ChessboardControl
                            roundId="preview-board"
                            fen={hoveredFen}
                            orientation={hoveredOrientation === 'black' ? 'black' : 'white'}
                            movePlayed={() => false} // read-only
                        />
                    </div>
                );
            })()}
        </div>
    );
};

export default RepertoirePage;

const thStyle: React.CSSProperties = {
    border: '1px solid #ccc',
    padding: '6px',
    textAlign: 'left',
};

const tdStyle: React.CSSProperties = {
    border: '1px solid #ccc',
    padding: '6px',
};
