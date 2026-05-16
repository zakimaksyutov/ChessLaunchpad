import { describe, it, expect } from 'vitest';
import { computeThreatLevel, type ThreatLevel } from './OpponentAnalysisDB';

describe('computeThreatLevel', () => {
    const cases: [number, ThreatLevel][] = [
        [0, 'low'],
        [1, 'low'],
        [2, 'low'],
        [3, 'moderate'],
        [5, 'moderate'],
        [9, 'moderate'],
        [10, 'high'],
        [15, 'high'],
        [24, 'high'],
        [25, 'very-high'],
        [50, 'very-high'],
        [100, 'very-high'],
    ];

    for (const [count, expected] of cases) {
        it(`returns "${expected}" for positionBeforeCount=${count}`, () => {
            expect(computeThreatLevel(count)).toBe(expected);
        });
    }
});
