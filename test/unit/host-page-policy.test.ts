import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptHashSource } from '@src/lib/csp/script-hash';
import { buildWrapperDocument, WRAPPER_CSP, WRAPPER_PREFIX, WRAPPER_STYLE } from '@src/lib/frame-documents';
import { VIEW_STILL_STYLE } from '@src/lib/in-sandbox-view';

/**
 * The host page's policy as docs/API.md#host-page-policy lists it: every constant the section states is computed here
 * from the text the library writes, so a change to that text fails until the doc and the host-policy spec follow.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const API = readFileSync(path.join(here, '../../docs/API.md'), 'utf8');
const SPEC = readFileSync(path.join(here, '../e2e/host-policy.spec.ts'), 'utf8');

/** The "Host page policy" section of docs/API.md: from its header to the next section. */
const section = (() => {
    const start = API.indexOf('\n## Host page policy');
    expect(start).toBeGreaterThan(-1);
    const end = API.indexOf('\n## ', start + 1);
    return API.slice(start, end === -1 ? undefined : end);
})();

/** One row of the section's table, by the directive in its first cell. */
const row = (directive: string): string => {
    const found = section.split('\n').find(line => line.startsWith(`| \`${directive}\` |`));
    expect(found, directive).toBeDefined();
    return found!;
};

describe('the wrapper style and the animation stylesheet: the hashes docs/API.md#host-page-policy lists', () => {
    it("the wrapper style's hash, computed from WRAPPER_STYLE, is the one the style-src row lists and the host-policy spec allows", () => {
        const hash = scriptHashSource(WRAPPER_STYLE);
        expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
        const listed = /wrapper style's hash `('sha256-[^`']+')`/.exec(row('style-src'));
        expect(listed, 'the style-src row names the wrapper style hash').not.toBeNull();
        expect(listed![1]).toBe(hash);
        expect(SPEC).toContain(`const WRAPPER_STYLE_HASH = "${hash}"`);
    });

    it("the wrapper document carries that style, once, as the text the hash covers", () => {
        const document = buildWrapperDocument('<p>guest</p>', 'allow-scripts');
        expect(document.split(`<style>${WRAPPER_STYLE}</style>`)).toHaveLength(2);
    });

    it("the animation stylesheet's hash, computed from VIEW_STILL_STYLE, is the one the style-src row lists", () => {
        const listed = /animation stylesheet's hash `('sha256-[^`']+')`/.exec(row('style-src'));
        expect(listed, 'the style-src row names the animation stylesheet hash').not.toBeNull();
        expect(listed![1]).toBe(scriptHashSource(VIEW_STILL_STYLE));
    });
});

describe("the wrapper's own policy (WRAPPER_CSP) against the policy the docs state for its frames", () => {
    // docs/API.md#host-page-policy: "frame-src / child-src: nothing (a srcdoc frame loads no URL)". The wrapper's meta
    // policy is what makes that so for the one frame it holds. It is inherited by the guest's srcdoc, so it has no other
    // directive (anything stricter would bind the guest too), and no base-uri on purpose: its own <base> must apply.
    it('is exactly one directive: frame-src none', () => {
        const directives = WRAPPER_CSP.split(';').map(directive => directive.trim().split(/\s+/));
        expect(directives).toEqual([['frame-src', "'none'"]]);
    });

    it("agrees with the frame-src / child-src row, which states that no URL is loaded", () => {
        expect(row('frame-src` / `child-src')).toMatch(/nothing \(a `srcdoc` frame loads no URL\)/);
    });

    it('is the first element of the wrapper document, and the prefix the Trusted Types policy blesses starts with it', () => {
        expect(WRAPPER_PREFIX).toBe(`<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}">`);
        expect(buildWrapperDocument('', '').startsWith(WRAPPER_PREFIX)).toBe(true);
    });
});
