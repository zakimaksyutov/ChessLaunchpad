import React, { useEffect, useState, useRef, useCallback } from 'react';
import ChessboardControl from './ChessboardControl';
import {
    CloudEvalResult,
    fetchCloudEvalCached,
    formatEval,
    formatMoveWithNumber,
} from './LichessCloudEvalService';

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
const ESTIMATED_POPOVER_HEIGHT = 550;

function computePosition(anchorRect: DOMRect): { top: number; left: number } {
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
    if (top + ESTIMATED_POPOVER_HEIGHT > window.innerHeight) {
        top = Math.max(0, window.innerHeight - ESTIMATED_POPOVER_HEIGHT - 8);
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
    return (
        <div className="analysis-popover-section">
            <div className="analysis-popover-section-header">{title}</div>
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
                    <div className="analysis-popover-depth">
                        depth {result.depth}
                    </div>
                </div>
            )}
        </div>
    );
};

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
    const popoverRef = useRef<HTMLDivElement>(null);
    const requestIdRef = useRef(0);

    // Fetch cloud evals when FENs change
    useEffect(() => {
        const thisRequest = ++requestIdRef.current;
        setPrevEval(null);
        setCurrEval(null);
        setPrevLoading(true);
        setCurrLoading(true);

        fetchCloudEvalCached(previousFen, MULTI_PV).then((result) => {
            if (requestIdRef.current === thisRequest) {
                setPrevEval(result);
                setPrevLoading(false);
            }
        });

        fetchCloudEvalCached(clickedFen, MULTI_PV).then((result) => {
            if (requestIdRef.current === thisRequest) {
                setCurrEval(result);
                setCurrLoading(false);
            }
        });
    }, [clickedFen, previousFen]);

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

    const { top, left } = computePosition(anchorRect);

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
