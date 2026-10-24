import { describe, it, expect, vi } from 'vitest';
import { admits, admitsAll, linkKinds, LOAD_KIND_NAMES, LOAD_KINDS, type LoadKindName } from './load-kinds';
import { fileKinds } from './csp/csp-generator';
import { rewriteGuestMarkup, rewriteMarkupReferences, type KindMismatch } from './markup-references';
import { FileStore, isJavaScriptType, isStylesheetType, mimeTypeFor } from './files';
import { isViewFileType, RENDER_RULES, type RenderSwitches, sanitizeRender, VIEW_FILE_TYPES, VIEW_LOAD_KINDS } from './in-sandbox-view';
import { dropNetworkCss } from './css-references';

// the renderer with every switch on: what it keeps besides its rules is not what this file tests
const KEEP_ALL: RenderSwitches = { animations: true, autoplay: true, stylesheets: true };

/**
 * FR:W1: one table decides which file types each kind of load may name, and the policy
 * (fileKinds), markup and CSS resolution (markup-references.ts, files.ts) and the strict view's renderer
 * all read it. The expectations below are written out independently of the table, so a change to it shows here.
 */

const JS = ['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'];
const EXPECTED: Record<LoadKindName, (type: string) => boolean> = {
    script: type => JS.includes(type),
    style: type => type === 'text/css',
    image: type => type.startsWith('image/'),
    font: type => type.startsWith('font/'),
    media: type => type.startsWith('audio/') || type.startsWith('video/'),
    track: type => type === 'text/vtt',
    fetch: () => true,
};

// every type of the extension table, the other JavaScript types, the fallback, and overrides a guest could set
const TYPES = [...new Set([
    ...['js', 'css', 'html', 'json', 'map', 'xml', 'txt', 'md', 'csv', 'vtt', 'wasm', 'svg', 'png', 'jpg', 'gif', 'webp', 'avif', 'ico', 'bmp',
        'woff', 'woff2', 'ttf', 'otf', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'mp4', 'webm', 'ogv', 'unknown'].map(ext => mimeTypeFor(`f.${ext}`)),
    ...JS, 'application/octet-stream', 'image/x-anything', 'font/x', 'text/x-css', 'text/javascriptx', 'xtext/javascript', 'audio/x', 'video/x',
])];

describe('the table: every kind × every type', () => {
    it.each(LOAD_KIND_NAMES)('%s admits exactly the expected types', (kind) => {
        for (const type of TYPES) expect(admits(kind, type), `${kind} × ${type}`).toBe(EXPECTED[kind](type));
    });

    it('the kinds are these, and isJavaScriptType / isStylesheetType are the script and style rows', () => {
        expect(LOAD_KIND_NAMES).toEqual(['fetch', 'script', 'style', 'image', 'font', 'media', 'track']);
        for (const type of TYPES) {
            expect(isJavaScriptType(type), type).toBe(EXPECTED.script(type));
            expect(isStylesheetType(type), type).toBe(EXPECTED.style(type));
        }
    });

    it('the policy reads the same table: a type gets blob: for exactly the kinds of the loads that may name it', () => {
        const KEYS: Record<LoadKindName, string> = { script: 'scripts', style: 'styles', image: 'images', font: 'fonts', media: 'media', track: 'media', fetch: 'connect' };
        for (const type of TYPES) {
            const kinds = new Set(LOAD_KIND_NAMES.filter(kind => EXPECTED[kind](type)).map(kind => KEYS[kind]));
            expect(fileKinds([type]), type).toEqual(kinds);
        }
        for (const kind of LOAD_KIND_NAMES) expect(LOAD_KINDS[kind].key, kind).toBe(KEYS[kind]);
    });

    it('admitsAll: every kind, and at least one', () => {
        expect(admitsAll([], 'text/css')).toBe(false);
        expect(admitsAll(['style'], 'text/css')).toBe(true);
        expect(admitsAll(['style', 'image'], 'text/css')).toBe(false);
        expect(admitsAll(['nonsense' as LoadKindName], 'text/css')).toBe(false);
    });

    it.each([
        ['stylesheet', null, ['style']],
        ['alternate stylesheet', null, ['style']],
        ['STYLESHEET', null, ['style']],
        ['icon', null, ['image']],
        ['shortcut icon', null, ['image']],
        ['modulepreload', null, ['script']],
        ['preload', 'script', ['script']],
        ['preload', ' Style ', ['style']],
        ['preload', 'image', ['image']],
        ['preload', 'font', ['font']],
        ['preload', 'audio', ['media']],
        ['preload', 'video', ['media']],
        ['preload', 'track', ['track']],
        ['preload', 'fetch', ['fetch']],
        ['preload', null, []], // no usable "as": names nothing
        ['preload', 'document', []],
        ['stylesheet icon', null, ['style', 'image']],
        ['canonical', null, null],
        ['next', null, null],
        [null, null, null],
    ] as const)('linkKinds(rel %j, as %j) is %j', (rel, as, expected) => {
        expect(linkKinds(rel, as)).toEqual(expected);
    });
});

