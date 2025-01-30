// RepertoirePage.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IDataAccessLayer, createDataAccessLayer } from './DataAccessLayer';
import { RepertoireData } from './RepertoireData';
import { RepertoireDataUtils } from './RepertoireDataUtils';
import { useNavigate } from 'react-router-dom';
import { FaEdit, FaTrashAlt } from 'react-icons/fa';
import ChessboardControl from './ChessboardControl';
import HoverablePgnText from './HoverablePgnText';
import './RepertoirePage.css';

interface ParsedVariant {
    orientation: 'white' | 'black';
    pgn: string;
    numberOfTimesPlayed: number;
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

    const [repData, setRepData] = useState<RepertoireData | null>(null);
    const [variants, setVariants] = useState<ParsedVariant[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

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

    // On mount, load repertoire data
    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const repDataFromServer: RepertoireData = await dal.retrieveRepertoireData();
                setRepData(repDataFromServer);

                // Convert to OpeningVariant then to something simpler for display
                const ovList = RepertoireDataUtils.convertToVariantData(repDataFromServer);

                // Make a simpler array of objects for the table
                const parsed = ovList.map((ov) => ({
                    orientation: ov.orientation,
                    pgn: ov.pgn,
                    numberOfTimesPlayed: ov.numberOfTimesPlayed,
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

    const handleNew = () => {
        window.alert('New repertoire placeholder');
    };

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

    // Track mouse move to position the popover
    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        setMousePos({ x: e.clientX, y: e.clientY });
    };

    const handleEdit = (v: ParsedVariant) => {
        // Placeholder for an edit flow
        window.alert(`Edit variant placeholder:\nOrientation: ${v.orientation}\nPGN: ${v.pgn}`);
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
        // Here you would remove from repData and/or call dal.storeRepertoireData(...)
        // For now we just show an alert:
        window.alert(`Deleting variant placeholder: ${v.pgn}`);
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
            style={{ position: 'relative', padding: '1rem' }}
            onMouseMove={handleMouseMove}
        >
            {/* Menu bar at the top */}
            <div style={{ marginBottom: '1rem' }}>
                <button onClick={handleNew}>New</button>
                <button onClick={handleExport}>Export</button>
                <button onClick={() => importInputRef.current?.click()}>Import</button>
                <input
                    type="file"
                    ref={importInputRef}
                    style={{ display: 'none' }}
                    accept={`.${FILE_EXTENSION}`}
                    onChange={handleImportFileSelected}
                />
            </div>
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
                        </tr>
                    </thead>
                    <tbody>
                        {variants.map((v, i) => (
                            <tr key={i}>
                                <td style={tdStyle}>
                                    {v.orientation}
                                </td>
                                <td style={tdStyle}>
                                    <HoverablePgnText
                                        pgn={v.pgn}
                                        onHoverMove={(fen) => {
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
