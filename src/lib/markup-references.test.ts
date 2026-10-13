import { describe, it, expect } from 'vitest';
import { createSlotNonce, inlineScriptsAllowed, resolveReference, rewriteMarkupReferences, VIRTUAL_DOCUMENT_URL } from './markup-references';

const NONCE = '0123456789abcdef0123456789abcdef';
const PATHS = new Set(['logo.svg', 'img/x.svg', 'app.js', 'style.css', 'clip.mp4', 'subs.vtt', 'poster.png', 'mod/main.js', 'icon.ico', 'font.woff2', 'index.html']);

// Joins parts the way the guest bootstrap does, with a recognisable URL per path.
const join = (parts: string[]) => parts.map((part, i) => (i % 2 === 0 ? part : `blob:null/${part}`)).join('');
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('resolveReference: resolved against the virtual index.html, then matched exactly', () => {
    it('is a document at the root of the files', () => {
        expect(VIRTUAL_DOCUMENT_URL).toBe('https://vfs.invalid/index.html');
    });

    it.each([
        ['logo.svg', 'logo.svg'],
        ['./logo.svg', 'logo.svg'],
        ['/logo.svg', 'logo.svg'],
        ['img/x.svg', 'img/x.svg'],
        ['./img/x.svg', 'img/x.svg'],
        ['/img/x.svg', 'img/x.svg'],
        ['img/../logo.svg', 'logo.svg'],
        ['../logo.svg', 'logo.svg'], // nothing resolves above the root, as on any server
        ['../../img/x.svg', 'img/x.svg'],
        ['https://vfs.invalid/logo.svg', 'logo.svg'],
        ['//vfs.invalid/logo.svg', 'logo.svg'],
        ['HTTPS://VFS.INVALID/logo.svg', 'logo.svg'], // scheme and host are case-insensitive, the path is not
        ['https://vfs.invalid:443/logo.svg', 'logo.svg'], // the default port is the same origin
        ['  logo.svg\n', 'logo.svg'], // the URL parser strips surrounding whitespace, as for any src
        ['img\\x.svg', 'img/x.svg'], // a backslash is a slash in an https: URL, as in any browser
        ['l\togo.svg', 'logo.svg'], // tabs and newlines inside are removed, as in any browser
        ['%2e%2e/logo.svg', 'logo.svg'], // the URL standard reads %2e%2e as a dot-dot segment
        ['img/%2E%2E/logo.svg', 'logo.svg'],
    ])('%j names %j', (value, path) => {
        expect(resolveReference(value, PATHS)).toBe(path);
    });

    it.each([
        'missing.svg', 'LOGO.SVG', 'Logo.svg', 'img/X.svg', 'img', 'img/', '/img/',
        // encodings are not decoded: a registered path never contains %
        '%6Cogo.svg', 'img%2Fx.svg', 'img%2F..%2Flogo.svg', '%2e%2e%2flogo.svg',
        // a query or a fragment, even an empty one: fail closed rather than strip
        'logo.svg?', 'logo.svg?v=1', 'logo.svg#', 'logo.svg#frag', 'logo.svg?#',
        // other origins, or the virtual one with credentials, another port or scheme
        'https://example.com/logo.svg', 'http://vfs.invalid/logo.svg', 'https://vfs.invalid:8443/logo.svg',
        'https://user@vfs.invalid/logo.svg', 'https://vfs.invalid.example/logo.svg', 'https://sub.vfs.invalid/logo.svg',
        // other schemes
        'blob:null/logo.svg', 'data:image/svg+xml,<svg/>', 'javascript:alert(1)', 'about:blank', 'file:///logo.svg',
        // the document itself: empty or blank values, and a bare query or fragment
        '', ' ', '\t\n', '\u0000', '?x', '#x',
        // unparseable
        'https://[/logo.svg', 'https://vfs.invalid:99999/logo.svg',
    ])('%j names nothing', (value) => {
        expect(resolveReference(value, PATHS)).toBeNull();
    });

    it('index.html is a file like any other, but an empty value never resolves to it', () => {
        expect(resolveReference('index.html', PATHS)).toBe('index.html');
        expect(resolveReference('', PATHS)).toBeNull();
        expect(resolveReference('./', PATHS)).toBeNull();
    });

    it('matches only registered paths', () => {
        expect(resolveReference('logo.svg', new Set())).toBeNull();
        expect(resolveReference('logo.svg', new Set(['other.svg']))).toBeNull();
    });
});

