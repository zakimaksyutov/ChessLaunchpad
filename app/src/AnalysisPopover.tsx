import React, { useEffect, useState, useRef, useCallback, useLayoutEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ChessboardControl from './ChessboardControl';
import {
    CloudEvalResult,
    fetchCloudEvalCached,
    formatEval,
    formatMoveWithNumber,
} from './LichessCloudEvalService';
import {
    MastersExplorerResult,
    fetchMastersExplorerCached,
    formatGameCount,
} from './LichessMastersService';
import { useLichessAuth } from './LichessAuthContext';

interface AnalysisPopoverProps {
    clickedFen: string;
    previousFen: string;
    playedMoveSan: string;
    orientation: 'white' | 'black';
    anchorRect: DOMRect;
    onClose: () => void;
}

const POPOVER_WIDTH = 310;
const BOARD_SIZE = 250;
const MULTI_PV = 5;
const ESTIMATED_POPOVER_HEIGHT = 600;

function computePosition(anchorRect: DOMRect, popoverHeight: number): { top: number; left: number } {
    const offset = 8;
    let left = anchorRect.right + offset;
    let top = anchorRect.top;

    // If it goes off the right edge, try left side of anchor
    if (left + POPOVER_WIDTH > window.innerWidth) {
        left = anchorRect.left - POPOVER_WIDTH - offset;
    }
    // If still off-screen, clamp to right edge
    if (left < 0) {
        left = Math.max(0, window.innerWidth - POPOVER_WIDTH - 8);
    }
    // If the popover would go below the viewport, shift it up
    const height = Math.max(popoverHeight, ESTIMATED_POPOVER_HEIGHT);
    if (top + height > window.innerHeight) {
        top = Math.max(0, window.innerHeight - height - 8);
    }
    if (top < 0) top = 0;

    return { top, left };
}

interface EvalSectionProps {
    title: string;
    fen: string;
    result: CloudEvalResult | null;
    loading: boolean;
    highlightMoveSan?: string;
}

const EvalSection: React.FC<EvalSectionProps> = ({ title, fen, result, loading, highlightMoveSan }) => {
    const depthLabel = !loading && result && result.pvs.length > 0
        ? ` (depth ${result.depth})`
        : '';
    return (
        <div className="analysis-popover-section">
            <div className="analysis-popover-section-header">
                {title}
                {depthLabel && <span className="analysis-popover-depth">{depthLabel}</span>}
            </div>
            {loading && (
                <div className="analysis-popover-loading">Loading…</div>
            )}
            {!loading && !result && (
                <div className="analysis-popover-no-data">No cloud eval available</div>
            )}
            {!loading && result && result.pvs.length === 0 && (
                <div className="analysis-popover-no-data">No moves found</div>
            )}
            {!loading && result && result.pvs.length > 0 && (
                <div className="analysis-popover-moves">
                    {result.pvs.map((pv, idx) => {
                        const isHighlighted = highlightMoveSan !== undefined && pv.moveSan === highlightMoveSan;
                        const moveDisplay = formatMoveWithNumber(fen, pv.moveSan);
                        const evalDisplay = formatEval(pv.cp, pv.mate);
                        return (
                            <div
                                key={idx}
                                className={`analysis-popover-move-row ${isHighlighted ? 'highlighted' : ''}`}
                            >
                                <span className="analysis-popover-move-san">{moveDisplay}</span>
                                <span className="analysis-popover-move-eval">{evalDisplay}</span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

interface MastersSectionProps {
    fen: string;
    result: MastersExplorerResult | null;
    loading: boolean;
    highlightMoveSan?: string;
}

const MastersSection: React.FC<MastersSectionProps> = ({ fen, result, loading, highlightMoveSan }) => {
    const totalLabel = !loading && result && result.moves.length > 0
        ? ` (${formatGameCount(result.totalGames)})`
        : '';
    return (
        <div className="analysis-popover-section">
            <div className="analysis-popover-section-header">
                Master Games
                {totalLabel && <span className="analysis-popover-depth">{totalLabel}</span>}
            </div>
            {loading && (
                <div className="analysis-popover-loading">Loading…</div>
            )}
            {!loading && !result && (
                <div className="analysis-popover-no-data">No master games found</div>
            )}
            {!loading && result && result.moves.length === 0 && (
                <div className="analysis-popover-no-data">No master games found</div>
            )}
            {!loading && result && result.moves.length > 0 && (
                <div className="masters-moves">
                    {result.moves.map((move, idx) => {
                        const isHighlighted = highlightMoveSan !== undefined && move.san === highlightMoveSan;
                        const moveDisplay = formatMoveWithNumber(fen, move.san);
                        return (
                            <div
                                key={idx}
                                className={`masters-move-row ${isHighlighted ? 'highlighted' : ''}`}
                            >
                                <span className="masters-move-san">{moveDisplay}</span>
                                <span className="masters-move-games">{formatGameCount(move.totalGames)}</span>
                                <div className="masters-result-bar" title={`${move.whitePercent}% / ${move.drawPercent}% / ${move.blackPercent}%`}>
                                    <div className="masters-bar-white" style={{ width: `${move.whitePercent}%` }} />
                                    <div className="masters-bar-draw" style={{ width: `${move.drawPercent}%` }} />
                                    <div className="masters-bar-black" style={{ width: `${move.blackPercent}%` }} />
                                </div>
                                <span className="masters-move-rating">{move.averageRating}</span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

interface MastersConnectPromptProps {
    onNavigateToSettings: () => void;
}

const MastersConnectPrompt: React.FC<MastersConnectPromptProps> = ({ onNavigateToSettings }) => (
    <div className="analysis-popover-section">
        <div className="analysis-popover-section-header">Master Games</div>
        <div className="masters-connect-prompt">
            <a href="#" onClick={(e) => { e.preventDefault(); onNavigateToSettings(); }}>
                Connect Lichess
            </a>
            {' '}for master game statistics
        </div>
    </div>
);

const AnalysisPopover: React.FC<AnalysisPopoverProps> = ({
    clickedFen,
    previousFen,
    playedMoveSan,
    orientation,
    anchorRect,
    onClose,
}) => {
    const [prevEval, setPrevEval] = useState<CloudEvalResult | null>(null);
    const [currEval, setCurrEval] = useState<CloudEvalResult | null>(null);
    const [prevLoading, setPrevLoading] = useState(true);
    const [currLoading, setCurrLoading] = useState(true);
    const [mastersResult, setMastersResult] = useState<MastersExplorerResult | null>(null);
    const [mastersLoading, setMastersLoading] = useState(true);
    const popoverRef = useRef<HTMLDivElement>(null);
    const evalRequestIdRef = useRef(0);
    const mastersRequestIdRef = useRef(0);

    const { connected, token } = useLichessAuth();
    const navigate = useNavigate();

    // Fetch cloud evals when FENs change
    useEffect(() => {
        const thisRequest = ++evalRequestIdRef.current;
        setPrevEval(null);
        setCurrEval(null);
        setPrevLoading(true);
        setCurrLoading(true);

        fetchCloudEvalCached(previousFen, MULTI_PV).then((result) => {
            if (evalRequestIdRef.current === thisRequest) {
                setPrevEval(result);
                setPrevLoading(false);
            }
        });

        fetchCloudEvalCached(clickedFen, MULTI_PV).then((result) => {
            if (evalRequestIdRef.current === thisRequest) {
                setCurrEval(result);
                setCurrLoading(false);
            }
        });
    }, [clickedFen, previousFen]);

    // Fetch masters explorer when FEN or token changes
    useEffect(() => {
        if (!token) {
            setMastersResult(null);
            setMastersLoading(false);
            return;
        }

        const thisRequest = ++mastersRequestIdRef.current;
        setMastersResult(null);
        setMastersLoading(true);

        fetchMastersExplorerCached(previousFen, token).then((result) => {
            if (mastersRequestIdRef.current === thisRequest) {
                setMastersResult(result);
                setMastersLoading(false);
            }
        });
    }, [previousFen, token]);

    // Click-away dismissal
    const handleClickOutside = useCallback((e: MouseEvent) => {
        if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
            onClose();
        }
    }, [onClose]);

    // Escape key dismissal
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            onClose();
        }
    }, [onClose]);

    useEffect(() => {
        // Delay adding click listener to avoid immediately closing from the same click
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside);
        }, 0);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [handleClickOutside, handleKeyDown]);

    // Dynamically reposition after content loads/changes
    const [measuredHeight, setMeasuredHeight] = useState(0);
    useLayoutEffect(() => {
        if (popoverRef.current) {
            setMeasuredHeight(popoverRef.current.scrollHeight);
        }
    }, [prevEval, currEval, prevLoading, currLoading, mastersResult, mastersLoading]);

    const { top, left } = computePosition(anchorRect, measuredHeight);

    return (
        <div
            ref={popoverRef}
            className="analysis-popover"
            style={{
                position: 'fixed',
                left,
                top,
                width: POPOVER_WIDTH,
                maxHeight: '90vh',
                overflowY: 'auto',
                zIndex: 9999,
            }}
        >
            <div style={{ width: BOARD_SIZE, height: BOARD_SIZE, margin: '0 auto' }}>
                <ChessboardControl
                    roundId="analysis-preview-board"
                    fen={clickedFen}
                    orientation={orientation}
                    movePlayed={() => false}
                    interactive={false}
                />
            </div>

            {connected ? (
                <MastersSection
                    fen={previousFen}
                    result={mastersResult}
                    loading={mastersLoading}
                    highlightMoveSan={playedMoveSan}
                />
            ) : (
                <MastersConnectPrompt onNavigateToSettings={() => {
                    onClose();
                    navigate('/settings');
                }} />
            )}

            <EvalSection
                title="Alternatives"
                fen={previousFen}
                result={prevEval}
                loading={prevLoading}
                highlightMoveSan={playedMoveSan}
            />

            <EvalSection
                title="Top moves"
                fen={clickedFen}
                result={currEval}
                loading={currLoading}
            />
        </div>
    );
};

export default AnalysisPopover;