describe('markup: every element and rule the resolver knows × every type', () => {
    // each load, with the kind it makes; `p` is the file's path
    const LOADS: [label: string, markup: (p: string) => string, kind: LoadKindName][] = [
        ['script src', p => `<script src="${p}"></script>`, 'script'],
        ['module script src', p => `<script type="module" src="${p}"></script>`, 'script'],
        ['modulepreload', p => `<link rel="modulepreload" href="${p}">`, 'script'],
        ['preload as=script', p => `<link rel="preload" as="script" href="${p}">`, 'script'],
        ['stylesheet link', p => `<link rel="stylesheet" href="${p}">`, 'style'],
        ['preload as=style', p => `<link rel="preload" as="style" href="${p}">`, 'style'],
        ['@import in <style>', p => `<style>@import "${p}";</style>`, 'style'],
        ['img src', p => `<img src="${p}">`, 'image'],
        ['img srcset', p => `<img srcset="${p} 2x">`, 'image'],
        ['picture source srcset', p => `<picture><source srcset="${p}"></picture>`, 'image'],
        ['video poster', p => `<video poster="${p}"></video>`, 'image'],
        ['icon link', p => `<link rel="icon" href="${p}">`, 'image'],
        ['preload as=image', p => `<link rel="preload" as="image" href="${p}">`, 'image'],
        ['url() in a style attribute', p => `<div style="background: url(${p})"></div>`, 'image'],
        ['url() in <style>', p => `<style>a { background: url("${p}") }</style>`, 'image'],
        ['image-set() in <style>', p => `<style>a { background: image-set("${p}" 1x) }</style>`, 'image'],
        ['url() in @font-face', p => `<style>@font-face { font-family: f; src: url(${p}) format("woff2") }</style>`, 'font'],
        ['url() in @font-face inside @media', p => `<style>@media screen { @font-face { src: url(${p}) } }</style>`, 'font'],
        ['preload as=font', p => `<link rel="preload" as="font" href="${p}">`, 'font'],
        ['video src', p => `<video src="${p}"></video>`, 'media'],
        ['audio src', p => `<audio src="${p}"></audio>`, 'media'],
        ['source src in video', p => `<video><source src="${p}"></video>`, 'media'],
        ['preload as=video', p => `<link rel="preload" as="video" href="${p}">`, 'media'],
        ['track src', p => `<video><track src="${p}"></video>`, 'track'],
        ['preload as=fetch', p => `<link rel="preload" as="fetch" href="${p}">`, 'fetch'],
    ];

    it.each(LOADS)('%s: a slot exactly for the admitted types, else left as written with one mismatch report', (_label, markup, kind) => {
        for (const type of TYPES) {
            const onKindMismatch = vi.fn();
            const { parts } = rewriteGuestMarkup(markup('f.bin'), new Map([['f.bin', type]]), { modules: false, onKindMismatch });
            const slots = parts ? parts.filter((_, i) => i % 2 === 1).map(part => (typeof part === 'string' ? part : part[0])) : [];
            expect(slots, `${kind} × ${type}`).toEqual(EXPECTED[kind](type) ? ['f.bin'] : []);
            expect(onKindMismatch.mock.calls, `${kind} × ${type}`).toEqual(EXPECTED[kind](type) ? [] : [[{ path: 'f.bin', type, kinds: [kind] } satisfies KindMismatch]]);
        }
    });

    it('a link with several loading relations names a file only if every one admits it', () => {
        expect(rewriteMarkupReferences('<link rel="stylesheet icon" href="s.css">', new Map([['s.css', 'text/css']]))).toBeNull();
        expect(rewriteMarkupReferences('<link rel="stylesheet alternate" href="s.css">', new Map([['s.css', 'text/css']]))).not.toBeNull();
    });
});

describe('registered stylesheets: @import names stylesheets, @font-face fonts, every other url() images', () => {
    const slotsOf = (store: FileStore, path: string) => {
        const entry = store.snapshot().find(e => e[0] === path)!;
        return (entry[3] ?? []).filter(edit => Array.isArray(edit)).map(edit => (edit as [string])[0]);
    };

    it.each([
        ['@import "t";', 'style'],
        ['@import url(t);', 'style'],
        ['@import url("t");', 'style'],
        ['a { background: url(t) }', 'image'],
        ['a { background: image-set("t" 1x) }', 'image'],
        ['a { cursor: url(t), auto }', 'image'],
        ['@font-face { font-family: f; src: url(t) format("woff2") }', 'font'],
        ['@supports (display: grid) { @font-face { src: url("t") } }', 'font'],
    ] as const)('%s → %s', (css, kind) => {
        for (const type of TYPES) {
            const warn = vi.fn();
            const store = new FileStore(warn);
            store.register({ 's.css': css.replace('"t"', '"t.bin"').replace('(t)', '(t.bin)'), 't.bin': { content: 'x', type } });
            expect(slotsOf(store, 's.css'), `${kind} × ${type}`).toEqual(EXPECTED[kind](type) ? ['t.bin'] : []);
            expect(warn.mock.calls.filter(c => String(c[0]).includes('will not load')), `${kind} × ${type}`).toHaveLength(EXPECTED[kind](type) ? 0 : 1);
        }
    });
});

