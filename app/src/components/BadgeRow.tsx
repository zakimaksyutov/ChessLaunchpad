// BadgeRow.tsx — FSRSv2 version
import React from 'react';

interface BadgeRowProps {
    dueCount: number;
    reviewedToday: number;
    totalCards: number;
}

const BadgeRow: React.FC<BadgeRowProps> = ({ dueCount, reviewedToday, totalCards }) => {

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

    const getDueBgColor = (): string => {
        if (dueCount === 0) return '#4c1'; // green — all done
        const ratio = Math.min(dueCount / Math.max(totalCards * 0.2, 1), 1);
        const r = Math.round(76 + ratio * (204 - 76));
        const g = Math.round(193 - ratio * 193);
        const b = Math.round(1 - ratio);
        return `rgb(${r}, ${g}, ${b})`;
    };

    const getReviewedBgColor = (): string => {
        if (totalCards === 0) return '#4c1';
        const target = Math.ceil(totalCards * 0.2);
        const ratio = Math.min(reviewedToday / Math.max(target, 1), 1);
        const r = Math.round(204 - ratio * (204 - 76));
        const g = Math.round(ratio * 193);
        const b = Math.round(ratio);
        return `rgb(${r}, ${g}, ${b})`;
    };

    const renderBadge = (label: React.ReactNode, value: React.ReactNode, backgroundColor?: string) => {
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
        <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: '0.4rem',
            margin: '0',
            marginBottom: '0.4rem',
            maxWidth: '100%',
            paddingBottom: '0'
        }}>
            {renderBadge('due', dueCount.toString(), getDueBgColor())}
            {renderBadge('today', reviewedToday.toString(), getReviewedBgColor())}
            {renderBadge('total', totalCards.toString())}
        </div>
    );
};

export default BadgeRow;
