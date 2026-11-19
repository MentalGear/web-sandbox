import '@src/network'; // the network build: this file tests modes and options the default build does not have (ADR-009)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseLikeABrowser, prng, randomInjection } from './policy-helpers';
import { viewBootstrapHash } from '@src/lib/in-sandbox-view';
import { ORIGIN_PATTERN } from '@src/lib/origin';
import { ORIGIN_KINDS } from '@src/lib/csp/origins';
import { buildGuestDocument } from '@src/lib/frame-documents';
import { deepMerge } from '@src/lib/utils';
import { startWith, type AppSetup } from './start-app';

/**
 * Policy and documents (AR:A1 to AR:A8): the guarantees
 * as the element builds them, read back from the documents in its shadow root.
 */

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const wrapperOf = (el: HTMLElement) => el.shadowRoot!.querySelector('iframe');
const innerSourceOf = (el: HTMLElement) => parse(wrapperOf(el)!.srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!;
const policyOf = (el: HTMLElement) => parse(innerSourceOf(el)).querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
const bootstrapOf = (el: HTMLElement) => parse(innerSourceOf(el)).querySelector('script')!.textContent!;

async function mount(config?: Record<string, unknown>, setup: AppSetup = {}) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    if (config) startWith(el, config, setup);
    return el;
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const STRICT_FIXED_VALUES = (hash: string): Record<string, string[]> => ({
    'default-src': ["'none'"], 'script-src': [hash], 'script-src-attr': ["'none'"], 'base-uri': ["'none'"], 'form-action': ["'none'"],
    'worker-src': ['blob:'], 'frame-src': ["'none'"], 'object-src': ["'none'"], 'manifest-src': ["'none'"],
});
const COOPERATIVE_NAMES = ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src', 'worker-src', 'frame-src', 'object-src', 'base-uri', 'form-action', 'manifest-src'];
// what a configurable directive may hold besides origins: the library's own sources
const LIBRARY_SOURCES = new Set(["'unsafe-inline'", "'none'", 'blob:']);

describe('A1: no configured key or value adds a directive to a guest policy (ADR-007: only origins reach it)', () => {
    it("strict mode, the reviewers' injection as origins: dropped; the view keeps script-src-attr 'none', frame-src 'none' and its hash-only script-src", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict', origins: {
            images: ["'none'; script-src-attr 'unsafe-inline'; script-src * 'unsafe-inline'; frame-src *; base-uri *; form-action *"],
            connect: ['https://api.example; script-src-elem https:'],
        } });
        const { names, directives } = parseLikeABrowser(policyOf(el));
        for (const [name, value] of Object.entries(STRICT_FIXED_VALUES(viewBootstrapHash()))) expect(directives.get(name), name).toEqual(value);
        expect([directives.get('img-src'), directives.get('connect-src')]).toEqual([["'none'"], ["'none'"]]);
        expect(names).not.toContain('script-src-elem');
        expect(new Set(names).size).toBe(names.length);
    });

    it('cooperative mode, an injected key: not a kind, dropped with one warning; the policy is the template', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], origins: { 'img-src https://a; script-src-elem': ["'self'", 'https://cdn.example'] } });
        const { names } = parseLikeABrowser(policyOf(el));
        expect(names).toEqual(COOPERATIVE_NAMES);
        expect(policyOf(el).toLowerCase()).not.toContain("'self'");
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('origins takes'))).toHaveLength(1);
    });

    it('property, strict and cooperative mode: 200 random configs; the directives are the template\'s, in order, the fixed ones keep their values, every other token is an origin or the library\'s', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const random = prng(14102026);
        const keys = [...ORIGIN_KINDS, 'img-src', 'script-src', 'default-src'];
        const fixed = STRICT_FIXED_VALUES(viewBootstrapHash());
        for (let run = 0; run < 200; run++) {
            const origins: Record<string, string[]> = {};
            for (let k = 0; k < 3; k++) {
                const key = random() < 0.5 ? keys[Math.floor(random() * keys.length)]! : randomInjection(random);
                origins[key] = [randomInjection(random), random() < 0.3 ? 'https://a.example' : randomInjection(random)];
            }
            const context = JSON.stringify(origins);

            const strictElement = await mount({ mode: 'strict', origins });
            const strict = parseLikeABrowser(policyOf(strictElement));
            strictElement.remove();
            for (const [name, value] of Object.entries(fixed)) expect(strict.directives.get(name), `${name} in ${context}`).toEqual(value);
            expect(new Set(strict.names).size, context).toBe(strict.names.length);

            const cooperativeElement = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], origins });
            const cooperative = parseLikeABrowser(policyOf(cooperativeElement));
            cooperativeElement.remove();
            expect(cooperative.names, context).toEqual(COOPERATIVE_NAMES);
            for (const { directives } of [strict, cooperative]) {
                for (const [name, tokens] of directives) {
                    if (name === 'script-src' && tokens[0] !== "'unsafe-inline'") continue; // the strict hash, checked above
                    for (const token of tokens) expect(LIBRARY_SOURCES.has(token) || ORIGIN_PATTERN.test(token), `${name} ${token} in ${context}`).toBe(true);
                }
            }
        }
    }, 60000); // 400 environment builds in jsdom
});

