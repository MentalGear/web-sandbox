import { describe, it, expect, vi, afterEach } from 'vitest';
import { isSourceExpression, KNOWN_DIRECTIVES } from '@src/lib/csp/policy-grammar';
import { parseLikeABrowser, prng, randomInjection } from './policy-helpers';
import { viewBootstrapHash } from '@src/lib/in-sandbox-view';
import { STRICT_PASSED_THROUGH } from '@src/lib/csp/strict-policy';
import { buildGuestDocument } from '@src/lib/frame-documents';
import { deepMerge } from '@src/lib/utils';

/**
 * Adversarial review 2026-10, policy and documents (docs/security/ADVERSARIAL-REVIEW-2026-10.md): the guarantees
 * as the element builds them, read back from the documents in its shadow root.
 */

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const wrapperOf = (el: HTMLElement) => el.shadowRoot!.querySelector('iframe');
const innerSourceOf = (el: HTMLElement) => parse(wrapperOf(el)!.srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!;
const policyOf = (el: HTMLElement) => parse(innerSourceOf(el)).querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
const bootstrapOf = (el: HTMLElement) => parse(innerSourceOf(el)).querySelector('script')!.textContent!;

async function mount(config?: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    if (config) el.setConfig(config);
    return el;
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const STRICT_FIXED_VALUES = (hash: string): Record<string, string[]> => ({
    'script-src': [hash], 'script-src-attr': ["'none'"], 'base-uri': ["'none'"], 'form-action': ["'none'"],
    'worker-src': ['blob:'], 'frame-src': ["'none'"], 'object-src': ["'none'"],
});

describe('A1: no configured key or value adds a directive to a guest policy', () => {
    it("strict mode, the reviewers' injection: the view keeps script-src-attr 'none', frame-src 'none' and its hash-only script-src", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict', connectionsAllowed: {
            'default-src': ["'none'; script-src-attr 'unsafe-inline'; script-src * 'unsafe-inline'; frame-src *; base-uri *; form-action *"],
            'connect-src': ['https://api.example; script-src-elem https:'],
        } });
        const { names, directives } = parseLikeABrowser(policyOf(el));
        for (const [name, value] of Object.entries(STRICT_FIXED_VALUES(viewBootstrapHash()))) expect(directives.get(name), name).toEqual(value);
        expect(names).not.toContain('script-src-elem');
        expect(new Set(names).size).toBe(names.length);
    });

    it('iframe mode, an injected key: S7, S14 and the bootstrap check see what the policy holds', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ capabilities: ['allow-scripts'], connectionsAllowed: { 'img-src https://a; script-src-elem': ["'self'", 'https://cdn.example'] } });
        const { names } = parseLikeABrowser(policyOf(el));
        expect(names).not.toContain('script-src-elem');
        expect(names).not.toContain('img-src');
        expect(policyOf(el).toLowerCase()).not.toContain("'self'");
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('directive name'))).toHaveLength(1);
    });

    it('property, strict and iframe mode: 200 random configs; fixed directives keep their values, the directive set is what the config may name, each once, every token a source expression', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const random = prng(14102026);
        const listNames = KNOWN_DIRECTIVES.filter(n => n !== 'upgrade-insecure-requests');
        const fixed = STRICT_FIXED_VALUES(viewBootstrapHash());
        const strictAllowed = new Set([...Object.keys(fixed), ...STRICT_PASSED_THROUGH, 'style-src', 'upgrade-insecure-requests']);
        const META_IGNORED = ['frame-ancestors', 'report-uri', 'report-to', 'sandbox'];
        const DEFAULT_KEYS = ['upgrade-insecure-requests', 'default-src', 'script-src', 'base-uri', 'style-src', 'form-action', 'worker-src'];
        const el = await mount();
        for (let run = 0; run < 200; run++) {
            const connectionsAllowed: Record<string, string[]> = {};
            for (let k = 0; k < 3; k++) {
                const key = random() < 0.5 ? listNames[Math.floor(random() * listNames.length)]! : randomInjection(random);
                connectionsAllowed[key] = [randomInjection(random), randomInjection(random)];
            }
            const context = JSON.stringify(connectionsAllowed);

            el.setConfig({ mode: 'strict', connectionsAllowed });
            const strict = parseLikeABrowser(policyOf(el));
            for (const [name, value] of Object.entries(fixed)) expect(strict.directives.get(name), `${name} in ${context}`).toEqual(value);
            for (const name of strict.names) expect(strictAllowed.has(name), `${name} in ${context}`).toBe(true);
            expect(new Set(strict.names).size, context).toBe(strict.names.length);

            el.setConfig({ capabilities: ['allow-scripts'], connectionsAllowed });
            const iframe = parseLikeABrowser(policyOf(el));
            const configured = Object.keys(connectionsAllowed).filter(key => (KNOWN_DIRECTIVES as readonly string[]).includes(key) && !META_IGNORED.includes(key));
            expect(new Set(iframe.names), context).toEqual(new Set([...DEFAULT_KEYS, ...configured]));
            expect(iframe.names.length, context).toBe(new Set(iframe.names).size);
            for (const tokens of [...strict.directives.values(), ...iframe.directives.values()]) {
                for (const token of tokens) expect(isSourceExpression(token), `${token} in ${context}`).toBe(true);
            }
        }
    }, 60000); // 400 environment builds in jsdom
});

