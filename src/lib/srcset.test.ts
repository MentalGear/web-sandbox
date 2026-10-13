import { describe, it, expect } from 'vitest';
import { srcsetCandidates } from './srcset';

const urls = (value: string) => srcsetCandidates(value).map(c => c.url);

describe('srcsetCandidates: the URLs of a srcset, as the HTML standard splits them', () => {
    it.each([
        ['a.png', ['a.png']],
        ['a.png 1x', ['a.png']],
        ['a.png 1x, b.png 2x', ['a.png', 'b.png']],
        ['a.png 100w, b.png 200w', ['a.png', 'b.png']],
        ['a.png 1x,b.png 2x', ['a.png', 'b.png']], // a comma after a descriptor ends the candidate
        ['a.png 100w 50h, b.png', ['a.png', 'b.png']],
        ['  a.png  1x  ,  b.png  ', ['a.png', 'b.png']],
        ['\ta.png\n1x,\fb.png\r2x', ['a.png', 'b.png']], // every ASCII whitespace
        ['img/a.png 1x, ../b.png 2x, /c.png 3x', ['img/a.png', '../b.png', '/c.png']],
    ])('%j', (value, expected) => {
        expect(urls(value)).toEqual(expected);
    });

    it('a comma inside a URL belongs to it; trailing commas end the candidate and are not part of it', () => {
        expect(urls('a,b.png 1x')).toEqual(['a,b.png']);
        expect(urls('a.png,b.png')).toEqual(['a.png,b.png']); // no whitespace: one URL
        expect(urls('a.png, b.png')).toEqual(['a.png', 'b.png']);
        expect(urls('a.png,,, b.png')).toEqual(['a.png', 'b.png']);
        expect(urls('data:image/png;base64,AAAA 1x, b.png 2x')).toEqual(['data:image/png;base64,AAAA', 'b.png']);
    });

    it('a comma inside descriptor parentheses does not end the candidate', () => {
        expect(urls('a.png 1x (x, y), b.png')).toEqual(['a.png', 'b.png']);
        expect(urls('a.png (x, y, b.png)')).toEqual(['a.png']);
        expect(urls('a.png (unclosed, b.png')).toEqual(['a.png']);
    });

    it.each(['', '   ', ',', ', ,', ',,,', ' , \t, '])('empty candidates are skipped: %j has none', (value) => {
        expect(urls(value)).toEqual([]);
    });

    it('skips leading commas and empty candidates between others', () => {
        expect(urls(',,a.png, , ,b.png,')).toEqual(['a.png', 'b.png']);
    });

    it('a non-ASCII space is not whitespace: it is part of the URL', () => {
        expect(urls('a\u00A0b.png 1x')).toEqual(['a\u00A0b.png']);
    });

    it('offsets name the URL exactly within the value, so a replacement keeps every descriptor and comma', () => {
        const value = ' , a.png 1x,  b,c.png  2x , d.png,, e.png (1, 2)';
        const candidates = srcsetCandidates(value);
        expect(candidates.map(c => value.slice(c.start, c.end))).toEqual(['a.png', 'b,c.png', 'd.png', 'e.png']);
        expect(candidates.map(c => c.url)).toEqual(['a.png', 'b,c.png', 'd.png', 'e.png']);
        let rewritten = '';
        let at = 0;
        for (const c of candidates) { rewritten += value.slice(at, c.start) + 'X'; at = c.end; }
        rewritten += value.slice(at);
        expect(rewritten).toBe(' , X 1x,  X  2x , X,, X (1, 2)');
        expect(urls(rewritten)).toEqual(['X', 'X', 'X', 'X']); // the same candidates, each replaced
    });
});
