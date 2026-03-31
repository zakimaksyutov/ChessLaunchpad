import { Annotation } from './Annotation';
import type { Annotation as ChessControlAnnotation } from 'chess-control';

function isValidBrush(char: string): char is Annotation['brush'] {
    return char === 'G' || char === 'Y' || char === 'R' || char === 'B';
}

export function extractAnnotations(comment: string): Annotation[] {

    const annotations: Annotation[] = [];
    const calRegex = /\[%cal\s+([^\]]+)\]/g;
    const cslRegex = /\[%csl\s+([^\]]+)\]/g;

    let match: RegExpExecArray | null;

    // Extract colored arrows
    while ((match = calRegex.exec(comment)) !== null) {
        const arrows = match[1].split(',');
        arrows.forEach((arrow) => {
            const brushChar = arrow[0];
            const orig = arrow.slice(1, 3);
            const dest = arrow.slice(3, 5);

            // Only push if the brushChar is valid
            if (isValidBrush(brushChar)) {
                annotations.push({
                    brush: brushChar,
                    orig,
                    dest,
                });
            }
        });
    }

    // Extract colored squares
    while ((match = cslRegex.exec(comment)) !== null) {
        const squares = match[1].split(',');
        squares.forEach((square) => {
            const brushChar = square[0];
            const orig = square.slice(1, 3);

            // Only push if the brushChar is valid
            if (isValidBrush(brushChar)) {
                annotations.push({
                    brush: brushChar,
                    orig,
                });
            }
        });
    }

    return annotations;
}

export function serializeAnnotationsAsComment(annotations: Annotation[]): string {
    // Separate arrow vs. square annotations
    const arrowParts: string[] = [];
    const squareParts: string[] = [];

    annotations.forEach(annotation => {
        const { brush, orig, dest } = annotation;
        // If 'dest' is present, it's an arrow
        if (dest) {
            arrowParts.push(`${brush}${orig}${dest}`);
        } else {
            // Otherwise it's a colored square
            squareParts.push(`${brush}${orig}`);
        }
    });

    // Build up the optional cal/csl segments
    const calSegment = arrowParts.length > 0
        ? `[%cal ${arrowParts.join(',')}]`
        : '';
    const cslSegment = squareParts.length > 0
        ? `[%csl ${squareParts.join(',')}]`
        : '';

    // Combine them into a single comment string
    // Feel free to insert a space or line-break between segments
    const segments = [calSegment, cslSegment].filter(s => s.length > 0);
    return segments.join(' ');
}

export function convertChessControlAnnotationsToInternal(ccAnnotations: ChessControlAnnotation[]): Annotation[] {
    const colorMap: Record<string, Annotation['brush']> = {
        green: 'G',
        yellow: 'Y',
        red: 'R',
        blue: 'B'
    };

    return ccAnnotations
        .map((cc) => {
            const mappedBrush = colorMap[cc.color];
            if (!mappedBrush) {
                return null;
            }
            return {
                brush: mappedBrush,
                orig: cc.from,
                dest: cc.to
            } as Annotation;
        })
        .filter((annotation): annotation is Annotation => annotation !== null);
}

export function convertInternalToChessControlAnnotations(annotations: Annotation[]): ChessControlAnnotation[] {
    const colorMap: Record<Annotation['brush'], ChessControlAnnotation['color']> = {
        G: 'green',
        Y: 'yellow',
        R: 'red',
        B: 'blue'
    };

    return annotations.map((annotation) => ({
        color: colorMap[annotation.brush],
        from: annotation.orig,
        to: annotation.dest
    } as ChessControlAnnotation));
}