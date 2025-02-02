import React, { useEffect, useState } from 'react';
import { IDataAccessLayer, createDataAccessLayer } from './DataAccessLayer';
import { useNavigate, useLocation } from 'react-router-dom';
import ChessboardControl from './ChessboardControl';
import { Chess, Move } from 'chess.js';
import { Annotation } from './Annotation';
import { extractAnnotations, serializeAnnotationsAsComment } from './AnnotationUtils';
import PgnControl from './PgnControl';
import './VariantPage.css';

interface ContextMenuState {
    show: boolean;
    x: number;
    y: number;
    moveIndex: number;
}

/**
 * Displays a page for creating or editing a chess opening variant.
 * - In edit mode, expects `pgn` and `orientation` in query params.
 *   e.g. /variant?mode=edit&pgn=1.%20e4...&orientation=white
 * - In new mode, either no query params or `mode=new`:
 *   e.g. /variant?mode=new
 * - If required params are missing in edit mode, we redirect to /repertoire.
 * 
 * Page layout:
 *   +--------------------------------------------------------+
 *   | Save   Cancel                                          |
 *   +--------------------------------------------------------+
 *   | [ ChessboardControl ]                                  |
 *   +--------------------------------------------------------+
 *   | Orientation: [ white / black ]   [Back Move button]    |
 *   +--------------------------------------------------------+
 *   | PGN:  <text area> or read-only text for the PGN        |
 *   +--------------------------------------------------------+
 */
