// RepertoirePage.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { IDataAccessLayer, createDataAccessLayer } from './DataAccessLayer';
import { RepertoireData } from './RepertoireData';
import { RepertoireDataUtils } from './RepertoireDataUtils';
import ChessboardControl from './ChessboardControl';
import HoverablePgnText from './HoverablePgnText';

interface ParsedVariant {
    orientation: 'white' | 'black';
    pgn: string;
    numberOfTimesPlayed: number;
}

// This page will do the following:
// - Load repertoire data from the server
// - Display the data in a table
// - Allow hovering over a PGN to preview the board position (with a ChessboardControl)
//   - The ChessboardControl will be a floating popover
//   - PGN is split into half moves and the board will show the position after each half move
// - The table will show the orientation, PGN, and number of times played
const RepertoirePage: React.FC = () => {
    const [variants, setVariants] = useState<ParsedVariant[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // We'll store the FEN we're previewing (hovered).
    const [hoveredFen, setHoveredFen] = useState<string | null>(null);
    const [hoveredOrientation, setHoveredOrientation] = useState<'white' | 'black' | null>(null);

    // We'll store the mouse position so we can pop up the board near the cursor.
    const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

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
                const repData: RepertoireData = await dal.retrieveRepertoireData();

                // Convert to OpeningVariant then to something simpler for display
                const ovList = RepertoireDataUtils.convertToVariantData(repData);

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

    // Track mouse move to position the popover
    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        setMousePos({ x: e.clientX, y: e.clientY });
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
            <h2>Repertoire Page</h2>
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
                            <th style={thStyle}>Times Played</th>
                        </tr>
                    </thead>
                    <tbody>
                        {variants.map((v, i) => (
                            <tr key={i}>
                                <td style={tdStyle}>{v.orientation}</td>
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
