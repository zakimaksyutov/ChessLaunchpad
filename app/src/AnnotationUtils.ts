import { Annotation } from './Annotation';
import { DrawShape } from 'chessground/draw';
import { Key } from 'chessground/types';

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

export function convertDrawShapesToAnnotations(shapes: DrawShape[]): Annotation[] {
    // Map from Lichess brush to internal brush
    const brushMap: Record<string, Annotation['brush']> = {
        green: 'G',
        yellow: 'Y',
        red: 'R',
        blue: 'B'
    };

    return shapes
        .map((shape) => {
            const mappedBrush = shape.brush ? brushMap[shape.brush] : undefined;
            // If there's no valid brush mapping, skip this shape
            if (!mappedBrush) {
                return null;
            }

            // Convert to an Annotation
            return {
                brush: mappedBrush,
                orig: shape.orig,   // Square of origin
                dest: shape.dest    // Optional square of destination
            } as Annotation;
        })
        .filter((annotation): annotation is Annotation => annotation !== null);
}

export function convertAnnotationsToDrawShapes(annotations: Annotation[]): DrawShape[] {
    // Map from internal brush to Lichess brush
    const brushMap: Record<Annotation['brush'], string> = {
        G: 'green',
        Y: 'yellow',
        R: 'red',
        B: 'blue'
    };

    return annotations.map((annotation) => {
        const brush = brushMap[annotation.brush];
        return {
            brush,
            orig: annotation.orig as Key,
            dest: annotation.dest as Key
        };
    });
}