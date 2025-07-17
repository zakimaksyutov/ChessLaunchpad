/**
 * Utility functions for badge calculations in BadgeRow component
 */

/**
 * Calculates how many variants need to be played (reset to age 0) to reduce 
 * the 80th percentile age by at least 1 day.
 * 
 * @param ages Array of variant ages
 * @param currentEightieth The current 80th percentile value
 * @returns Number of variants that need to be played
 */
export const calculateEightiethCount = (ages: number[], currentEightieth: number): number => {
    if (currentEightieth <= 1) return 0; // Can't reduce further
    
    const sortedAges = [...ages].sort((a, b) => a - b);
    const targetAge = currentEightieth - 1;
    
    let count = 0;
    const modifiedAges = [...sortedAges];
    
    while (modifiedAges.length > 0) {
        const currentRankIndex = Math.floor(0.8 * (modifiedAges.length - 1));
        const current80th = modifiedAges[currentRankIndex];
        
        if (current80th <= targetAge) {
            break;
        }
        
        // Remove oldest variant and add age 0 at beginning
        modifiedAges.pop();
        modifiedAges.unshift(0);
        count++;
    }
    
    return count;
};
