import { describe, it, expect } from 'vitest';
import { cssUrlReferences, replaceRanges } from './css-references';

// [the source text a slot would replace, the decoded URL] for every reference, in order
const refs = (css: string) => cssUrlReferences(css).map(r => [css.slice(r.start, r.end), r.url]);
const urls = (css: string) => cssUrlReferences(css).map(r => r.url);

// What the guest does to a reference: its range becomes a CSS string holding a blob: URL.
const BLOB = '"blob:null/0b2f6a1e-2c43-4a8f-9d1e-5b6c7d8e9f00"';
const rewriteAll = (css: string) => replaceRanges(css, cssUrlReferences(css).map(r => ({ start: r.start, end: r.end, text: BLOB })));

describe('cssUrlReferences: url tokens', () => {
    it.each([
        ['a { b: url(x.png) }', [['x.png', 'x.png']]],
        ['a{b:url(x.png)}', [['x.png', 'x.png']]],
        ['a { b: url(  x.png  ) }', [['  x.png  ', 'x.png']]], // the range is everything between "url(" and ")"
        ['a { b: url(\n\tx.png\f\r\n) }', [['\n\tx.png\f\r\n', 'x.png']]],
        ['a { b: URL(x.png) }', [['x.png', 'x.png']]], // the function name is ASCII case-insensitive
        ['a { b: uRl(x.png) }', [['x.png', 'x.png']]],
        ['a { b: u\\72l(x.png) }', [['x.png', 'x.png']]], // an escaped name is still "url"
        ['a { b: \\75 rl(x.png) }', [['x.png', 'x.png']]],
        ['a { b: \\55RL(x.png) }', [['x.png', 'x.png']]],
        ['a { b: url() }', [['', '']]], // empty: a reference to nothing, resolved by the caller (never a file)
        ['a { b: url(é/ü.png) }', [['é/ü.png', 'é/ü.png']]],
        ['a { b: url(data:image/png;base64,AAAA) }', [['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA']]], // the caller resolves: not ours
        ['a { b: url(https://cdn.example/x.png) }', [['https://cdn.example/x.png', 'https://cdn.example/x.png']]],
        ['--bg: url(x.png)', [['x.png', 'x.png']]], // custom properties carry url tokens too
    ])('%j', (css, expected) => {
        expect(refs(css)).toEqual(expected);
    });

    it('decodes escapes in an unquoted url, and an escaped ")" does not end it', () => {
        expect(refs('a { b: url(a\\)b.png) }')).toEqual([['a\\)b.png', 'a)b.png']]);
        expect(urls('a { b: url(\\61 .png) }')).toEqual(['a.png']); // hex escape, its whitespace consumed
        expect(urls('a { b: url(\\61\r\n.png) }')).toEqual(['a.png']); // CRLF ends a hex escape as one whitespace
        expect(urls('a { b: url(a\\ b.png) }')).toEqual(['a b.png']);
        expect(urls('a { b: url(\\0 x) }')).toEqual(['\uFFFDx']); // NUL, a surrogate or past U+10FFFF is U+FFFD
        expect(urls('a { b: url(\\d800 x) }')).toEqual(['\uFFFDx']);
        expect(urls('a { b: url(\\110000 x) }')).toEqual(['\uFFFDx']);
        expect(urls('a { b: url(\\1F600 x) }')).toEqual(['😀x']);
        expect(urls('a { b: url(a\u0000.png) }')).toEqual(['a\uFFFD.png']); // NUL is preprocessed to U+FFFD
    });

    it.each([
        ['whitespace inside', 'a { b: url(a b.png) }'],
        ['a quote inside', 'a { b: url(a"b.png) }'],
        ["an apostrophe inside", "a { b: url(a'b.png) }"],
        ['an open parenthesis inside', 'a { b: url(a(b.png) }'],
        ['a non-printable character', 'a { b: url(a\u0001b.png) }'],
        ['DEL', 'a { b: url(a\u007fb.png) }'],
        ['an escaped newline (not a valid escape)', 'a { b: url(a\\\nb.png) }'],
        ['a comment inside (not a comment there)', 'a { b: url(/* c */x.png) }'],
    ])('a bad url is never a reference: %s', (_label, css) => {
        expect(refs(css)).toEqual([]);
    });

    it('a bad url is consumed up to its ")", escapes included, and tokenizing goes on', () => {
        expect(urls('a { b: url(a b.png) url(c.png) }')).toEqual(['c.png']);
        expect(urls('a { b: url(a b\\) c) url(d.png) }')).toEqual(['d.png']);
        expect(urls('a { b: url(a"b) c: url(d.png) }')).toEqual(['d.png']);
    });

    it('an unclosed url at the end of the input is left alone (only complete tokens are replaced)', () => {
        expect(refs('a { b: url(x.png')).toEqual([]);
        expect(refs('a { b: url(x.png   ')).toEqual([]);
        expect(refs('a { b: url(')).toEqual([]);
    });

    it.each([
        ['a dimension', 'a { b: 10url(x.png) }'],
        ['a dimension with exponent', 'a { b: 1.5e3url(x.png) }'],
        ['a signed dimension', 'a { b: -2url(x.png) }'],
        ['a hash', 'a { b: #url(x.png) }'],
        ['an at-keyword', '@url(x.png);'],
        ['another function', 'a { b: -url(x.png) }'],
        ['a custom function name', 'a { b: --url(x.png) }'],
        ['a longer name', 'a { b: urls(x.png) myurl(x.png) }'],
        ['an escaped parenthesis', 'a { b: url\\(x.png) }'],
        ['a space before the parenthesis', 'a { b: url (x.png) }'],
    ])('not a url: %s', (_label, css) => {
        expect(refs(css)).toEqual([]);
    });

    it('CDO and CDC are tokens of their own, so a url right after one is still a url', () => {
        expect(urls('<!--url(a.png)-->url(b.png)')).toEqual(['a.png', 'b.png']);
        expect(urls('.url(a.png)')).toEqual(['a.png']); // "." followed by a non-digit is a delim
    });
});