// The strict view mints only types that never open as a document (BR:ST1), written out independently too.
const NOT_A_DOCUMENT = (type: string) => !/(html|xml)/.test(type) && /^(text\/css|text\/vtt|image\/(png|jpeg|gif|webp|avif|apng|bmp|x-icon|vnd\.microsoft\.icon)|font\/(woff2?|ttf|otf|collection|sfnt)|audio\/(mpeg|wav|ogg|mp4|flac|webm|aac)|video\/(mp4|webm|ogg))$/.test(type);

describe('the strict view renderer reads a table derived from the same one', () => {
    const render = (html: string, type: string) => {
        const template = document.createElement('template');
        template.innerHTML = html;
        const url = 'blob:null/00000000-0000-0000-0000-000000000001';
        sanitizeRender(template.content, path => (path === 'f.bin' ? { url, type } : null), u => u === url, dropNetworkCss, RENDER_RULES, KEEP_ALL);
        const div = document.createElement('div');
        div.append(template.content);
        return div.innerHTML.includes(url);
    };

    it.each([
        ['<img src="f.bin">', 'image'],
        ['<video poster="f.bin"></video>', 'image'],
        ['<link rel="icon" href="f.bin">', 'image'],
        ['<link rel="stylesheet" href="f.bin">', 'style'],
        ['<video src="f.bin"></video>', 'media'],
        ['<audio src="f.bin"></audio>', 'media'],
        ['<video><source src="f.bin"></video>', 'media'],
        ['<video><track src="f.bin"></video>', 'track'],
    ] as const)('%s names a file only of a %s type the view mints (never a document type: no SVG, HTML or XML)', (html, kind) => {
        for (const type of [...TYPES, 'image/svg+xml', 'video/x+xml', 'image/x-a+xml', 'audio/x+html', 'font/x+xml']) {
            expect(render(html, type), `${kind} × ${type}`).toBe(EXPECTED[kind](type) && NOT_A_DOCUMENT(type));
        }
    });

    it("VIEW_LOAD_KINDS is the table's style, image, font, media and track rows restricted to VIEW_FILE_TYPES, with no prefix; every view type is admitted by some row", () => {
        expect(Object.keys(VIEW_LOAD_KINDS)).toEqual(['style', 'image', 'font', 'media', 'track']);
        for (const [kind, rule] of Object.entries(VIEW_LOAD_KINDS)) {
            expect(rule.key).toBe(LOAD_KINDS[kind as LoadKindName].key);
            expect(rule.prefixes).toEqual([]);
            expect([...rule.types]).toEqual(VIEW_FILE_TYPES.filter(type => admits(kind as LoadKindName, type)));
        }
        for (const type of VIEW_FILE_TYPES) {
            expect(NOT_A_DOCUMENT(type), type).toBe(true);
            expect(isViewFileType(type)).toBe(true);
        }
        expect(RENDER_RULES.kinds).toBe(VIEW_LOAD_KINDS);
    });

    it("a <link>'s kinds in the renderer are load-kinds.ts's linkKinds() (broad review I1): for every rel and as, the renderer names a file exactly when linkKinds admits it and every token is one a kept link may have", () => {
        const rels = ['stylesheet', 'icon', 'stylesheet icon', 'ICON', 'preload', 'modulepreload', 'stylesheet preload', 'alternate stylesheet', 'shortcut icon', '', 'prefetch'];
        for (const rel of rels) {
            for (const as of [null, 'style', 'image', 'font']) {
                for (const type of ['text/css', 'image/png', 'font/woff2']) {
                    const html = `<link rel="${rel}"${as === null ? '' : ` as="${as}"`} href="f.bin">`;
                    const tokens = rel.toLowerCase().split(' ').filter(Boolean);
                    const keepable = tokens.length > 0 && tokens.every(token => RENDER_RULES.linkRelations.includes(token));
                    const kinds = linkKinds(rel, as);
                    expect(render(html, type), `${html} × ${type}`).toBe(keepable && kinds !== null && admitsAll(kinds, type));
                }
            }
        }
        expect(RENDER_RULES.linkRelKinds).toEqual({ stylesheet: 'style', icon: 'image' });
    });

    it('a <link> that names a file of another type is removed (only links to minted files of their kind stay)', () => {
        expect(render('<link rel="stylesheet" href="f.bin">', 'image/png')).toBe(false);
        expect(render('<link rel="stylesheet icon" href="f.bin">', 'text/css')).toBe(false);
    });
});
