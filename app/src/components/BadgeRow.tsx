// BadgeRow.tsx — FSRSv2 version
import React from 'react';

interface BadgeRowProps {
    reviewCount: number;
    learningCount: number;
    newCount: number;
    reviewedToday: number;
}

const BadgeRow: React.FC<BadgeRowProps> = ({ reviewCount, learningCount, newCount, reviewedToday }) => {

    const leftPartStyle: React.CSSProperties = {
        backgroundColor: '#555',
        color: '#fff',
        padding: '1px 6px',
        paddingBottom: '2px',
        borderRadius: '4px 0 0 4px',
        fontSize: '0.8rem',
    };

    const rightPartStyle: React.CSSProperties = {
        color: '#fff',
        padding: '1px 8px',
        paddingBottom: '2px',
        borderRadius: '0 4px 4px 0',
        fontSize: '0.8rem',
    };

    const renderBadge = (label: React.ReactNode, value: React.ReactNode, backgroundColor: string) => {
        const finalStyle: React.CSSProperties = {
            ...rightPartStyle,
            backgroundColor,
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
            {renderBadge('review', reviewCount.toString(), '#3b82f6')}
            {renderBadge('learning', learningCount.toString(), '#06b6d4')}
            {renderBadge('new', newCount.toString(), '#22c55e')}
            {renderBadge('today', reviewedToday.toString(), '#8b5cf6')}
        </div>
    );
};

export default BadgeRow;