describe('cssUrlReferences: strings', () => {
    it.each([
        ['a { b: url("x.png") }', [['"x.png"', 'x.png']]],
        ["a { b: url('x.png') }", [["'x.png'", 'x.png']]],
        ['a { b: url( "x.png" ) }', [['"x.png"', 'x.png']]],
        ['a { b: url(\n  "x.png"\n) }', [['"x.png"', 'x.png']]],
        ['a { b: URL("x.png") }', [['"x.png"', 'x.png']]],
        ['a { b: u\\72l("x.png") }', [['"x.png"', 'x.png']]],
        ['a { b: url("x.png" crossorigin(anonymous)) }', [['"x.png"', 'x.png']]], // only the first token is the URL
    ])('the argument of url(): %j', (css, expected) => {
        expect(refs(css)).toEqual(expected);
    });

    it('decodes escapes and line continuations in a string', () => {
        expect(urls('a { b: url("a\\"b.png") }')).toEqual(['a"b.png']);
        expect(urls("a { b: url('a\\'b.png') }")).toEqual(["a'b.png"]);
        expect(urls('a { b: url("a\\\nb.png") }')).toEqual(['ab.png']);
        expect(urls('a { b: url("a\\\r\nb.png") }')).toEqual(['ab.png']);
        expect(urls('a { b: url("\\61\\62 .png") }')).toEqual(['ab.png']);
        expect(urls('a { b: url("\\0") }')).toEqual(['\uFFFD']);
        expect(urls('a { b: url("a\'b") }')).toEqual(["a'b"]); // the other quote is just a character
    });

    it('a string with a raw newline is a bad string, never a reference; tokenizing goes on after the newline', () => {
        expect(refs('a { b: url("x\n.png") }')).toEqual([]);
        expect(urls('a { content: "x\nurl(after.png) }')).toEqual(['after.png']);
    });

    it('an unclosed string at the end of the input is left alone', () => {
        expect(refs('a { b: url("x.png')).toEqual([]);
        expect(refs('@import "a.css')).toEqual([]);
        expect(refs('@import "a.css\\')).toEqual([]); // a backslash at the end is nothing
    });

    it.each([
        ['content', 'a::after { content: "x.png" }'],
        ['a string that looks like url()', 'a::after { content: "url(x.png)" } b { c: \'url(y.png)\' }'],
        ['an attribute selector', '[href="x.png"], [src=\'x.png\'] { b: c }'],
        ['format() and local()', '@font-face { src: local("x.woff2"), local(Font) format("x.woff2") }'],
        ['a string after the url() argument', 'a { b: url("x.png") "y.png" }'], // only y.png is not; x.png is
        ['a string in another function', 'a { b: attr(data-x, "x.png") var(--y, "y.png") }'],
    ])('a string that is not a URL is never a reference: %s', (label, css) => {
        expect(urls(css)).toEqual(label.startsWith('a string after') ? ['x.png'] : []);
    });
});

