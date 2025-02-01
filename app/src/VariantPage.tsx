import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import ChessboardControl from './ChessboardControl';
import { Chess, Move } from 'chess.js';
import PgnControl from './PgnControl';
import './VariantPage.css';

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
    const [fen, setFen] = useState<string>(chess.fen());
    const [moveIndex, setMoveIndex] = useState<number>(0);

    // On mount (or if initialPgn changes in edit mode), load the PGN into chess
    useEffect(() => {
        chess.reset();
        if (initialPgn) {
            chess.loadPgn(initialPgn);
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

    // Called by "Save"
    // In a real app, you would call your DAL to store the variant, then navigate back to repertoire.
    const handleSave = () => {
        // If in new mode, we would create a new variant in the backend.
        // If in edit mode, we would update the existing variant in the backend.

        // For now, just show a placeholder alert and go back.
        alert(`Saving Variant:\nOrientation: ${orientation}\nPGN: ${pgn}`);
        navigate('/repertoire');
    };

    // Called by "Cancel"
    // In a real app, just navigate back or show a discard-changes confirmation.
    const handleCancel = () => {
        navigate('/repertoire');
    };

    // Render
    return (
        <div className="variant-page">
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
                                const moves = chess.history({ verbose: true }) as Move[];
                                const newChess = new Chess();
                                for (let i = 0; i < moves.length; i++) {
                                    newChess.move(moves[i]);
                                    if (newChess.fen() === fen) {
                                        setMoveIndex(i + 1);
                                        break;
                                    }
                                }
                            }}
                            onLeavePgn={() => {
                            }}
                            selectedFen={fen}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default VariantPage;
