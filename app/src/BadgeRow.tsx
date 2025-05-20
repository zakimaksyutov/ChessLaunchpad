// BadgeRow.tsx
import React, { useMemo } from 'react';
import { RepertoireData } from './RepertoireData';

interface BadgeRowProps {
    repertoireData: RepertoireData | null;
}

const BadgeRow: React.FC<BadgeRowProps> = ({ repertoireData }) => {
    const wrapperStyle: React.CSSProperties = {
        display: 'flex',
        gap: '6px',
        marginBottom: '5px',
    };

    const leftPartStyle: React.CSSProperties = {
        backgroundColor: '#555',
        color: '#fff',
        padding: '1px 6px',
        paddingBottom: '2px',
        borderRadius: '4px 0 0 4px',
        fontSize: '0.8rem',
    };

    const rightPartStyle: React.CSSProperties = {
        backgroundColor: '#4c1',
        color: '#fff',
        padding: '1px 8px',
        paddingBottom: '2px',
        borderRadius: '0 4px 4px 0',
        fontSize: '0.8rem',
    };

    // Compute oldest, eightieth, and error counts from RepertoireData:
    const { oldest, eightieth, errorsCount, total, dailyCount } = useMemo(() => {
        if (!repertoireData || !repertoireData.data?.length) {
            return { oldest: 0, eightieth: 0, errorsCount: 0, total: 0, dailyCount: 0 };
        }

        const ages = repertoireData.data.map(v => repertoireData.currentEpoch - v.lastSucceededEpoch);
        ages.sort((a, b) => a - b);

        const maxAge = Math.max(...ages);
        const rankIndex = Math.floor(0.8 * (ages.length - 1));
        const percentile80 = ages[rankIndex];
        const total = ages.length;

        const errorCount = repertoireData.data.filter(v => v.errorEMA > 1).length;

        return {
            oldest: maxAge,
            eightieth: percentile80,
            errorsCount: errorCount,
            total: total,
            dailyCount: repertoireData.dailyPlayCount
        };
    }, [repertoireData]);

    // Helper to compute a gradient from green (minVal) to red (maxVal).
    // For example, getGradientColor(value, 6, 10) moves from green if value <= 6
    // to red if value >= 10 (and smoothly transitions in between).
    const getGradientColor = (value: number, minVal: number, maxVal: number): string => {
        // Clamp value to [minVal, maxVal].
        if (value <= minVal) return '#4c1'; // green
        if (value >= maxVal) return '#c00'; // red

        // Compute ratio for linear interpolation.
        const ratio = (value - minVal) / (maxVal - minVal);

        // Green (#4c1) = (76,193,1), Red (#c00) = (204,0,0)
        const greenRGB = [76, 193, 1];
        const redRGB = [204, 0, 0];
        const r = Math.round(greenRGB[0] + ratio * (redRGB[0] - greenRGB[0]));
        const g = Math.round(greenRGB[1] + ratio * (redRGB[1] - greenRGB[1]));
        const b = Math.round(greenRGB[2] + ratio * (redRGB[2] - greenRGB[2]));
        return `rgb(${r}, ${g}, ${b})`;
    };

    // Dynamic thresholds based on total number of variants
    const oldestMin = Math.ceil(total * 0.1);
    const oldestMax = Math.floor(total * 0.2);
    const eightiethMin = Math.ceil(total * 0.05);
    const eightiethMax = Math.floor(total * 0.1);
    const dailyCountMax = Math.ceil(total * 0.2);
    
    // Dynamic thresholds for errors badge
    const errorsMin = Math.ceil(total * 0.02);
    const errorsMax = Math.floor(total * 0.08);

    const oldestBgColor = useMemo(() => getGradientColor(oldest, oldestMin, oldestMax), [oldest, oldestMin, oldestMax]);
    const eightiethBgColor = useMemo(() => getGradientColor(eightieth, eightiethMin, eightiethMax), [eightieth, eightiethMin, eightiethMax]);
    const dailyCountBgColor = useMemo(() => getGradientColor(Math.max(0, dailyCountMax - dailyCount), 0, dailyCountMax), [dailyCount, dailyCountMax]);
    const errorsBgColor = useMemo(() => getGradientColor(errorsCount, errorsMin, errorsMax), [errorsCount, errorsMin, errorsMax]);

    const renderBadge = (label: React.ReactNode, value: string, backgroundColor?: string) => {
        const finalStyle: React.CSSProperties = {
            ...rightPartStyle,
            backgroundColor: backgroundColor ?? rightPartStyle.backgroundColor,
        };

        return (
            <div style={{ display: 'inline-flex' }}>
                <span style={leftPartStyle}>{label}</span>
                <span style={finalStyle}>{value}</span>
            </div>
        );
    };

    return (
        <div style={wrapperStyle}>
            {renderBadge('total', total.toString())}
            {renderBadge('oldest', oldest.toString(), oldestBgColor)}
            {renderBadge(<span>80<sup style={{ fontSize: '0.6em' }}>TH</sup></span>, eightieth.toString(), eightiethBgColor)}
            {renderBadge('errors', errorsCount.toString(), errorsBgColor)}
            {renderBadge('today', dailyCount.toString(), dailyCountBgColor)}
        </div>
    );
};

export default BadgeRow;
