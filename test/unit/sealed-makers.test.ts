import { describe, expect, it } from 'vitest';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { COOKIE_CARRIER_IDS } from '@src/lib/cookie-facts';
import { SECURE_CONTEXT_ONLY, STRICT_WORKER_GLOBALS, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS } from '@src/lib/worker-globals';
import { RENDER_ATTRIBUTES, RENDER_ELEMENTS, RENDER_NETWORK_DROPPED, RENDER_RULES, RENDER_URL_ATTRIBUTES } from '@src/lib/in-sandbox-view';
import { LINK_REL_KINDS } from '@src/lib/load-kinds';
import { cssReferences } from '@src/lib/css-references';
import { ABSENT_COMPILERS, CODE_FROM_STRING_SINKS } from '@src/lib/code-from-strings';
import { dynamicImportAt } from '@src/lib/entry-imports';
import { CSS_PLACES, SEALED_MAKERS, STYLE_MAKERS, makerCode, makerUrl, type CssKind, type CssPlace, type Maker, type MakerCovers, type StyleWay } from '../e2e/sealed-makers';

/**
 * The enumeration of sealed mode's request makers (test/e2e/sealed-makers.ts, which test/e2e/sealed-no-network.spec.ts
 * aims at a listener on every engine: research 24, step 3) against the library's own lists, so that a maker the library learns
 * about is in the enumeration, or this test fails: the names the request gate installs, the request makers the worker's
 * allowlist keeps out, the rows of COOKIE_CARRIERS, the renderer's URL attributes and `<link>` relations, and every kind of
 * URL a CSS reference makes in every place guest CSS reaches the view.
 */

const covered = <K extends string>(key: K) => SEALED_MAKERS.flatMap(maker => maker.covers.filter((cover): cover is Extract<MakerCovers, Record<K, unknown>> => key in cover).map(cover => ({ maker, cover })));