describe('rewriteMarkupReferences: which attributes become slots', () => {
    it.each([
        ['<script src="app.js"></script>', 'app.js'],
        ['<script type="module" src="mod/main.js"></script>', 'mod/main.js'],
        ['<script defer async src="app.js"></script>', 'app.js'],
        ['<link rel="stylesheet" href="style.css">', 'style.css'],
        ['<link rel="alternate stylesheet" href="style.css">', 'style.css'],
        ['<link rel="icon" href="icon.ico">', 'icon.ico'],
        ['<link rel="shortcut icon" href="icon.ico">', 'icon.ico'],
        ['<link rel="preload" as="font" href="font.woff2">', 'font.woff2'],
        ['<link rel="modulepreload" href="mod/main.js">', 'mod/main.js'],
        ['<link rel="STYLESHEET" href="style.css">', 'style.css'],
        ['<img src="logo.svg">', 'logo.svg'],
        ['<IMG SRC=logo.svg>', 'logo.svg'],
        ['<picture><source src="logo.svg"></picture>', 'logo.svg'],
        ['<video src="clip.mp4"></video>', 'clip.mp4'],
        ['<video poster="poster.png"></video>', 'poster.png'],
        ['<audio src="clip.mp4"></audio>', 'clip.mp4'],
        ['<video><source src="clip.mp4"><track src="subs.vtt"></video>', 'clip.mp4,subs.vtt'],
    ])('%j', (markup, paths) => {
        const parts = rewriteMarkupReferences(markup, PATHS, NONCE)!;
        expect(parts).not.toBeNull();
        expect(parts.filter((_, i) => i % 2 === 1).join(',')).toBe(paths);
        // the slot replaced the attribute's whole value
        const doc = parse(join(parts));
        const urls = [...doc.querySelectorAll('[src], [href], [poster]')].flatMap(el => ['src', 'href', 'poster'].map(a => el.getAttribute(a)).filter(Boolean));
        expect(urls).toEqual(paths.split(',').map(p => `blob:null/${p}`));
    });

    it('rewrites src and poster of one video; the paths follow the serialised markup', () => {
        const parts = rewriteMarkupReferences('<video poster="poster.png" src="clip.mp4"></video><img src="logo.svg">', PATHS, NONCE)!;
        expect(parts.filter((_, i) => i % 2 === 1)).toEqual(['poster.png', 'clip.mp4', 'logo.svg']);
    });

    it.each([
        ['a link that loads nothing', '<link rel="canonical" href="logo.svg"><link rel="next" href="logo.svg"><link href="style.css">'],
        ['an anchor, a form, a frame, an embed, an object, an input', '<a href="logo.svg">x</a><form action="app.js"></form><iframe src="index.html"></iframe><embed src="logo.svg"><object data="logo.svg"></object><input type="image" src="logo.svg">'],
        ['srcset (PR4)', '<img srcset="logo.svg 1x"><picture><source srcset="logo.svg"></picture>'],
        ['CSS url() (PR4)', '<style>body { background: url(logo.svg) }</style><div style="background: url(logo.svg)"></div>'],
        ['an import inside an inline module (PR3)', '<script type="module">import "./app.js";</script>'],
        ['inside <template>', '<template><img src="logo.svg"><script src="app.js"></script></template>'],
        ['SVG elements', '<svg><script src="app.js"></script><image href="logo.svg"></image><video src="clip.mp4"></video></svg>'],
        ['an attribute of another element', '<div src="logo.svg"></div><span poster="poster.png"></span><img poster="poster.png"><audio poster="poster.png"></audio>'],
        ['text that looks like a reference', '<p>&lt;img src="logo.svg"&gt;</p><!-- <img src="logo.svg"> --><textarea><img src="logo.svg"></textarea>'],
        ['unregistered and differently spelled references', '<img src="missing.svg"><img src="LOGO.SVG"><img src="logo.svg?x"><img src="logo.svg#y"><script src="%61pp.js"></script><img src="">'],
    ])('leaves %s alone: no match means null, so the caller embeds the markup verbatim', (_, markup) => {
        expect(rewriteMarkupReferences(markup, PATHS, NONCE)).toBeNull();
    });

    it('returns null without files or without markup', () => {
        expect(rewriteMarkupReferences('<img src="logo.svg">', new Set(), NONCE)).toBeNull();
        expect(rewriteMarkupReferences('', PATHS, NONCE)).toBeNull();
    });

    it('rewrites only the matching references and leaves the others as written', () => {
        const parts = rewriteMarkupReferences('<img id="a" src="logo.svg"><img id="b" src="missing.svg"><img id="c" src="logo.svg?v=1">', PATHS, NONCE)!;
        const doc = parse(join(parts));
        expect(['a', 'b', 'c'].map(id => doc.getElementById(id)!.getAttribute('src'))).toEqual(['blob:null/logo.svg', 'missing.svg', 'logo.svg?v=1']);
    });
});