describe("A2: the S14 'self' drop cannot be bypassed by punctuation", () => {
    it("\"'self';\", \"'self',\" and 'SELF' never reach the policy, in any kind, in any mode", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const mode of ['cooperative', 'worker', 'strict']) {
            const el = await mount({ mode, capabilities: ['allow-scripts'], origins: {
                scripts: ["'unsafe-inline' 'self';"], images: ["'self',"], connect: ["'SELF'"], "fonts 'self'": ['https://f.example'],
            } });
            expect(policyOf(el).toLowerCase(), mode).not.toContain('self');
        }
    });
});

// A build's 'terminated' comes in a task of its own (R1:R3-2): the state changes at once, the event after.
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

describe('A4: an unknown mode fails closed', () => {
    it.each([['Strict'], [' strict'], ['workers'], [null], [1]])('mode %j: start() throws the reason, no frame, nothing started; a valid mode starts the element', async (mode) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        const before = wrapperOf(el);
        expect(() => startWith(el, { mode })).toThrow(new TypeError('[Sandbox] start(): unknown mode: not strict, sealed, cooperative or worker.'));
        expect([el.started, wrapperOf(el)]).toEqual([false, before]); // the element as it was: no frame of the refused app
        await settled();
        expect(reasons).toHaveLength(0);
        startWith(el, { mode: 'strict' });
        expect(el.state).toBe('loading');
        expect(wrapperOf(el)).not.toBeNull();
    });

    it("mode 'iframe' was renamed 'cooperative': refused like any unknown mode, and the refusal says so", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        expect(() => startWith(el, { mode: 'iframe', capabilities: ['allow-scripts'] })).toThrow(new TypeError(`[Sandbox] start(): unknown mode: not strict, sealed, cooperative or worker ('iframe' was renamed 'cooperative').`));
        // only that old name gets the note, never one the prototype chain answers
        expect(() => startWith(el, { mode: 'toString' })).toThrow(new TypeError('[Sandbox] start(): unknown mode: not strict, sealed, cooperative or worker.'));
        startWith(el, { mode: 'cooperative', capabilities: ['allow-scripts'] });
        expect([el.state, wrapperOf(el) !== null]).toEqual(['loading', true]);
    });
});

describe("A5: 'unsafe-eval' and 'wasm-unsafe-eval' come only from scriptUnsafe", () => {
    it('a configured eval keyword is not an origin: dropped with one warning each, in every mode', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const mode of ['cooperative', 'worker', 'strict']) {
            warn.mockClear();
            const el = await mount({ mode, capabilities: ['allow-scripts'], origins: {
                connect: ["'unsafe-eval'"], images: ["'wasm-unsafe-eval'"], styles: ["'UNSAFE-EVAL'"],
            } });
            el.reset();
            expect(policyOf(el).toLowerCase(), mode).not.toContain('eval');
            expect(warn.mock.calls.map(c => String(c[0])).filter(m => /origins\.\w+ entry "'(wasm-)?unsafe-eval'"/i.test(m)), mode).toHaveLength(3);
        }
    });

    it("with scriptUnsafe the host's own 'unsafe-eval' is the only eval keyword, in script-src, with the S4 warning and no other", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'cooperative', scriptUnsafe: true, capabilities: ['allow-scripts'] });
        const { directives } = parseLikeABrowser(policyOf(el));
        expect(directives.get('script-src')).toEqual(["'unsafe-inline'", "'unsafe-eval'"]);
        expect(directives.get('default-src')).toEqual(["'none'"]);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('eval'))).toHaveLength(1); // S4's
    });
});