describe("A2: the S14 'self' drop cannot be bypassed by punctuation", () => {
    it("\"'self';\", \"'self',\" and 'SELF' in a key never reach the policy", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const mode of ['iframe', 'worker', 'strict']) {
            const el = await mount({ mode, capabilities: ['allow-scripts'], connectionsAllowed: {
                'script-src': ["'unsafe-inline' 'self';"], 'img-src': ["'self',"], 'connect-src': ["'SELF'"], "font-src 'self'": ['https://f.example'],
            } });
            expect(policyOf(el).toLowerCase(), mode).not.toContain('self');
        }
    });
});

describe('A3: the bootstrap check follows the script-src-elem fallback', () => {
    it('warns once when script-src-elem refuses inline scripts, even though script-src allows them', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mount({ capabilities: ['allow-scripts'], connectionsAllowed: { 'script-src-elem': ['https://cdn.example'] } });
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('cannot run'))).toHaveLength(1);
    });

    it("does not warn when script-src-elem allows them", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mount({ capabilities: ['allow-scripts'], connectionsAllowed: { 'script-src-elem': ["'unsafe-inline'"] } });
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('cannot run'))).toEqual([]);
    });
});

describe('A4: an unknown mode fails closed', () => {
    it.each([['Strict'], [' strict'], ['workers'], [null], [1]])('mode %j: no frame, state terminated with a reason, one warning; reset() keeps it closed; a valid mode starts again', async (mode) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        el.setConfig({ mode });
        expect(el.state).toBe('terminated');
        expect(wrapperOf(el)).toBeNull();
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toMatch(/^unknown mode /);
        el.reset();
        el.load('<p>x</p>');
        expect([el.state, wrapperOf(el)]).toEqual(['terminated', null]);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('is not one of iframe, worker, strict'))).toHaveLength(1);
        el.setConfig({ mode: 'strict' });
        expect(el.state).toBe('loading');
        expect(wrapperOf(el)).not.toBeNull();
    });
});

describe("A5: 'unsafe-eval' and 'wasm-unsafe-eval' come only from scriptUnsafe", () => {
    it('dropped from every directive with one warning each while scriptUnsafe is off, in every mode', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const mode of ['iframe', 'worker', 'strict']) {
            warn.mockClear();
            const el = await mount({ mode, capabilities: ['allow-scripts'], connectionsAllowed: {
                'script-src': ["'unsafe-inline'", "'unsafe-eval'"], 'default-src': ["'wasm-unsafe-eval'"], 'style-src': ["'UNSAFE-EVAL'"],
            } });
            el.reset();
            expect(policyOf(el).toLowerCase(), mode).not.toContain('eval');
            expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes("'unsafe-eval' and 'wasm-unsafe-eval' are not allowed")), mode).toHaveLength(3);
        }
    });

    it("with scriptUnsafe the host's own 'unsafe-eval' is the only eval keyword, in script-src, with the S4 warning and no other", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ scriptUnsafe: true, capabilities: ['allow-scripts'], connectionsAllowed: { 'script-src': ["'unsafe-inline'", "'unsafe-eval'"], 'default-src': ["'wasm-unsafe-eval'"] } });
        const { directives } = parseLikeABrowser(policyOf(el));
        expect(directives.get('script-src')).toEqual(["'unsafe-inline'", "'unsafe-eval'"]);
        expect(directives.get('default-src')).toEqual(["'none'"]);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('eval'))).toHaveLength(1); // S4's
    });
});