describe('rewriteMarkupReferences: parts and sentinels', () => {
    it('alternates markup and paths, starting and ending with markup', () => {
        const parts = rewriteMarkupReferences('<img src="logo.svg"><p>between</p><script src="app.js"></script>', PATHS, NONCE)!;
        expect(parts).toHaveLength(5);
        expect(parts[1]).toBe('logo.svg');
        expect(parts[3]).toBe('app.js');
        expect(parts[0]!.endsWith('<img src="')).toBe(true);
        expect(parts[2]!.startsWith('">')).toBe(true);
        expect(parts[2]).toContain('<p>between</p>');
        expect(parts[4]!.startsWith('"></script>')).toBe(true);
    });

    it('leaves no sentinel and no nonce in the parts', () => {
        const parts = rewriteMarkupReferences('<img src="logo.svg"><img src="logo.svg">', PATHS, NONCE)!;
        expect(parts.join('')).not.toContain('vfs-slot');
        expect(parts.join('')).not.toContain(NONCE);
    });

    it('the parts do not depend on the nonce, and each call draws a fresh one by default', () => {
        const markup = '<img src="logo.svg"><script src="app.js"></script>';
        const a = rewriteMarkupReferences(markup, PATHS, NONCE);
        const b = rewriteMarkupReferences(markup, PATHS, 'f'.repeat(32));
        expect(b).toEqual(a);
        expect(rewriteMarkupReferences(markup, PATHS)).toEqual(a);
    });

    it('createSlotNonce: 128 bits, as 32 hex characters, fresh per call', () => {
        const nonces = new Set(Array.from({ length: 1000 }, () => createSlotNonce()));
        expect(nonces.size).toBe(1000);
        for (const nonce of nonces) expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    });

    it('refuses a malformed nonce: the sentinel pattern is built from it', () => {
        expect(() => rewriteMarkupReferences('<img src="logo.svg">', PATHS, '.*')).toThrow();
        expect(() => rewriteMarkupReferences('<img src="logo.svg">', PATHS, 'ABCDEF0123456789ABCDEF0123456789')).toThrow();
    });

    it("guest text shaped like a sentinel: another nonce or an index that is not a slot stays text; this build's nonce could only ever name one of the guest's own files", () => {
        const other = 'f'.repeat(32);
        const parts = rewriteMarkupReferences(`<p>vfs-slot-${other}-0 vfs-slot-${NONCE}-7</p><img src="logo.svg">`, PATHS, NONCE)!;
        expect(parts.filter((_, i) => i % 2 === 1)).toEqual(['logo.svg']);
        expect(parts[0]).toContain(`vfs-slot-${other}-0 vfs-slot-${NONCE}-7`);
        // The nonce is random per build and never reaches the guest, so guest markup cannot contain it.
        // Even if it did, a slot index names a path from this build's own snapshot, nothing else.
        const forged = rewriteMarkupReferences(`<p title="vfs-slot-${NONCE}-0"></p><img src="logo.svg">`, PATHS, NONCE)!;
        expect(forged.filter((_, i) => i % 2 === 1)).toEqual(['logo.svg', 'logo.svg']);
    });

    it('slots sit in double-quoted attribute values, whatever quoting the markup used', () => {
        for (const markup of [`<img src=logo.svg>`, `<img src='logo.svg'>`, `<img src="logo.svg">`, `<img\nsrc = "logo.svg" >`]) {
            const parts = rewriteMarkupReferences(markup, PATHS, NONCE)!;
            expect(parts[0]!.endsWith('src="')).toBe(true);
            expect(parts[2]!.startsWith('"')).toBe(true);
        }
    });
});