/** The globals the request gate installs (replaceGlobal), read from the bootstrap's text. */
const gateNames = () => [...new Set([...inSandboxScript.toString().matchAll(/replaceGlobal\(\s*["'](\w+)["']/g)].map(match => match[1]!))].sort();

describe('sealed mode\'s request makers: one enumeration, tied to the library\'s lists', () => {
    it('the ids are unique, and each maker says how sealed mode stops it and what it is checked against', () => {
        const ids = SEALED_MAKERS.map(maker => maker.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const maker of SEALED_MAKERS) {
            if (maker.outcome === 'gate' || maker.outcome === 'dropped') expect(maker.directive, maker.id).toBeTruthy();
            if (maker.realm === 'worker') expect(maker.sees, maker.id).toBeTruthy();
            if (maker.click) expect(maker.realm, maker.id).toBe('view');
            // a positive control on every engine, or the reason it has none
            if (!maker.strict && !maker.frame) expect(maker.note, maker.id).toBeTruthy();
            // the placeholder is gone once the URL is in place
            const code = makerCode(maker, makerUrl(maker, { https: 'https://l.test', http: 'http://l.test', wss: 'wss://l.test' }));
            if (maker.realm === 'view' || maker.realm === 'stylesheet') expect(code, maker.id).toContain(`/m/${maker.id}`);
            expect(code, maker.id).not.toContain('{U}');
        }
    });

    it('every global the request gate installs is a maker the gate refuses; each is on the strict worker\'s allowlist', () => {
        const names = gateNames();
        expect(names).toEqual(['WebSocket', 'XMLHttpRequest', 'fetch']); // the scan finds them (positive control)
        const makers = covered('gate');
        for (const name of names) {
            expect(makers.some(({ cover }) => cover.gate === name), name).toBe(true);
            expect(STRICT_WORKER_GLOBALS, name).toContain(name);
        }
        for (const { maker, cover } of makers) {
            expect(names, maker.id).toContain(cover.gate);
            expect(maker.outcome, maker.id).toBe('gate');
        }
    });

    it('every request maker the allowlist keeps out of the worker is a maker, absent there: importScripts (strict\'s), and the platform\'s other makers', () => {
        const globals = covered('global');
        // strict's list leaves out importScripts, a maker, and the names only a secure context has, which make no request
        const offStrict = WORKER_GLOBALS.filter(name => !STRICT_WORKER_GLOBALS.includes(name));
        expect(offStrict.filter(name => !(SECURE_CONTEXT_ONLY.globals as readonly string[]).includes(name))).toEqual(['importScripts']);
        for (const name of offStrict.filter(name => name === 'importScripts')) expect(globals.some(({ cover }) => cover.global === name), name).toBe(true);
        for (const { maker, cover } of globals) {
            expect(STRICT_WORKER_GLOBALS, `${maker.id}: on the allowlist, so not absent: its outcome is no longer 'absent'`).not.toContain(cover.global);
            expect(maker.outcome, maker.id).toBe('absent');
        }
        for (const { maker, cover } of covered('navigator')) {
            expect(WORKER_NAVIGATOR_MEMBERS, maker.id).not.toContain(cover.navigator);
            expect(maker.outcome, maker.id).toBe('absent');
        }
        expect(covered('reserved').map(({ maker }) => maker.outcome)).toEqual(['refused']);
    });

    // BD6:ISO-1, BD6:ISO-2 (class A: INHERITED_CONTEXT.cspPolicyText, cspReporting): every way the worker could make the
    // browser check the policy list it inherits from the host page is a maker the library stops before the platform
    it('every code-from-string sink the prelude refuses is a maker, refused with the library\'s EvalError; every compiler the worker lacks is one, absent', () => {
        const sinks = covered('sink');
        for (const id of Object.keys(CODE_FROM_STRING_SINKS)) expect(sinks.some(({ cover }) => cover.sink === id), id).toBe(true);
        for (const { maker } of sinks) expect([maker.outcome, maker.sees], maker.id).toEqual(['string', 'EvalError']);
        const compilers = covered('compiler');
        for (const name of Object.keys(ABSENT_COMPILERS)) expect(compilers.some(({ cover }) => cover.compiler === name), name).toBe(true);
        for (const { maker } of compilers) expect([maker.outcome, maker.sees], maker.id).toEqual(['absent', 'ReferenceError']);
    });

    it('every import() is a maker the build refuses, and no other maker holds one, so the entry of the rest builds', () => {
        const origins = { https: 'https://l.test', http: 'http://l.test', wss: 'wss://l.test' };
        const unbuildable = SEALED_MAKERS.filter(maker => maker.outcome === 'unbuildable');
        expect(unbuildable.map(maker => maker.id)).toEqual(['import', 'import-file', 'import-data']);
        for (const maker of SEALED_MAKERS.filter(maker => maker.realm === 'worker')) {
            const found = dynamicImportAt(makerCode(maker, makerUrl(maker, origins))) >= 0;
            expect(found, maker.id).toBe(maker.outcome === 'unbuildable');
            if (maker.outcome === 'unbuildable') expect(maker.sees, maker.id).toBe('entryImport');
        }
    });

    it('every row of COOKIE_CARRIERS is a maker', () => {
        const carriers = covered('carrier').map(({ cover }) => cover.carrier);
        for (const id of COOKIE_CARRIER_IDS) expect(carriers, id).toContain(id);
    });

    it('every [element, attribute] of the renderer that holds a URL is a maker: what it loads (RENDER_URL_ATTRIBUTES, with RENDER_NETWORK_DROPPED among them) and its links', () => {
        // the HTML attributes that can hold a URL, as the renderer's own test reads RENDER_ATTRIBUTES (in-sandbox-view.test.ts)
        const urlish = ['src', 'srcset', 'poster', 'href', 'cite', 'data', 'action', 'formaction', 'manifest', 'longdesc', 'codebase', 'background', 'ping', 'itemtype'];
        const holders = Object.entries(RENDER_ATTRIBUTES.htmlElements).flatMap(([element, names]) => names.filter(name => urlish.includes(name)).map(name => `${element} ${name}`));
        const pairs = new Set([...RENDER_URL_ATTRIBUTES.map(([e, a]) => `${e} ${a}`), ...holders]);
        expect(pairs.size).toBeGreaterThan(RENDER_URL_ATTRIBUTES.length); // the links are among them (positive control)
        const makers = covered('attribute');
        for (const pair of pairs) expect(makers.some(({ cover }) => cover.attribute.join(' ') === pair), pair).toBe(true);
        for (const [element, attribute] of RENDER_NETWORK_DROPPED) {
            expect(makers.some(({ maker, cover }) => cover.attribute.join(' ') === `${element} ${attribute}` && maker.outcome === 'dropped'), `${element} ${attribute}`).toBe(true);
        }
    });

    it('every <link> relation the library knows is a maker: the load-kind table\'s and the renderer\'s', () => {
        const rels = covered('linkRel').map(({ cover }) => cover.linkRel);
        for (const rel of new Set([...Object.keys(LINK_REL_KINDS), ...RENDER_RULES.linkRelations])) expect(rels, rel).toContain(rel);
    });

    it('every kind of URL a CSS reference makes is a maker in every place guest CSS reaches the view, by url() and image-set() for images', () => {
        // the kinds, as the library's own scanner finds them: a stylesheet holds every one; a declaration list only images
        const kindsIn = (css: string) => [...new Set(cssReferences(css, 'loads').map(reference => reference.kind))].sort() as CssKind[];
        const sheet = kindsIn('@import "https://x.test/a.css"; @font-face { src: url(https://x.test/f.woff2) } a { background: url(https://x.test/i.png) }');
        const declarations = kindsIn('background: url(https://x.test/i.png); --x: image-set("https://x.test/s.png" 1x)');
        expect(sheet).toEqual(['font', 'image', 'style']);
        expect(declarations).toEqual(['image']);
        const kindsOf: Record<CssPlace, CssKind[]> = { 'style-element': sheet, 'registered-stylesheet': sheet, 'style-attribute': declarations, 'set-css': declarations };
        const makers = covered('css');
        for (const place of CSS_PLACES) {
            for (const kind of kindsOf[place]) expect(makers.some(({ cover }) => cover.css === place && cover.kind === kind), `${place} ${kind}`).toBe(true);
            for (const via of ['url', 'image-set'] as const) expect(makers.some(({ cover }) => cover.css === place && cover.kind === 'image' && cover.via === via), `${place} ${via}`).toBe(true);
        }
        // a maker's own CSS is found by the scanner, with the kind it claims (stylesheet makers in a sheet, the rest as written)
        for (const { maker, cover } of makers) {
            const code = makerCode(maker, `https://x.test/m/${maker.id}`);
            const css = maker.realm === 'set-css' ? Object.values(new Function(`return ${code}`)() as Record<string, string>).join('; ')
                : maker.realm === 'stylesheet' ? code
                : (/<style>([\s\S]*?)<\/style>/.exec(code) ?? /style="([^"]*)"/.exec(code))![1]!;
            expect(cssReferences(css, 'loads').map(reference => reference.kind), maker.id).toContain(cover.kind);
        }
    });

    // BD6:ISO-2 (class A: INHERITED_CONTEXT.cspReporting): every way guest CSS reaches the view's document, which as an inline
    // style the host page's style-src would check and report
    it('every namespace the renderer keeps a style attribute or a <style> in, and every operation that changes a style, is a style maker', () => {
        const ids = STYLE_MAKERS.map(maker => maker.id);
        expect(new Set(ids).size).toBe(ids.length);
        const namespaces = ['html', 'svg', 'mathml'] as const;
        const attributes = namespaces.filter(namespace => (RENDER_ATTRIBUTES[namespace] as readonly string[]).includes('style'));
        const elements = namespaces.filter(namespace => (RENDER_ELEMENTS[namespace] as readonly string[]).includes('style'));
        expect([attributes, elements]).toEqual([['html', 'svg', 'mathml'], ['html', 'svg']]); // the lists read (positive control)
        for (const namespace of attributes) expect(STYLE_MAKERS.some(maker => maker.way === 'attribute' && maker.namespace === namespace), `a style attribute in ${namespace}`).toBe(true);
        for (const namespace of elements) expect(STYLE_MAKERS.some(maker => maker.way === 'element' && maker.namespace === namespace), `a <style> in ${namespace}`).toBe(true);
        // every sandboxView operation that can change what a style applies: text() and render() into a <style>, a render that
        // replaces or removes one, and set({ css }); each maker's own call is the one its way names
        const calls: Record<StyleWay, string | null> = { attribute: null, element: null, text: 'sandboxView.text(', 'render-into': 'sandboxView.render(', replace: 'sandboxView.render(', remove: 'sandboxView.render(', 'remove-text': 'sandboxView.text(', 'remove-value': 'sandboxView.set(', 'set-css': 'sandboxView.set(' };
        for (const [way, call] of Object.entries(calls) as [StyleWay, string | null][]) {
            const makers = STYLE_MAKERS.filter(maker => maker.way === way);
            expect(makers.length, way).toBeGreaterThan(0);
            for (const maker of makers) expect(maker.then?.startsWith(call ?? '') ?? call === null, maker.id).toBe(true);
        }
        // each maker's markup holds the element its check reads, and the check's value is not what the element computes unstyled
        for (const maker of STYLE_MAKERS) {
            expect(maker.markup, maker.id).toContain(`id="${maker.check.id}"`);
            if (!maker.way.startsWith('remove')) expect(maker.check.value, maker.id).not.toBe('rgb(0, 0, 0)');
        }
    });

    it('each maker is aimed at the listener, at a path of its own', () => {
        const origins = { https: 'https://l.test:1', http: 'http://l.test:2', wss: 'wss://l.test:1' };
        const urls = SEALED_MAKERS.map((maker: Maker) => makerUrl(maker, origins));
        expect(new Set(urls).size).toBe(urls.length);
        for (const url of urls) expect(url).toMatch(/^(https|http|wss):\/\/l\.test:\d\/m\/[a-z-]+$/);
    });
});