describe('A6: the values interpolated into the bootstrap come from one copy of the config', () => {
    it('a config whose scriptUnsafe changes between reads (a getter) is read once: its text never reaches a bootstrap', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let reads = 0;
        const el = await mount();
        const before = wrapperOf(el);
        expect(() => el.start({}, {
            mode: 'cooperative',
            capabilities: ['allow-scripts'],
            get scriptUnsafe() { return ++reads === 1 ? '1, globalThis.__A6 = 1, 0' : true; },
        })).toThrow(/scriptUnsafe must be a boolean/);
        expect(reads).toBe(1);
        expect([el.started, wrapperOf(el)]).toEqual([false, before]);
        expect(el.shadowRoot.innerHTML).not.toContain('__A6');
    });

    it('a Proxy option cannot be copied: start() throws with the reason and builds nothing from it; its traps are not read', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let trapped = 0;
        const shifty = new Proxy(['allow-scripts'], {
            getOwnPropertyDescriptor(t, key) { trapped++; return Reflect.getOwnPropertyDescriptor(t, key); },
            get(t, key) { trapped++; return Reflect.get(t, key); },
        });
        const el = await mount();
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        const before = wrapperOf(el);
        expect(() => el.start({}, { mode: 'cooperative', capabilities: shifty, scriptUnsafe: false })).toThrow(/^\[Sandbox\] start\(\): capabilities cannot be copied\W*DataCloneError/);
        await settled();
        expect([el.started, wrapperOf(el), trapped]).toEqual([false, before, 0]);
        expect(reasons).toEqual([]);
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
    // a naive merge (for…in and [[Set]]), on keys that are not special: the shape the library's own copies avoid
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
        // a "__proto__" key of an argument is a key start() does not take: refused, nothing inherited or stored
        const planted = await mount();
        expect(() => startWith(planted, JSON.parse('{"capabilities": ["allow-scripts"], "__proto__": {"scriptUnsafe": true, "mode": "worker", "entry": "x.js"}}'))).toThrow(/the grants has no key "__proto__"/);
        expect(planted.started).toBe(false);
        expect(Object.getPrototypeOf(planted._config)).toBe(Object.prototype);
        expect([planted._config.scriptUnsafe, planted._config.mode, planted._config.entry]).toEqual([false, 'sealed', undefined]);
        // no mode: the config is the default mode's (sealed)
        const sealed = await mount(JSON.parse('{"capabilities": ["allow-scripts"]}'));
        expect(Object.getPrototypeOf(sealed._config)).toBe(Object.prototype);
        expect([sealed._config.scriptUnsafe, sealed._config.mode, sealed._config.entry]).toEqual([false, 'sealed', undefined]);
        // strict mode, which takes origins: none planted in them is inherited either
        const config = JSON.parse('{"mode": "strict", "capabilities": ["allow-scripts"], "origins": {"__proto__": {"images": ["https://p.example"]}}}');
        const el = await mount(config);
        expect(Object.getPrototypeOf(el._config)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(el._origins)).toBe(Object.prototype);
        expect([el._config.scriptUnsafe, el._config.mode, el._config.entry]).toEqual([false, 'strict', undefined]);
        expect(policyOf(el)).toContain("img-src 'none';");
    });
});