describe('rewriteMarkupReferences: re-serialisation', () => {
    it('keeps a full document: attributes of html and body, head content, comments around html; drops the doctype', () => {
        const markup = '<!-- before --><!DOCTYPE html><html lang="en" data-x="1"><head><meta charset="utf-8"><title>T</title><link rel="stylesheet" href="style.css"></head><body class="b" onload="void 0"><img src="logo.svg"></body></html><!-- after -->';
        const parts = rewriteMarkupReferences(markup, PATHS, NONCE)!;
        const written = join(parts);
        expect(written).not.toMatch(/<!doctype/i);
        const doc = parse(written);
        expect(doc.documentElement.getAttribute('lang')).toBe('en');
        expect(doc.documentElement.getAttribute('data-x')).toBe('1');
        expect(doc.title).toBe('T');
        expect(doc.head.querySelector('link')!.getAttribute('href')).toBe('blob:null/style.css');
        expect(doc.body.className).toBe('b');
        expect(doc.body.getAttribute('onload')).toBe('void 0');
        expect(written.startsWith('<!-- before --><html')).toBe(true);
    });

    it('a fragment comes back as a whole document that parses to the same tree', () => {
        const markup = 'text<script src="app.js"></script><p>a &amp; b<p>c<table><td>cell</table>';
        const parts = rewriteMarkupReferences(markup, PATHS, NONCE)!;
        const original = parse(markup);
        original.querySelector('script')!.setAttribute('src', 'blob:null/app.js');
        expect(parse(join(parts)).documentElement.outerHTML).toBe(original.documentElement.outerHTML);
    });

    it('never runs or fetches anything while parsing: DOMParser documents are inert', () => {
        (globalThis as any).__ranInHost = 0;
        const parts = rewriteMarkupReferences('<script>globalThis.__ranInHost++</script><img src="logo.svg" onerror="globalThis.__ranInHost++"><img src="missing.svg" onerror="globalThis.__ranInHost++">', PATHS, NONCE);
        expect(parts).not.toBeNull();
        expect((globalThis as any).__ranInHost).toBe(0);
        delete (globalThis as any).__ranInHost;
    });
});

describe('inlineScriptsAllowed: whether the inline bootstrap can run under the final directives', () => {
    it.each([
        [{ 'script-src': ["'unsafe-inline'"] }, true],
        [{ 'script-src': ["'UNSAFE-INLINE'", 'blob:'] }, true],
        [{ 'script-src': ["'unsafe-inline' blob:"] }, true],
        [{ 'default-src': ["'unsafe-inline'"] }, true], // script-src left out: default-src applies
        [{ 'default-src': ["'unsafe-inline'"], 'script-src': ['blob:'] }, false],
        [{ 'script-src': [] }, false],
        [{ 'script-src': ['blob:'] }, false],
        [{}, false],
        [{ 'script-src': ["'unsafe-inline'", "'nonce-abc'"] }, false], // a nonce or hash disables 'unsafe-inline'
        [{ 'script-src': ["'unsafe-inline'", "'sha256-abc='"] }, false],
        [{ 'script-src': ["'unsafe-inline'", "'strict-dynamic'"] }, false],
    ])('%j → %s', (directives, allowed) => {
        expect(inlineScriptsAllowed(directives as any)).toBe(allowed);
    });
});
