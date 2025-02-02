import { extractAnnotations } from './AnnotationUtils';
import { Annotation } from './Annotation';

describe('extractAnnotations', () => {

    it('returns an empty array if the comment has no annotation markers', () => {
        const comment = 'This is a simple comment with no chess annotations.';
        const result = extractAnnotations(comment);
        expect(result).toEqual([]);
    });

    it('extracts a single arrow (from a [%cal ...] marker)', () => {
        const comment = 'Some text [%cal Gc1c5] some more text';
        const result = extractAnnotations(comment);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual<Annotation>({
            brush: 'G',
            orig: 'c1',
            dest: 'c5'
        });
    });

    it('extracts multiple arrows from one [%cal ...] block', () => {
        const comment = 'Comment [%cal Yb2b4,Rc3c7,Gh2h3] trailing text';
        const result = extractAnnotations(comment);
        expect(result).toHaveLength(3);

        // 1) Yb2b4
        expect(result[0]).toEqual<Annotation>({
            brush: 'Y',
            orig: 'b2',
            dest: 'b4'
        });
        // 2) Rc3c7
        expect(result[1]).toEqual<Annotation>({
            brush: 'R',
            orig: 'c3',
            dest: 'c7'
        });
        // 3) Gh2h3
        expect(result[2]).toEqual<Annotation>({
            brush: 'G',
            orig: 'h2',
            dest: 'h3'
        });
    });

    it('extracts arrows from multiple [%cal ...] tags in the same comment', () => {
        const comment = 'Some text [%cal Bc2c4] more text [%cal Yb7b8,Gf2f3]';
        const result = extractAnnotations(comment);
        expect(result).toHaveLength(3);

        // First annotation block
        expect(result[0]).toEqual<Annotation>({
            brush: 'B',
            orig: 'c2',
            dest: 'c4'
        });
        // Second annotation block (Yb7b8)
        expect(result[1]).toEqual<Annotation>({
            brush: 'Y',
            orig: 'b7',
            dest: 'b8'
        });
        // Second annotation block (Gf2f3)
        expect(result[2]).toEqual<Annotation>({
            brush: 'G',
            orig: 'f2',
            dest: 'f3'
        });
    });

    it('extracts a single square highlight (from a [%csl ...] marker)', () => {
        const comment = 'Testing squares [%csl Gb2] done.';
        const result = extractAnnotations(comment);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual<Annotation>({
            brush: 'G',
            orig: 'b2'
        });
    });

    it('extracts multiple squares from a single [%csl ...] tag', () => {
        const comment = 'Squares [%csl Gb2,Yc3,Rh7] test end';
        const result = extractAnnotations(comment);
        expect(result).toHaveLength(3);

        expect(result[0]).toEqual<Annotation>({
            brush: 'G',
            orig: 'b2'
        });
        expect(result[1]).toEqual<Annotation>({
            brush: 'Y',
            orig: 'c3'
        });
        expect(result[2]).toEqual<Annotation>({
            brush: 'R',
            orig: 'h7'
        });
    });

    it('extracts both arrows (cal) and squares (csl) if present in the same comment', () => {
        const comment = 'Comment [%cal Gc1c5] and squares [%csl Ye4,Rd5] done.';
        const result = extractAnnotations(comment);
        // Expect 1 arrow + 2 squares
        expect(result).toHaveLength(3);

        // Arrow
        expect(result[0]).toEqual<Annotation>({
            brush: 'G',
            orig: 'c1',
            dest: 'c5'
        });
        // Square (Ye4)
        expect(result[1]).toEqual<Annotation>({
            brush: 'Y',
            orig: 'e4'
        });
        // Square (Rd5)
        expect(result[2]).toEqual<Annotation>({
            brush: 'R',
            orig: 'd5'
        });
    });

    it('returns an empty array if the annotation syntax is incomplete or malformed', () => {
        // Missing the closing bracket
        const comment = 'Check out this arrow [%cal Gc2c4 some random text no bracket';
        const result = extractAnnotations(comment);
        expect(result).toEqual([]);
    });

    it('parses multiple sets of brackets ignoring invalid ones', () => {
        const comment = `
      Here is a valid cal: [%cal Gb2b4]
      Here is an invalid csl: [%cslX Gb2]
      Here is a valid csl: [%csl Yf3]
    `;
        // The middle bracket is not recognized because it's [%cslX ...], not [%csl ...].
        const result = extractAnnotations(comment);

        // Expecting 1 arrow + 1 square
        expect(result).toHaveLength(2);

        expect(result[0]).toEqual<Annotation>({
            brush: 'G',
            orig: 'b2',
            dest: 'b4'
        });

        expect(result[1]).toEqual<Annotation>({
            brush: 'Y',
            orig: 'f3'
        });
    });

});