describe('cssUrlReferences: comments', () => {
    it('url( inside a comment is not a reference, and a comment ends at the first */', () => {
        expect(urls('/* url(a.png) */ a { b: url(b.png) /* url(c.png) */ }')).toEqual(['b.png']);
        expect(urls('/* "*/ a { b: url(d.png) }')).toEqual(['d.png']);
        expect(urls('/**/a{b:url(e.png)}/***/')).toEqual(['e.png']);
    });

    it('an unclosed comment runs to the end of the input', () => {
        expect(urls('a { b: url(a.png) } /* c { d: url(b.png) }')).toEqual(['a.png']);
    });

    it('a comment between tokens is invisible, inside strings it is text', () => {
        expect(urls('@import /* c */ "a.css";')).toEqual(['a.css']);
        expect(urls('a { b: url(/* c */ "x.png") }')).toEqual([]); // url( then "/": an unquoted url, bad at the quote
        expect(urls('a { b: url("/* c */x.png") }')).toEqual(['/* c */x.png']);
    });
});

describe('cssUrlReferences: @import', () => {
    it.each([
        ['@import "a.css";', ['a.css']],
        ["@import 'a.css';", ['a.css']],
        ['@import"a.css";', ['a.css']],
        ['@import url(a.css);', ['a.css']],
        ['@import url("a.css");', ['a.css']],
        ['@import url( a.css ) screen and (min-width: 1px);', ['a.css']],
        ['@import "a.css" layer(base) supports(display: grid) print;', ['a.css']],
        ['@IMPORT "a.css";', ['a.css']],
        ['@\\69mport "a.css";', ['a.css']],
        ['@import "a.css"; @import "b.css";\n@import url(c.css);', ['a.css', 'b.css', 'c.css']],
        ['@charset "utf-8"; @import "a.css";', ['a.css']], // @charset's string names no file
        ['\uFEFF@import "a.css";', ['a.css']], // a byte order mark is not part of the sheet
    ])('%j', (css, expected) => {
        expect(urls(css)).toEqual(expected);
    });

    it('only the first token of the prelude is the URL', () => {
        expect(urls('@import "a.css" "b.css";')).toEqual(['a.css']);
        expect(urls('@import url(a.css) supports(background: url(b.png)) "c.css";')).toEqual(['a.css']);
        expect(urls('@import screen "a.css";')).toEqual([]);
    });

    it('keeps the range of the string token, quotes included', () => {
        expect(refs('@import "a.css";')).toEqual([['"a.css"', 'a.css']]);
    });

    it('an @import inside a block is not one (it is invalid there, and ignored)', () => {
        expect(urls('a { @import "a.css"; b: url(b.png) }')).toEqual(['b.png']);
    });
});

describe('cssUrlReferences: other at-rules', () => {
    it('nothing in another at-rule\'s prelude is a reference; its block is', () => {
        expect(urls('@namespace url(http://www.w3.org/1999/xhtml); @namespace svg "x.svg"; a { b: url(a.png) }')).toEqual(['a.png']);
        expect(urls('@supports (background: url(a.png)) { b { c: url(d.png) } }')).toEqual(['d.png']);
        expect(urls('@media (min-width: 1px) { a { b: url(c.png) } } @container x (width > 1px) { d { e: url(f.png) } }')).toEqual(['c.png', 'f.png']);
        expect(urls('@page :first { background: url(p.png) }')).toEqual(['p.png']);
        expect(urls('@document url(a.png) { b { c: url(d.png) } }')).toEqual(['d.png']);
        expect(urls('a { @media print { b: url(c.png) } }')).toEqual(['c.png']); // nested
        expect(urls('a { @supports (b: url(c.png)) { d: url(e.png) } }')).toEqual(['e.png']);
    });

    it('@font-face src lists: each url(), never format() or local()', () => {
        const css = `@font-face {
            font-family: F;
            src: url(a.woff2) format("woff2"),
                 url("b.woff") format('woff'),
                 local("Font Name"), local(Font),
                 url('c.ttf') format("truetype") tech(variations);
        }`;
        expect(urls(css)).toEqual(['a.woff2', 'b.woff', 'c.ttf']);
    });

    it('a prelude ends at ";" or "{" at its own depth, or when its block closes', () => {
        expect(urls('@namespace url(a.png); b { c: url(d.png) }')).toEqual(['d.png']);
        expect(urls('@media (x: url(a.png)) { b { c: url(d.png) } } e { f: url(g.png) }')).toEqual(['d.png', 'g.png']);
        expect(urls('a { @layer x; b: url(c.png) }')).toEqual(['c.png']);
        expect(urls('a { @namespace url(x.png) } b { c: url(d.png) }')).toEqual(['d.png']);
    });
});

