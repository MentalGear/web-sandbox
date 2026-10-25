import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NetworkSandboxOptions, SandboxConfig, SealedSandboxConfig, StrictSandboxConfig } from '@src/host';
import { CONFIG_OPTIONS, CONFIG_SCHEMA, NETWORK_OPTIONS, normaliseConfig, SANDBOX_MODES, type NormaliseContext, type OptionRule } from '@src/lib/config-schema';
import { fileKinds, SEALED_FILE_KINDS, sealedViewPolicy, type SealedFileKind, type SealedPolicyInput } from '@src/lib/csp/csp-generator';
import { NO_ORIGINS } from '@src/lib/csp/origins';
import { viewBootstrapHash } from '@src/lib/in-sandbox-view';
import { reasonText, TERMINATION_REASONS } from '@src/lib/reasons';

/**
 * Sealed mode (docs/research/24_sealed_mode): strict mode with no network, named with `mode: 'sealed'`. "No network"
 * is a construction, held here at three places: the type (T1), the schema (T2) and the view's policy template (T3).
 * A sealed config that names `origins` or `fetchBridge` is refused with its reason, never read as strict, never stripped.
 */

const REASON = "origins and fetchBridge open the network, which sealed mode does not have: set `mode: 'strict'`";

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const wrapperOf = (el: HTMLElement) => el.shadowRoot!.querySelector('iframe');
const innerSourceOf = (el: HTMLElement) => parse(wrapperOf(el)!.srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!;
const policyOf = (el: HTMLElement) => parse(innerSourceOf(el)).querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
// A build's 'terminated' comes in a task of its own (R1:R3-2).
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

async function mount() {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    return el;
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('T1: the types: a sealed config cannot name a network option', () => {
    it('sealed takes no origins and no fetchBridge; strict, cooperative and worker take both', () => {
        // @ts-expect-error sealed mode has no network: no origins
        const sealedOrigins: SandboxConfig = { mode: 'sealed', origins: { images: ['https://cdn.example'] } };
        // @ts-expect-error sealed mode has no network: no fetchBridge
        const sealedBridge: SandboxConfig = { mode: 'sealed', fetchBridge: { allow: ['https://api.example'] } };
        // @ts-expect-error not as a SealedSandboxConfig either
        const typedOrigins: SealedSandboxConfig = { mode: 'sealed', origins: {} };
        // @ts-expect-error nor through a variable of the network options
        const spread: SandboxConfig = { mode: 'sealed', ...({ fetchBridge: { allow: [] } } as NetworkSandboxOptions) };
        const sealed: SealedSandboxConfig = { mode: 'sealed', html: '<p>hi</p>', entry: 'main.js', guestWrites: true };
        const asUnion: SandboxConfig = { mode: 'sealed', allowAnimations: true };
        const strict: SandboxConfig = { mode: 'strict', origins: { images: ['https://cdn.example'] }, fetchBridge: { allow: ['https://api.example'] } };
        // the default is still strict: a config without a mode is a strict config, and takes both
        const noMode: StrictSandboxConfig = { origins: { connect: ['https://api.example'] }, fetchBridge: { allow: [] } };
        const cooperative: SandboxConfig = { mode: 'cooperative', origins: { scripts: ['https://cdn.example'] }, fetchBridge: { allow: [] } };
        const worker: SandboxConfig = { mode: 'worker', fetchBridge: { allow: [] } };
        expect([sealedOrigins, sealedBridge, typedOrigins, spread, sealed, asUnion, strict, noMode, cooperative, worker]).toHaveLength(10);
    });
});

describe('T2: the schema: no network option reaches sealed mode', () => {
    const rules = CONFIG_SCHEMA as Record<string, OptionRule>;

    it("origins and fetchBridge exclude 'sealed' from their modes; every other option of strict mode's view is sealed's too", () => {
        expect(SANDBOX_MODES).toContain('sealed');
        for (const name of NETWORK_OPTIONS) expect(rules[name]!.modes, name).not.toContain('sealed');
        for (const name of CONFIG_OPTIONS.filter(option => !(NETWORK_OPTIONS as readonly string[]).includes(option))) {
            expect(rules[name]!.modes!.includes('sealed'), name).toBe(rules[name]!.modes!.includes('strict'));
        }
    });

    it.each([
        ['origins', { origins: { images: ['https://cdn.example'] } }],
        ['an empty origins', { origins: {} }],
        ['origins that is not an object', { origins: 'x' }],
        ['fetchBridge', { fetchBridge: { allow: ['https://api.example'] } }],
        ['fetchBridge: null', { fetchBridge: null }],
        ['both', { origins: { connect: ['https://api.example'] }, fetchBridge: { allow: [] } }],
    ])('a sealed config that names %s is refused with the reason, and nothing of it is read', (_, network) => {
        const { value, warnings, refusal } = normaliseConfig({ mode: 'sealed', capabilities: 5, ...network }, { hostOrigin: 'https://app.example', hostSites: ['https://app.example'] });
        expect(value).toBeNull();
        expect(warnings).toEqual([]); // refused before any option is read: not even the bad `capabilities` is said
        expect(refusal).toBeInstanceOf(Error);
        expect((refusal as { reason: string }).reason).toBe(REASON);
    });

    it('the reason is the registry\'s, decided by the config, and its text is the one docs/API.md lists', () => {
        expect(reasonText('sealedNetwork')).toBe(REASON);
        expect(TERMINATION_REASONS.sealedNetwork.decidedBy).toBe('config');
    });

    it('a network option left undefined names nothing; outside sealed mode, and with no mode (still strict), both are taken', () => {
        const context = { hostOrigin: 'https://app.example', hostSites: ['https://app.example'] };
        expect(normaliseConfig({ mode: 'sealed', origins: undefined, fetchBridge: undefined }, context).refusal).toBeNull();
        for (const mode of [undefined, 'strict', 'cooperative', 'worker']) {
            const { value, refusal } = normaliseConfig({ mode, origins: { images: ['https://cdn.example'] }, fetchBridge: { allow: ['https://api.example'] } }, context);
            expect(refusal, String(mode)).toBeNull();
            expect(value!.origins.images, String(mode)).toEqual(['https://cdn.example']);
            expect(value!.fetchPolicy!.allow, String(mode)).toEqual(['https://api.example']);
        }
    });

    it("no option of a sealed config reads a value of the host page: the host page's origin is never asked", () => {
        const context = { get hostOrigin(): string { throw new Error("the host page's origin was read"); } } as NormaliseContext;
        const every = {
            mode: 'sealed', html: '<p>x</p>', capabilities: ['allow-scripts'], unsafeCapabilities: ['allow-popups'], scriptUnsafe: true,
            hostContentSecurityPolicy: "default-src 'self'", entry: 'main.js', watchdogTimeout: 10, workerExecutionTimeout: 10, autoResize: true,
            callLimits: { maxPerSecond: 5 }, allowAnimations: true, allowAutoplay: true, guestWrites: true,
        };
        expect(Object.keys(every).sort()).toEqual(CONFIG_OPTIONS.filter(name => !(NETWORK_OPTIONS as readonly string[]).includes(name)).sort());
        for (const config of [{ mode: 'sealed' }, every]) {
            const { value, refusal } = normaliseConfig(config, context);
            expect(refusal).toBeNull();
            expect(value!.origins).toBe(NO_ORIGINS);
            expect(value!.fetchPolicy).toBeNull();
        }
    });
});

describe('T3: sealedViewPolicy can carry no network source', () => {
    const HASH = viewBootstrapHash();
    const subsets = (kinds: readonly SealedFileKind[]): SealedFileKind[][] => kinds.reduce<SealedFileKind[][]>((all, kind) => [...all, ...all.map(set => [...set, kind])], [[]]);
    const directives = (policy: string) => new Map(policy.split('; ').map(part => { const [name, ...sources] = part.split(' '); return [name!, sources]; }));
    const FETCH = ['img-src', 'font-src', 'media-src', 'connect-src'];
    const KIND_DIRECTIVE: Record<SealedFileKind, string> = { styles: 'style-src', images: 'img-src', fonts: 'font-src', media: 'media-src' };

    it('the input type has no origins: no key of it can hold an origin', () => {
        type Keys = keyof SealedPolicyInput;
        const noOrigins: 'origins' extends Keys ? false : true = true;
        expect(noOrigins).toBe(true);
        // @ts-expect-error the template takes no origins
        expect(() => sealedViewPolicy({ fileKinds: new Set(), bootstrapHash: HASH, scriptUnsafe: false, origins: NO_ORIGINS })).not.toThrow();
    });

    it('with no files: the documented policy, every fetch directive \'none\'', () => {
        expect(sealedViewPolicy({ fileKinds: new Set(), bootstrapHash: HASH, scriptUnsafe: false })).toBe(
            `default-src 'none'; script-src ${HASH}; script-src-attr 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'`,
        );
    });

    it('over every subset of file kinds, with and without scriptUnsafe: fetch directives are \'none\' or blob:, connect-src is \'none\', no source is a network one', () => {
        const all = subsets(SEALED_FILE_KINDS);
        expect(all).toHaveLength(16);
        for (const kinds of all) {
            for (const scriptUnsafe of [false, true]) {
                // a cast set that also holds connect and scripts (what strict's file kinds can hold) changes nothing
                const widened = new Set<string>([...kinds, 'connect', 'scripts']) as unknown as ReadonlySet<SealedFileKind>;
                const policy = sealedViewPolicy({ fileKinds: new Set(kinds), bootstrapHash: HASH, scriptUnsafe });
                expect(sealedViewPolicy({ fileKinds: widened, bootstrapHash: HASH, scriptUnsafe }), kinds.join()).toBe(policy);
                const parsed = directives(policy);
                expect(parsed.get('connect-src'), kinds.join()).toEqual(["'none'"]);
                for (const name of FETCH) expect(["'none'", 'blob:'], `${name} ${kinds.join()}`).toEqual(expect.arrayContaining(parsed.get(name)!));
                for (const kind of SEALED_FILE_KINDS) expect(parsed.get(KIND_DIRECTIVE[kind])!.includes('blob:'), `${kind} ${kinds.join()}`).toBe(kinds.includes(kind));
                expect(parsed.get('script-src')).toEqual([HASH, ...(scriptUnsafe ? ["'unsafe-eval'"] : [])]);
                for (const [name, sources] of parsed) {
                    for (const source of sources) {
                        const library = source === "'none'" || source === "'unsafe-inline'" || source === "'unsafe-eval'" || source === HASH || source === 'blob:';
                        expect(library, `${name} ${source}`).toBe(true);
                    }
                }
                expect(policy).not.toMatch(/https?:|wss?:|data:|\*|'self'/);
            }
        }
    });

    it('the element builds it: a sealed view has the sealed policy, with blob: for its files and guest writes, and its worker admits no request', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        el.registerFiles({ 'main.js': 'void 0', 'a.css': 'p{}', 'b.png': 'x', 'c.json': '{}' });
        el.setConfig({ mode: 'sealed', entry: 'main.js' });
        expect(el.state).toBe('loading');
        const kinds = new Set<SealedFileKind>(['styles', 'images']);
        expect(policyOf(el)).toBe(sealedViewPolicy({ fileKinds: kinds, bootstrapHash: HASH, scriptUnsafe: false }));
        expect([...fileKinds(['application/json'])]).toEqual(['connect']); // what strict would add blob: to connect-src for
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(1); // no bridge frame
        expect(el._strictInit.origins).toEqual({ images: [], media: [] });
        expect(el._strictInit.workerSource).toContain('"connect":[]');
        expect(wrapperOf(el)!.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
        el.setConfig({ mode: 'sealed', guestWrites: true });
        expect(directives(policyOf(el)).get('img-src')).toEqual(['blob:']);
    });
});

describe('the refusal, at the element: terminated at once with the reason', () => {
    it.each([
        ['origins', { origins: { images: ['https://cdn.example'] } }],
        ['fetchBridge', { fetchBridge: { allow: ['https://api.example'] } }],
    ])('a sealed config naming %s: no frame, state terminated, the reason; reset() keeps it closed; a sealed config without it builds', async (_, network) => {
        const el = await mount();
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        el.setConfig({ mode: 'sealed', ...network });
        expect(el.state).toBe('terminated');
        expect(wrapperOf(el)).toBeNull();
        expect(el._config.mode).toBe('cooperative'); // nothing of the refused config was applied
        await settled();
        expect(reasons).toEqual([REASON]);
        el.reset();
        await settled();
        expect([el.state, wrapperOf(el)]).toEqual(['terminated', null]);
        expect(reasons).toEqual([REASON, REASON]);
        el.setConfig({ mode: 'sealed' });
        expect(el.state).toBe('loading');
        expect(el._config.mode).toBe('sealed');
        expect(policyOf(el)).toContain("connect-src 'none'");
    });
});