describe('A6: the values interpolated into the bootstrap come from one copy of the config', () => {
    it('a config whose scriptUnsafe changes between reads (a getter) is read once, by the copy: a literal false, never its text', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let reads = 0;
        const shifty = {
            capabilities: ['allow-scripts'],
            get scriptUnsafe() { return ++reads === 1 ? '1, globalThis.__A6 = 1, 0' : true; },
        };
        const el = await mount(shifty as any);
        expect(reads).toBe(1);
        expect(bootstrapOf(el)).not.toContain('__A6');
        expect(bootstrapOf(el)).toMatch(/^\(function inSandboxScript\(|\(false, 'iframe'/);
        expect(el._config.scriptUnsafe).toBe(false);
    });

    it('a Proxy config cannot be copied: the sandbox terminates with a reason and builds nothing from it (before: its traps were read, twice)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let trapped = 0;
        const shifty = new Proxy({ capabilities: ['allow-scripts'], scriptUnsafe: '1, globalThis.__A6 = 1, 0' }, {
            getOwnPropertyDescriptor(t, key) { trapped++; return Reflect.getOwnPropertyDescriptor(t, key); },
        });
        const el = await mount();
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        expect(() => el.setConfig(shifty)).not.toThrow();
        expect([el.state, wrapperOf(el), trapped]).toEqual(['terminated', null, 0]);
        expect(reasons).toEqual([expect.stringMatching(/^the configuration could not be used: DataCloneError/)]);
    });
});

describe('A7: a merge never writes prototypes, with no list of keys', () => {
    // JSON values: what a config parsed from a file can hold. Keys include the three that are special to [[Set]].
    const KEYS = ['a', 'b', 'mode', 'html', '__proto__', 'constructor', 'prototype', 'script-src'];
    const SPECIAL = ['__proto__', 'constructor', 'prototype'];
    const randomJson = (random: () => number, depth: number, keys: string[]): unknown => {
        const kind = random();
        if (depth <= 0 || kind < 0.3) return [1, 'x', true, null, 0, ''][Math.floor(random() * 6)];
        if (kind < 0.45) return ['x', 'y'].slice(0, Math.floor(random() * 3));
        const out: Record<string, unknown> = {};
        for (let i = Math.floor(random() * 4); i > 0; i--) {
            const key = keys[Math.floor(random() * keys.length)]!;
            Object.defineProperty(out, key, { value: randomJson(random, depth - 1, keys), enumerable: true, writable: true, configurable: true });
        }
        return out;
    };
    // deepMerge as it was before the denylist and before definitions (for…in and [[Set]]), on keys that are not special
    const assignMerge = (target: any, source: any): any => {
        const output = { ...target };
        for (const key of Object.keys(source)) {
            const value = source[key];
            if (value && typeof value === 'object' && !Array.isArray(value)) output[key] = assignMerge(Object.hasOwn(target, key) ? target[key] || {} : {}, value);
            else if (value !== undefined) output[key] = value;
        }
        return output;
    };
    const prototypesOf = (value: unknown, seen: unknown[] = []): unknown[] => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return seen;
        seen.push(Object.getPrototypeOf(value));
        for (const key of Object.keys(value)) prototypesOf((value as any)[key], seen);
        return seen;
    };

    it('property: 500 JSON sources with "__proto__", "constructor" and "prototype" at any depth change no prototype and are kept as own data; without them a merge is what assignment gave', () => {
        const random = prng(0xa7);
        for (let run = 0; run < 500; run++) {
            const target = JSON.parse(JSON.stringify(randomJson(random, 3, ['a', 'b', 'mode']) ?? {})) as object;
            const source = JSON.parse(JSON.stringify(randomJson(random, 4, KEYS))) as object;
            if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
            const safeTarget = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
            const merged = deepMerge(safeTarget as any, source as any);
            const label = JSON.stringify(source);
            for (const prototype of prototypesOf(merged)) expect(prototype, label).toBe(Object.prototype);
            expect(({} as any).mode, label).toBeUndefined();
            for (const key of SPECIAL) {
                if (Object.hasOwn(source, key)) expect(Object.getOwnPropertyDescriptor(merged, key), label).toMatchObject({ enumerable: true, writable: true });
            }
            if (!SPECIAL.some(key => label.includes(`"${key}"`))) expect(merged, label).toEqual(assignMerge(safeTarget, source));
        }
    });

    it('a JSON config with "__proto__" keys gives the element no inherited settings', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = JSON.parse('{"capabilities": ["allow-scripts"], "__proto__": {"scriptUnsafe": true, "mode": "worker", "entry": "x.js"}, "connectionsAllowed": {"__proto__": {"img-src": ["*"]}}}');
        const el = await mount(config);
        expect(Object.getPrototypeOf(el._config)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(el._config.connectionsAllowed)).toBe(Object.prototype);
        expect([el._config.scriptUnsafe, el._config.mode, el._config.entry]).toEqual([false, 'iframe', undefined]);
        expect(policyOf(el)).not.toContain('img-src');
    });
});

