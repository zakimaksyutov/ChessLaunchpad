// BadgeRow.tsx — FSRSv2 version
import React, { useState, useEffect, useRef } from 'react';
import './BadgeRow.css';

interface BadgeRowProps {
    reviewCount: number;
    learningCount: number;
    newCount: number;
    reviewedToday: number;
    /** Incremented each time the "+1" pop animation should fire. */
    animationTrigger?: number;
}

const BadgeRow: React.FC<BadgeRowProps> = ({ reviewCount, learningCount, newCount, reviewedToday, animationTrigger = 0 }) => {
    const prevTriggerRef = useRef(animationTrigger);
    const [animKey, setAnimKey] = useState(0);

    useEffect(() => {
        if (animationTrigger > prevTriggerRef.current) {
            setAnimKey(k => k + 1);
        }
        prevTriggerRef.current = animationTrigger;
    }, [animationTrigger]);

    // Track decreases in count badges for "-1" animation
    const prevReviewRef = useRef(reviewCount);
    const prevLearningRef = useRef(learningCount);
    const prevNewRef = useRef(newCount);
    const [reviewAnimKey, setReviewAnimKey] = useState(0);
    const [learningAnimKey, setLearningAnimKey] = useState(0);
    const [newAnimKey, setNewAnimKey] = useState(0);

    useEffect(() => {
        if (reviewCount < prevReviewRef.current) {
            setReviewAnimKey(k => k + 1);
        }
        prevReviewRef.current = reviewCount;
    }, [reviewCount]);

    useEffect(() => {
        if (learningCount < prevLearningRef.current) {
            setLearningAnimKey(k => k + 1);
        }
        prevLearningRef.current = learningCount;
    }, [learningCount]);

    useEffect(() => {
        if (newCount < prevNewRef.current) {
            setNewAnimKey(k => k + 1);
        }
        prevNewRef.current = newCount;
    }, [newCount]);

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

    const renderBadge = (label: React.ReactNode, value: React.ReactNode, backgroundColor: string, badgeAnimKey?: number, badgeKey?: string) => {
        const finalStyle: React.CSSProperties = {
            ...rightPartStyle,
            backgroundColor,
        };

        if (badgeAnimKey !== undefined && badgeKey) {
            return (
                <div className="badge-count-wrapper" key={`${badgeKey}-${badgeAnimKey}`}>
                    <div
                        style={{ display: 'inline-flex' }}
                        className={badgeAnimKey > 0 ? 'badge-count-pop' : undefined}
                    >
                        <span style={leftPartStyle}>{label}</span>
                        <span style={finalStyle}>{value}</span>
                    </div>
                    {badgeAnimKey > 0 && (
                        <span className="badge-minus-one" style={{ color: backgroundColor }}>−1</span>
                    )}
                </div>
            );
        }

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
            {renderBadge('review', reviewCount.toString(), '#3b82f6', reviewAnimKey, 'review')}
            {renderBadge('learning', learningCount.toString(), '#06b6d4', learningAnimKey, 'learning')}
            {renderBadge('new', newCount.toString(), '#8b5cf6', newAnimKey, 'new')}
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