describe('Every build failure is a termination (follow-up audit 2026-10-14)', () => {
    const terminations = (el: any) => {
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        return reasons;
    };

    it('a build that throws: start() does not throw; state terminated, one event with the reason, no frame; reset() stays closed; once the build works, reset() starts it again', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        const reasons = terminations(el);
        const build = el._guestPolicy;
        el._guestPolicy = () => { throw new Error('the policy could not be made'); };
        expect(() => startWith(el, { mode: 'strict', capabilities: ['allow-scripts'] })).not.toThrow();
        expect([el.state, wrapperOf(el)]).toEqual(['terminated', null]);
        await settled();
        expect(reasons).toEqual(['the environment could not be built (Error)']);
        expect(() => el.reset()).not.toThrow();
        expect([el.state, wrapperOf(el)]).toEqual(['terminated', null]);
        expect(warn.mock.calls.some(c => String(c[0]).startsWith('[Sandbox] terminated: the environment could not be built'))).toBe(true);
        el._guestPolicy = build;
        el.reset();
        expect(el.state).toBe('loading');
        expect(wrapperOf(el)).not.toBeNull();
    });

    it.each([
        ['a Proxy array', (el: any) => startWith(el, { mode: 'strict', origins: { connect: new Proxy(['https://a.example'], {}) } }), /^\[Sandbox\] start\(\): origins cannot be copied\W*DataCloneError/],
        ['origins that is not an object', (el: any) => startWith(el, { mode: 'strict', origins: 'https://a.example' }), /^origins must be an object of origin lists$/],
        ['origins: null', (el: any) => startWith(el, { mode: 'strict', origins: null }), /^origins must be an object of origin lists$/],
        ['a kind that is not a list (a string)', (el: any) => startWith(el, { mode: 'strict', origins: { images: "x; script-src *" } }), /^origins\.images must be a list of origins$/],
        ['a kind that is not a list (a number)', (el: any) => startWith(el, { mode: 'strict', origins: { connect: 7 } }), /^origins\.connect must be a list of origins$/],
        ['a function value', (el: any) => startWith(el, { html: () => '<p>' }), /^\[Sandbox\] start\(\): html cannot be copied\W*DataCloneError/],
        ['null', (el: any) => el.start(null), /^\[Sandbox\] start\(\): the app \(the first argument\) must be an object/],
        ['an array', (el: any) => el.start([]), /^\[Sandbox\] start\(\): the app \(the first argument\) must be an object/],
    ])('%s: the configuration could not be used: start() throws a TypeError naming it, nothing applied; a usable app starts the element', async (_, start, refusal) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        const reasons = terminations(el);
        const before = wrapperOf(el);
        expect(() => start(el)).toThrow(TypeError);
        expect(() => start(el)).toThrow(refusal); // the option is named for an `origins` of the wrong type (BD3:NEW-3)
        expect([el.started, wrapperOf(el)]).toEqual([false, before]); // nothing of the refused config was applied
        await settled();
        expect(reasons).toEqual([]);
        startWith(el, { capabilities: ['allow-scripts'], html: '<p id="kept">' });
        expect([el.state, el._config.html]).toEqual(['loading', '<p id="kept">']);
    });

    it("the config is a copy: an array the caller changes after setConfig() never changes the policy a later reset() builds", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const list = ['https://a.example'];
        const capabilities: string[] = ['allow-scripts'];
        const el = await mount({ mode: 'cooperative', capabilities, origins: { connect: list }, hostContentSecurityPolicy: false });
        list.push('https://later.example');
        capabilities.push('allow-orientation-lock'); // a safe capability: only the copy keeps it out
        el.reset();
        expect(policyOf(el)).toContain('connect-src https://a.example;');
        expect(policyOf(el)).not.toContain('later.example');
        expect(wrapperOf(el)!.getAttribute('sandbox')).toBe('allow-scripts');
    });

    it('a throw while the frame loads (the second half of a build) is a termination too', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        const reasons = terminations(el);
        // the strict view's ports, handed over at the wrapper's load (the `sendInitView` effect, applied through the
        // class's prototype, CB7), throw; the wrapper's load of the standing environment, as the platform delivers it
        vi.spyOn(Object.getPrototypeOf(el), '_setupStrictChannels').mockImplementation(() => { throw new Error('could not hand over the port'); });
        el._step({ t: 'frameLoad', gen: el._lc.gen, stillOurs: true, guest: {} });
        expect([el.state, wrapperOf(el), reasons]).toEqual(['terminated', null, ['the environment could not be built (Error)']]);
    });
});
describe('A8: the default bootstrap is parser-safe', () => {
    it('buildGuestDocument refuses a bootstrap that the HTML parser would not read back as one script', () => {
        for (const bad of ['a</script>b', 'a</SCRIPT b', 'a<!--b', 'a<script>b', 'a\u0000b']) {
            expect(() => buildGuestDocument({ csp: "default-src 'none'", bootstrapScript: bad, content: '' }), JSON.stringify(bad)).toThrowError(/inline script/);
        }
    });

    it('every bootstrap the element builds passes (cooperative and worker mode, files, module graph, markup references, fetch bridge, auto-sizing)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { defineWebSandbox } = await import('@src/host');
        defineWebSandbox();
        const files = { 'app.js': 'import "./lib.js"; </script><!--', 'lib.js': 'export {}', 'a.css': 'p{}', 'i.svg': '<svg/>' };
        for (const mode of ['cooperative', 'worker']) {
            const el = document.createElement('web-sandbox') as any;
            document.body.appendChild(el);
            startWith(el, { mode, capabilities: ['allow-scripts'], autoResize: true, fetchBridge: { allow: ['https://api.example'] },
                html: '<script type="module" src="app.js"></script><link rel="stylesheet" href="a.css"><img src="i.svg"><script type="importmap">{"imports":{"x":"./lib.js"}}</script><p>&lt;/script&gt;</p>' }, { files });
            expect(el.state, mode).toBe('loading');
            expect(bootstrapOf(el), mode).not.toMatch(/<\/script|<!--|<script/i);
        }
    });
});
