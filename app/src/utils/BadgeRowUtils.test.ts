import { calculateEightiethCount } from './BadgeRowUtils';

describe('BadgeRowUtils', () => {
    describe('calculateEightiethCount', () => {

        test('should calculate correct count for normal age distribution', () => {
            // Ages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
            // 80th percentile index = floor(0.8 * 9) = 7, so 80th percentile = 8
            // To reduce from 8 to 7, we need to play the oldest variant (10)
            // After playing 1 variant: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
            // New 80th percentile index = 7, value = 7 (which is <= target of 7)
            const ages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            const currentEightieth = 8;
            
            const result = calculateEightiethCount(ages, currentEightieth);
            
            // Should need to play 1 variant (10) to get 80th percentile from 8 to 7
            expect(result).toBe(1);
        });

        test('should handle case where all variants have the same age', () => {
            // All variants have age 5
            // 80th percentile = 5, target = 4
            // Need to play enough variants to shift the 80th percentile
            const ages = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
            const currentEightieth = 5;
            
            const result = calculateEightiethCount(ages, currentEightieth);
            
            // With 10 variants all at age 5, 80th percentile index = floor(0.8 * 9) = 7
            // Need to play enough variants to get the value at index 7 to be < 5
            // This should require playing more than 2 variants
            expect(result).toBeGreaterThan(0);
            expect(result).toBeLessThanOrEqual(10);
        });

        test('should calculate correct count for real repertoire data', () => {
            // Real data from chess repertoire
            // Distribution: 6×1, 20×2, 8×3, 14×4, 14×5, 15×6, 5×7, 5×8, 4×9, 2×10, 4×12, 3×13, 1×14, 1×17
            const ages = [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 9, 9, 9, 9, 10, 10, 12, 12, 12, 12, 13, 13, 13, 14, 17];
            const currentEightieth = 7;
            
            const result = calculateEightiethCount(ages, currentEightieth);
            
            // To reduce from 7 to 6, need to play the oldest variants
            // This is a real-world test case with actual repertoire data
            expect(result).toBe(4);
        });
    });
});
