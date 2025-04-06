// BadgeRow.tsx
import React, { useMemo } from 'react';
import { RepertoireData } from './RepertoireData';

interface BadgeRowProps {
    repertoireData: RepertoireData | null;
}

const BadgeRow: React.FC<BadgeRowProps> = ({ repertoireData }) => {
    const wrapperStyle: React.CSSProperties = {
        display: 'flex',
        gap: '8px',
        marginBottom: '5px',
    };

    const leftPartStyle: React.CSSProperties = {
        backgroundColor: '#555',
        color: '#fff',
        padding: '1px 8px',
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
    const { oldest, eightieth, errorsCount } = useMemo(() => {
        if (!repertoireData || !repertoireData.data?.length) {
            return { oldest: 0, eightieth: 0, errorsCount: 0 };
        }

        const ages = repertoireData.data.map(v => repertoireData.currentEpoch - v.lastSucceededEpoch);
        ages.sort((a, b) => a - b);

        const maxAge = Math.max(...ages);
        const rankIndex = Math.floor(0.8 * (ages.length - 1));
        const percentile80 = ages[rankIndex];

        const errorCount = repertoireData.data.filter(v => v.errorEMA > 2).length;

        return {
            oldest: maxAge,
            eightieth: percentile80,
            errorsCount: errorCount
        };
    }, [repertoireData]);

    const renderBadge = (label: React.ReactNode, value: string, isError?: boolean) => {
        const adjustedRightPartStyle = isError
            ? { ...rightPartStyle, backgroundColor: '#FF8C00' }
            : rightPartStyle;

        return (
            <div style={{ display: 'inline-flex' }}>
                <span style={leftPartStyle}>{label}</span>
                <span style={adjustedRightPartStyle}>{value}</span>
            </div>
        );
    };

    return (
        <div style={wrapperStyle}>
            {renderBadge('oldest', oldest.toString())}
            {renderBadge(<span>80<sup style={{ fontSize: '0.6em' }}>TH</sup></span>, eightieth.toString())}
            {renderBadge('errors', errorsCount.toString(), true)}
        </div>
    );
};

export default BadgeRow;