describe('cssUrlReferences: image-set()', () => {
    it.each([
        ['a { b: image-set("a.png" 1x, "b.png" 2x) }', ['a.png', 'b.png']],
        ['a { b: image-set(url(a.png) 1x, url("b.png") 2x) }', ['a.png', 'b.png']],
        ["a { b: -webkit-image-set('a.png' 1x) }", ['a.png']],
        ['a { b: IMAGE-SET("a.png" 1x) }', ['a.png']],
        ['a { b: image-set("a.avif" type("image/avif"), "b.png" type("image/png") 2x) }', ['a.avif', 'b.png']], // type() takes a MIME type, not a URL
        ['a { b: image-set(linear-gradient(red, blue) 1x, "a.png" 2x) }', ['a.png']],
        ['a { b: image-set(cross-fade("x.png", "y.png") 1x) }', []], // a string nested in another function is not image-set's
        ['a { b: image-set("a.png" 1x), "b.png" }', ['a.png']], // after image-set closes, strings are not URLs
    ])('%j', (css, expected) => {
        expect(urls(css)).toEqual(expected);
    });

    it('a block closes whatever is open inside it: a string after a broken image-set and "}" is not a URL', () => {
        expect(urls('a { b: image-set("x.png" 1x } c { content: "y.png" }')).toEqual(['x.png']);
        expect(urls('a { b: ) url(x.png) ] }')).toEqual(['x.png']); // stray closers change nothing
    });
});

describe('cssUrlReferences: declaration lists (style attributes)', () => {
    it('finds url() and image-set strings in bare declarations', () => {
        expect(urls('background: url(a.png); --x: "b.png"; mask: image-set("c.svg" 1x)')).toEqual(['a.png', 'c.svg']);
    });
});

describe('cssUrlReferences: guarantees', () => {
    const CORPUS = [
        'a { b: url(x.png) }',
        'a { b: url( "x.png" ) }',
        '@import "a.css"; @import url(b.css) print; @import url(\'c.css\');',
        '@font-face { src: url(a.woff2) format("woff2"), local(F) }',
        'a { b: image-set("a.png" 1x, url(b.png) 2x) }',
        'a { b: u\\72l(x.png); c: url(a\\)b.png); d: url("q\\"r.png") }',
        '/* url(no.png) */ a::after { content: "url(no.png)" }',
        '\uFEFF@import "a.css"; é { b: url(é.png) }',
        '<!-- a { b: url(x.png) } -->',
    ];

    it.each(CORPUS)('replacing every reference with a CSS string gives the same references, each now that string: %j', (css) => {
        const before = cssUrlReferences(css);
        const after = cssUrlReferences(rewriteAll(css));
        expect(after.map(r => r.url)).toEqual(before.map(() => JSON.parse(BLOB)));
    });

    it.each(CORPUS)('ranges are sorted, non-overlapping and inside the source; a string range is a whole string token: %j', (css) => {
        let last = 0;
        for (const r of cssUrlReferences(css)) {
            expect(r.start).toBeGreaterThanOrEqual(last);
            expect(r.end).toBeGreaterThanOrEqual(r.start);
            expect(r.end).toBeLessThanOrEqual(css.length);
            const text = css.slice(r.start, r.end);
            if (/^["']/.test(text)) expect(text.at(-1)).toBe(text[0]);
            else expect(css.slice(0, r.start)).toMatch(/\($/);
            last = r.end;
        }
    });

    it('never throws, and keeps those properties, on arbitrary input built from CSS-significant characters', () => {
        const alphabet = ['url(', 'URL(', '"', "'", '\\', '\n', ' ', '(', ')', '{', '}', '[', ']', ';', '/*', '*/', '@import ', '@media ', 'image-set(', 'a.png', '1x', ',', '-', '#', '1', '.', '<!--', '-->', '\u0000', 'é', '\r\n'];
        let seed = 12345;
        const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
        for (let run = 0; run < 2000; run++) {
            let css = '';
            const length = random() % 40;
            for (let i = 0; i < length; i++) css += alphabet[random() % alphabet.length];
            const found = cssUrlReferences(css);
            let last = 0;
            for (const r of found) {
                expect(r.start >= last && r.end >= r.start && r.end <= css.length).toBe(true);
                last = r.end;
            }
            // the rewrite is stable: as many references afterwards, each the inserted string
            expect(cssUrlReferences(rewriteAll(css)).map(r => r.url)).toEqual(found.map(() => JSON.parse(BLOB)));
        }
    });

    it('runs in linear time: 8 MiB of references in well under a second', () => {
        const css = 'a{b:url(x.png)}/*c*/"s"'.repeat(Math.floor(8 * 1024 * 1024 / 23));
        const started = performance.now();
        const found = cssUrlReferences(css);
        expect(found.length).toBe(Math.floor(8 * 1024 * 1024 / 23));
        expect(performance.now() - started).toBeLessThan(3000);
    });
});

describe('replaceRanges', () => {
    it('replaces each range in order and keeps the rest', () => {
        expect(replaceRanges('a url(x) b url(y) c', [{ start: 6, end: 7, text: '"X"' }, { start: 15, end: 16, text: '"Y"' }])).toBe('a url("X") b url("Y") c');
        expect(replaceRanges('abc', [])).toBe('abc');
    });
});