describe('Every build failure is a termination (follow-up audit 2026-10-14)', () => {
    const terminations = (el: any) => {
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        return reasons;
    };

    it.each([
        ['a string where a directive takes a list', { connectionsAllowed: { 'img-src': 'x; script-src *' } }],
        ['a number where a directive takes a list', { connectionsAllowed: { 'connect-src': 7 } }],
        ['a list holding a non-string', { connectionsAllowed: { 'img-src': [1] } }],
    ])('%s: setConfig() does not throw; state terminated, one event with the reason, no frame; reset() stays closed; a usable config starts again', async (_, config) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        const reasons = terminations(el);
        expect(() => el.setConfig(config)).not.toThrow();
        expect([el.state, wrapperOf(el)]).toEqual(['terminated', null]);
        expect(reasons).toEqual([expect.stringMatching(/^the environment could not be built: Error: value type must be/)]);
        expect(() => el.reset()).not.toThrow();
        expect([el.state, wrapperOf(el)]).toEqual(['terminated', null]);
        expect(warn.mock.calls.some(c => String(c[0]).startsWith('[Sandbox] terminated: the environment could not be built'))).toBe(true);
        el.setConfig({ capabilities: ['allow-scripts'] });
        expect(el.state).toBe('loading');
        expect(wrapperOf(el)).not.toBeNull();
    });

    it.each([
        ['a Proxy array', () => ({ connectionsAllowed: { 'connect-src': new Proxy(['https://a.example'], {}) } })],
        ['a function value', () => ({ html: () => '<p>' })],
        ['null', () => null],
        ['an array', () => []],
    ])('%s: the configuration could not be used: terminated with the reason, nothing applied; load() and reset() stay closed', async (_, config) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ capabilities: ['allow-scripts'], html: '<p id="kept">' });
        const reasons = terminations(el);
        expect(() => el.setConfig(config())).not.toThrow();
        expect([el.state, wrapperOf(el)]).toEqual(['terminated', null]);
        expect(reasons).toEqual([expect.stringMatching(/^the configuration could not be used: /)]);
        expect(el._config.html).toBe('<p id="kept">'); // nothing of the refused config was applied
        el.load('<p>x</p>');
        el.reset();
        expect([el.state, wrapperOf(el)]).toEqual(['terminated', null]);
        el.setConfig({});
        expect(el.state).toBe('loading');
    });

    it("the config is a copy: an array the caller changes after setConfig() never changes the policy a later reset() builds", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const list = ['https://a.example'];
        const capabilities: string[] = ['allow-scripts'];
        const el = await mount({ capabilities, connectionsAllowed: { 'connect-src': list } });
        list.push('https://later.example');
        capabilities.push('allow-forms');
        el.reset();
        expect(policyOf(el)).toContain('connect-src https://a.example;');
        expect(policyOf(el)).not.toContain('later.example');
        expect(wrapperOf(el)!.getAttribute('sandbox')).toBe('allow-scripts');
    });

    it('a throw while the frame loads (the second half of a build) is a termination too', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        const reasons = terminations(el);
        el._completeBuild = () => { throw new Error('could not hand over the port'); };
        el._onFrameLoad();
        expect([el.state, wrapperOf(el), reasons]).toEqual(['terminated', null, ['the environment could not be built: Error: could not hand over the port']]);
    });
});
describe('A8: the default bootstrap is parser-safe', () => {
    it('buildGuestDocument refuses a bootstrap that the HTML parser would not read back as one script', () => {
        for (const bad of ['a</script>b', 'a</SCRIPT b', 'a<!--b', 'a<script>b', 'a\u0000b']) {
            expect(() => buildGuestDocument({ csp: "default-src 'none'", bootstrapScript: bad, content: '' }), JSON.stringify(bad)).toThrowError(/inline script/);
        }
    });

    it('every bootstrap the element builds passes (iframe and worker mode, files, module graph, markup references, fetch bridge, auto-sizing)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { defineWebSandbox } = await import('@src/host');
        defineWebSandbox();
        const el = document.createElement('web-sandbox') as any;
        el.registerFiles({ 'app.js': 'import "./lib.js"; </script><!--', 'lib.js': 'export {}', 'a.css': 'p{}', 'i.svg': '<svg/>' });
        document.body.appendChild(el);
        for (const mode of ['iframe', 'worker']) {
            el.setConfig({ mode, capabilities: ['allow-scripts'], autoResize: true, fetchBridge: { allow: ['https://api.example'] },
                html: '<script type="module" src="app.js"></script><link rel="stylesheet" href="a.css"><img src="i.svg"><script type="importmap">{"imports":{"x":"./lib.js"}}</script><p>&lt;/script&gt;</p>' });
            expect(el.state, mode).toBe('loading');
            expect(bootstrapOf(el), mode).not.toMatch(/<\/script|<!--|<script/i);
        }
    });
});