const VariantPage: React.FC = () => {
    const navigate = useNavigate();
    const location = useLocation();

    // Pull query params from URL
    const queryParams = new URLSearchParams(location.search);
    const mode = queryParams.get('mode') || 'new'; // 'new' or 'edit'
    const initialPgn = queryParams.get('pgn') || '';
    const initialOrientationParam = queryParams.get('orientation') as 'white' | 'black' | null;

    // If `mode=edit`, we expect `pgn` and `orientation` to be present.
    // If any is missing, redirect to /repertoire.
    useEffect(() => {
        if (mode === 'edit') {
            if (!initialPgn || !initialOrientationParam) {
                navigate('/repertoire');
            }
        }
    }, [mode, initialPgn, initialOrientationParam, navigate]);

    // If user is creating new variant, we can default orientation to white.
    const [orientation, setOrientation] = useState<'white' | 'black'>(initialOrientationParam || 'white');
    const [chess] = useState(() => new Chess());
    const [pgn, setPgn] = useState<string>(initialPgn);
    const [annotationsMap, setAnnotationsMap] = useState<{ [fen: string]: Annotation[] }>({});
    const [fen, setFen] = useState<string>(chess.fen());
    const [moveIndex, setMoveIndex] = useState<number>(0);
    const [contextMenu, setContextMenu] = useState<ContextMenuState>({
        show: false,
        x: 0,
        y: 0,
        moveIndex: -1,
    });

    // On mount (or if initialPgn changes in edit mode), load the PGN into chess
    useEffect(() => {
        chess.reset();
        if (initialPgn) {
            chess.loadPgn(initialPgn);

            // Parse annotations
            const newMap: { [fen: string]: Annotation[] } = {};
            chess.getComments().forEach(comment => {
                const fen = comment.fen;
                const annotations = extractAnnotations(comment.comment);
                newMap[fen] = annotations;
            });
            setAnnotationsMap(newMap);

            // We parsed annotations from comments. Now, remove comments from the PGN.
            // We will re-add them back during save.
            chess.deleteComments();

            setPgn(chess.pgn());
        } else {
            setPgn(chess.pgn());
        }

        setMoveIndex(Math.max(0, chess.history().length));

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialPgn]);

    useEffect(() => {
        const moves = chess.history({ verbose: true }) as Move[];

        const newChess = new Chess();
        for (let i = 0; i < moveIndex; i++) {
            newChess.move(moves[i]);
        }
        setFen(newChess.fen());

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [moveIndex]);

    const handleAnnotationsChanged = (fen: string, annotations: Annotation[]) => {
        setAnnotationsMap(prevMap => ({
            ...prevMap,
            [fen]: annotations
        }));
    };

    // Called when user attempts a move on the board
    const handleMove = (orig: string, dest: string): boolean => {

        // If we're not at the end of the move list, don't allow new moves
        if (moveIndex < chess.history().length) {
            return false;
        }

        // Try the move in a cloned Chess instance
        const clone = new Chess(chess.fen());
        const moveObj = clone.move({ from: orig, to: dest });

        if (!moveObj) {
            // Illegal move
            return false;
        }

        // If legal, apply it to the "real" chess object
        chess.move({ from: orig, to: dest });
        setPgn(chess.pgn());

        setMoveIndex(Math.max(0, chess.history().length));

        return true;
    };

    const handleFlipBoard = () => {
        setOrientation((o) => (o === 'white' ? 'black' : 'white'));
    };

    const handleSave = async () => {
        const username = localStorage.getItem('username') || '';
        const hashedPassword = localStorage.getItem('hashedPassword') || '';
        try {
            const dal: IDataAccessLayer = createDataAccessLayer(username, hashedPassword);
            const repertoire = await dal.retrieveRepertoireData();

            // Add annotations back to the PGN
            const moves = chess.history({ verbose: true }) as Move[];
            const newChess = new Chess();
            for (let i = 0; i < moves.length; i++) {
                newChess.move(moves[i]);
                const annotations = annotationsMap[newChess.fen()] || [];
                if (annotations.length > 0) {
                    const comment = serializeAnnotationsAsComment(annotations);
                    newChess.setComment(comment);
                }
            }

            const finalPgn = newChess.pgn();

            // Check whether such a variant already exists
            const newVariant = repertoire.data.find(v => v.pgn === finalPgn && v.orientation === orientation);
            const oldVariant = repertoire.data.find(v => v.pgn === initialPgn && v.orientation === initialOrientationParam);

            if (mode === 'new') {
                if (newVariant) {
                    throw new Error('This variant already exists in the repertoire.');
                }
            } else if (mode === 'edit') {
                if (!oldVariant) {
                    throw new Error('Could not find the original variant to edit.');
                }
                if (newVariant && newVariant !== oldVariant) {
                    throw new Error('This variant already exists in the repertoire.');
                }
            }

            // In editing mode - remove the original variant
            if (mode === 'edit') {
                repertoire.data = repertoire.data.filter(v => v !== oldVariant);
            }

            // Add to the repertoire
            repertoire.data.push({
                pgn: finalPgn,
                orientation,
                errorEMA: 0,
                numberOfTimesPlayed: 0,
                lastSucceededEpoch: 0,
                successEMA: 0
            });

            // Persist the updated repertoire
            await dal.storeRepertoireData(repertoire);

            navigate('/repertoire');
        }
        catch (ex: any) {
            alert(`Failed to save variant: ${ex.message}`);
        }
    };

    const handleCancel = () => {
        navigate('/repertoire');
    };

    const handleRightClickMove = (fen: string, e: React.MouseEvent) => {
        const moveIdx = mapFenToMoveIndex(fen);
        if (moveIdx === -1) {
            return;
        }

        setContextMenu({
            show: true,
            x: e.clientX,
            y: e.clientY,
            moveIndex: moveIdx
        });
    };

    // If user clicks anywhere else on the page, close the context menu
    const handlePageClick = () => {
        if (contextMenu.show) {
            setContextMenu(prev => ({ ...prev, show: false }));
        }
    };

    const mapFenToMoveIndex = (fen: string): number => {
        const moves = chess.history({ verbose: true }) as Move[];
        const newChess = new Chess();
        for (let i = 0; i < moves.length; i++) {
            newChess.move(moves[i]);
            if (newChess.fen() === fen) {
                return i + 1;
            }
        }

        return -1;
    }

    // Delete all moves from `moveIndex` onward.
    // This means we keep only the first `moveIndex` half-moves in the chess history.
    const handleDeleteFromHere = () => {
        const movesVerbose = chess.history({ verbose: true }) as Move[];
        const idx = contextMenu.moveIndex;

        // Rebuild from scratch up to (but not including) moveIndex
        // Note - we need to iterate till moveIndex - 1. Otherwise, we will not delete the move at moveIndex. 
        chess.reset();
        for (let i = 0; i < idx - 1; i++) {
            chess.move(movesVerbose[i]);
        }

        setPgn(chess.pgn());
        setMoveIndex(chess.history().length);

        // Hide context menu
        setContextMenu((prev) => ({ ...prev, show: false }));
    };

    // Render
    return (
        <div className="variant-page" onClick={handlePageClick}>
            {/* Top menu bar */}
            <div className="variant-menu-bar">
                <button onClick={handleSave}>Save</button>
                <button onClick={handleCancel}>Cancel</button>
                <button onClick={handleFlipBoard}>Flip board</button>
            </div>

            {/* Chessboard */}
            <div className="variant-board-section">
                <ChessboardControl
                    roundId="variant-editor"
                    fen={fen}
                    orientation={orientation}
                    movePlayed={handleMove}
                    annotationsChanged={handleAnnotationsChanged}
                    annotations={annotationsMap[fen] || []}
                />
            </div>

            {/* PGN field */}
            <div className="pgn-container"
                style={{
                    width: '100%',
                    maxWidth: '704px',
                    position: 'relative',
                    overflowY: 'auto',
                }}
            >
                <div className="variant-pgn-section">
                    <div className="pgn-row">
                        <label>PGN:</label>

                        {/* Move-navigation buttons */}
                        {(() => {
                            const numMoves = chess.history().length;

                            return (
                                <div className="pgn-navigation">
                                    <button
                                        onClick={() => setMoveIndex(0)}
                                        disabled={moveIndex === 0}
                                    >
                                        |&lt;
                                    </button>
                                    <button
                                        onClick={() => setMoveIndex(prev => Math.max(prev - 1, 0))}
                                        disabled={moveIndex === 0}
                                    >
                                        &lt;
                                    </button>
                                    <button
                                        onClick={() => setMoveIndex(prev => Math.min(prev + 1, numMoves))}
                                        disabled={moveIndex === numMoves}
                                    >
                                        &gt;
                                    </button>
                                    <button
                                        onClick={() => setMoveIndex(numMoves)}
                                        disabled={moveIndex >= numMoves}
                                    >
                                        &gt;|
                                    </button>
                                </div>
                            );
                        })()}
                    </div>

                    <div className="pgn-wrapper">
                        <PgnControl
                            pgn={pgn}
                            onClickMove={(fen) => {
                                // Find the move in the history and set the index
                                const moveIdx = mapFenToMoveIndex(fen);
                                if (moveIdx !== -1) {
                                    setMoveIndex(moveIdx);
                                }
                            }}
                            onLeavePgn={() => {
                            }}
                            selectedFen={fen}
                            onRightClickMove={handleRightClickMove}
                        />
                    </div>
                </div>
            </div>

            {contextMenu.show && (
                <div
                    style={{
                        position: 'absolute',
                        top: contextMenu.y,
                        left: contextMenu.x,
                        background: 'white',
                        border: '1px solid black',
                        zIndex: 999
                    }}
                >
                    <div
                        style={{ padding: '8px', cursor: 'pointer' }}
                        onClick={(e) => {
                            e.stopPropagation(); // prevent handlePageClick from firing
                            handleDeleteFromHere();
                        }}
                    >
                        Delete from here
                    </div>
                </div>
            )}
        </div>
    );
};

export default VariantPage;
