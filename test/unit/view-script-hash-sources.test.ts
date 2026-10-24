// @vitest-environment node
import { join } from 'node:path';
import { build } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * viewScriptHash() from the sources (BD3:NEW-1, class O: the baked literal exists only in the built package). The
 * bootstrap's text is a string literal of the package's bundle (scripts/build-lib.ts), so the hash is one value however a
 * consumer bundles it. The sources have no literal: a bundler prints the bootstrap's functions its own way, so a build step
 * that imports the sources computes another hash than the page's bundle of the same sources. viewScriptHash() therefore
 * warns where the literal is absent, and a bundle that carries it hashes the same text everywhere. It runs in Node, as a
 * build step does (importing the package needs no DOM), and because esbuild does not run in the jsdom environment.
 */

const ROOT = join(import.meta.dirname, '..', '..');

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
});

/** The module, evaluated afresh: its text, hash and warning are module state. */
async function freshView() {
    vi.resetModules();
    return await import('@src/lib/in-sandbox-view');
}

describe('viewScriptHash() where the library runs from its sources', () => {
    it('warns once, says what to do, and still returns the hash the page computes', async () => {
        const view = await freshView();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const hash = view.viewScriptHash();
        expect(view.viewScriptHash()).toBe(hash);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(view.SOURCES_HASH_WARNING);
        expect(view.SOURCES_HASH_WARNING).toContain('built package');
        expect(view.SOURCES_HASH_WARNING).toContain('docs/API.md#host-page-policy');
        expect(hash).toBe(view.viewBootstrapHash());
    });

    it('the element, which needs the hash for its own documents, does not warn: only the public function does', async () => {
        const view = await freshView();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        view.viewBootstrapHash();
        view.viewBootstrapText();
        expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn where the bundle carries the literal', async () => {
        const source = (await freshView()).viewBootstrapText();
        vi.stubGlobal('__WEB_SANDBOX_VIEW_BOOTSTRAP__', source);
        const view = await freshView();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(view.viewScriptHash()).toBe(view.viewBootstrapHash());
        expect(warn).not.toHaveBeenCalled();
    });
});

/** `src/index.ts` bundled and minified the way a consumer's build might, evaluated here: its exports. */
async function bundled(define: Record<string, string>): Promise<{ viewScriptHash(): string }> {
    const output = await build({
        configFile: false,
        logLevel: 'silent',
        root: ROOT,
        define,
        build: {
            write: false,
            minify: 'esbuild',
            target: 'esnext',
            lib: { entry: join(ROOT, 'src', 'index.ts'), formats: ['iife'], name: 'WebSandboxBundle' },
        },
    });
    const chunks = (Array.isArray(output) ? output : [output]).flatMap(entry => 'output' in entry ? entry.output : []);
    const code = chunks.map(chunk => ('code' in chunk ? chunk.code : '')).join('\n');
    return new Function(`${code}\nreturn WebSandboxBundle;`)();
}

describe('a consumer that bundles and minifies the sources', () => {
    it('hashes another text than a build step that imports them, and so viewScriptHash() warns; with the built package\'s literal it hashes the same', async () => {
        const view = await freshView();
        const text = view.viewBootstrapText();
        const fromSources = view.viewBootstrapHash();

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const minified = await bundled({});
        const consumerHash = minified.viewScriptHash();
        expect(consumerHash, 'a minifier changes the functions the sources are hashed from').not.toBe(fromSources);
        expect(warn, 'and the function says so').toHaveBeenCalledTimes(1);

        warn.mockClear();
        const baked = await bundled({ __WEB_SANDBOX_VIEW_BOOTSTRAP__: JSON.stringify(text) });
        expect(baked.viewScriptHash(), 'the literal makes the hash the same wherever it is read').toBe(fromSources);
        expect(warn).not.toHaveBeenCalled();
    }, 60_000);
});
