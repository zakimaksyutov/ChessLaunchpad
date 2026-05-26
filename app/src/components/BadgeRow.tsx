// BadgeRow.tsx — FSRSv2 version
import React, { useState, useEffect, useRef } from 'react';
import './BadgeRow.css';

interface BadgeRowProps {
    reviewCount: number;
    learningCount: number;
    newCount: number;
    reviewedToday: number;
}

const BadgeRow: React.FC<BadgeRowProps> = ({ reviewCount, learningCount, newCount, reviewedToday }) => {
    const prevReviewedRef = useRef(reviewedToday);
    const [animKey, setAnimKey] = useState(0);

    useEffect(() => {
        if (reviewedToday > prevReviewedRef.current) {
            setAnimKey(k => k + 1);
        }
        prevReviewedRef.current = reviewedToday;
    }, [reviewedToday]);

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
            {renderBadge('new', newCount.toString(), '#8b5cf6')}
            <div className="badge-today-wrapper" key={`today-${animKey}`}>
                <div
                    style={{ display: 'inline-flex' }}
                    className={animKey > 0 ? 'badge-today-pop' : undefined}
                >
                    <span style={leftPartStyle}>today</span>
                    <span style={{ ...rightPartStyle, backgroundColor: '#22c55e' }}>
                        {reviewedToday}
                    </span>
                </div>
                {animKey > 0 && <span className="badge-plus-one">+1</span>}
            </div>
        </div>
    );
};

export default BadgeRow;
