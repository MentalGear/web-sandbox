import '@src/network'; // the network build: this file tests modes and options the default build does not have (ADR-009)
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { code, graphOf, member, reach } from './call-graph';
import { hostPageOrigin, hostSiteOrigins } from '@src/lib/host-site';
import { hostReach } from '@src/lib/csp/host-connect';
import { parseOrigins } from '@src/lib/csp/origins';
import { createFetchBridge, toFetchPolicy } from '@src/lib/fetch-bridge';
import { createBridgeFrame, prepareBridgeFrame } from '@src/lib/bridge-frame';
import { connectSources, cooperativePolicy, sealedViewPolicy, strictViewPolicy, type SealedFileKind } from '@src/lib/csp/csp-generator';
import { CONFIG_SCHEMA, NETWORK_OPTIONS, normaliseConfig, readIn, type NormaliseContext } from '@src/lib/config-schema';
import { bootstrapListeners, budgetsTable, CHANNEL_BUDGETS, EGRESS, UNCAUGHT_CHARACTERS_PER_SECOND, UNCAUGHT_PER_SECOND } from '@src/lib/egress';
import { INHERITED_CONTEXT, inheritedContextRows } from '@src/lib/inherited-context';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { createBroker } from '@src/lib/rpc';
import { createSizeOf } from '@src/lib/structured-size';
import { viewBootstrapHash } from '@src/lib/in-sandbox-view';
import { limitValues } from '@src/lib/limits';
import { refuseCodeFromStrings } from '@src/lib/code-from-strings';
import { reasonText } from '@src/lib/reasons';
import { inheritedContext } from '../../tools/docgen/extractors/inherited-context';
import { startWith } from './start-app';

/**
 * Sealed mode's build path (docs/research/24_sealed_mode, step 2): strict mode's view and worker with no network, and no
 * read of the host page but `crossOriginIsolated`, by construction: the sealed path never reaches the code that reads the
 * host page's origin or opens a network, rather than reaching it with empty inputs. Research 24's tests T4, T5, T6 and T9,
 * and the host page's origin. Each one has strict mode with a network as its positive control, so it fails when a
 * network path comes back into sealed mode, whatever the path.
 *
 * The network code is watched at run time (every function below wrapped in a spy that calls the original) and by a call
 * graph of the source (T5).
 */

vi.mock('@src/lib/host-site', async (original) => {
    const actual = await original<typeof import('@src/lib/host-site')>();
    return { ...actual, hostPageOrigin: vi.fn(actual.hostPageOrigin), hostSiteOrigins: vi.fn(actual.hostSiteOrigins) };
});
vi.mock('@src/lib/csp/host-connect', async (original) => {
    const actual = await original<typeof import('@src/lib/csp/host-connect')>();
    return { ...actual, hostReach: vi.fn(actual.hostReach) };
});
vi.mock('@src/lib/csp/origins', async (original) => {
    const actual = await original<typeof import('@src/lib/csp/origins')>();
    return { ...actual, parseOrigins: vi.fn(actual.parseOrigins) };
});
vi.mock('@src/lib/fetch-bridge', async (original) => {
    const actual = await original<typeof import('@src/lib/fetch-bridge')>();
    return { ...actual, toFetchPolicy: vi.fn(actual.toFetchPolicy), createFetchBridge: vi.fn(actual.createFetchBridge) };
});
vi.mock('@src/lib/bridge-frame', async (original) => {
    const actual = await original<typeof import('@src/lib/bridge-frame')>();
    return { ...actual, prepareBridgeFrame: vi.fn(actual.prepareBridgeFrame), createBridgeFrame: vi.fn(actual.createBridgeFrame) };
});
vi.mock('@src/lib/csp/csp-generator', async (original) => {
    const actual = await original<typeof import('@src/lib/csp/csp-generator')>();
    return { ...actual, connectSources: vi.fn(actual.connectSources), strictViewPolicy: vi.fn(actual.strictViewPolicy), cooperativePolicy: vi.fn(actual.cooperativePolicy) };
});


/** The network code, and the reads of the host page's origin and site: none may run on the sealed path. */
const NETWORK = { hostPageOrigin, hostSiteOrigins, hostReach, parseOrigins, toFetchPolicy, createFetchBridge, prepareBridgeFrame, createBridgeFrame, connectSources, strictViewPolicy, cooperativePolicy } as unknown as Record<string, ReturnType<typeof vi.fn>>;
const called = () => Object.keys(NETWORK).filter(name => NETWORK[name]!.mock.calls.length > 0).sort();

const HASH = viewBootstrapHash();
const LISTED = 'https://cdn.listed.example';
const API = 'https://api.listed.example';
/** Strict mode with every network option: the positive control. `false`: the page sends no policy, so the lists stay. */
const STRICT_NETWORK = { mode: 'strict', origins: { images: [LISTED], media: [LISTED], connect: [API] }, fetchBridge: { allow: [API] }, hostContentSecurityPolicy: false };
/** Every option sealed mode takes, each set (scriptUnsafe to the one value sealed mode takes: true refuses the config). */
const SEALED_EVERY = {
    mode: 'sealed', html: '<p onclick="x()">x</p><script>y()</script>', capabilities: ['allow-scripts'], scriptUnsafe: false, hostContentSecurityPolicy: "default-src 'self'",
    entry: 'main.js', watchdogTimeout: 10_000, workerExecutionTimeout: 10_000, autoResize: true, callLimits: { maxPerSecond: 5 }, allowAnimations: true, allowAutoplay: true, guestWrites: true,
};

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const wrapperOf = (el: HTMLElement) => el.shadowRoot!.querySelector('iframe');
const policyOf = (el: HTMLElement) => parse(parse(wrapperOf(el)!.srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!).querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
const directives = (policy: string) => new Map(policy.split('; ').map(part => { const [name, ...sources] = part.split(' '); return [name!, sources]; }));
/** The bootstrap's features literal in a strict or sealed worker's source: the argument before createSizeOf's source. */
const featuresOf = (source: string): Record<string, unknown> => {
    const start = source.indexOf('{"externalPort"');
    expect(start).toBeGreaterThan(0);
    return JSON.parse(source.slice(start, source.indexOf(', function createSizeOf', start)));
};
/** Whether a policy has a source that names the network (a scheme, a host, `*`, `'self'` or `data:`). */
const networkSources = (policy: string) => [...directives(policy).values()].flat().filter(source => /^(https?:|wss?:|data:|\*|'self')|\./.test(source) && !source.startsWith("'sha256-"));

async function mount() {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    return el;
}

/** A new element in the document, started with `config` and the app's `files`. */
const started = async (config: Record<string, unknown>, files?: Record<string, unknown>) => startWith(await mount(), config, { files });

const clearNetwork = () => {
    for (const fn of Object.values(NETWORK)) fn.mockClear();
};

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const fn of Object.values(NETWORK)) fn.mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as any).bridge;
    delete (globalThis as any).sandboxFetch;
    document.body.replaceChildren();
});

// ---- the host page's origin, and the network code, at run time

describe("the sealed path reads nothing of the host page's origin or site, and runs no network code", () => {
    it('start(), reset(), a removal and an insertion, after a strict element: no read of the host page and no network code, in the config or the build', async () => {
        const FILES = { 'main.js': 'void 0', 'a.css': 'p { color: red }', 'b.png': 'x', 'c.json': '{}' };
        await started({ mode: 'strict' }, FILES); // a strict build first, which runs the network code
        clearNetwork();
        const el = await started(SEALED_EVERY, FILES);
        expect(el.state).toBe('loading');
        el.reset();
        el.remove();
        document.body.appendChild(el);
        const plain = await started({ mode: 'sealed' }, { ...FILES, 'd.css': 'p { color: blue }' });
        const undefinedOptions = await started({ mode: 'sealed', origins: undefined, fetchBridge: undefined });
        expect([el.state, plain.state, undefinedOptions.state]).toEqual(['loading', 'loading', 'loading']);
        expect(called()).toEqual([]);

        // a strict build with a bridge, then a sealed element: it reads nothing, and has no bridge
        const strict = await started(STRICT_NETWORK);
        expect(strict.shadowRoot.querySelectorAll('iframe')).toHaveLength(2);
        clearNetwork();
        const sealed = await started({ mode: 'sealed' });
        expect(called()).toEqual([]);
        expect(sealed.shadowRoot.querySelectorAll('iframe')).toHaveLength(1);
        expect([sealed._fetchBridge, sealed._bridgeFrame]).toEqual([null, null]);
    });

    it('positive control: strict mode with origins and fetchBridge runs every one of them, the host page read in the config and the bridge at attach', async () => {
        clearNetwork();
        await started(STRICT_NETWORK);
        expect(called()).toEqual(Object.keys(NETWORK).filter(name => name !== 'cooperativePolicy').sort());
        clearNetwork();
        await started({ ...STRICT_NETWORK, mode: 'cooperative', capabilities: ['allow-scripts'] });
        expect(called()).toContain('cooperativePolicy');
        expect(called()).toContain('hostPageOrigin');
    });

    it("normaliseConfig: a sealed config never asks for the host page (its function is not called); strict, cooperative and worker configs ask once", () => {
        let asked = 0;
        const page = (): NormaliseContext => { asked++; return { hostOrigin: 'https://app.example', hostSites: ['https://app.example'] }; };
        for (const config of [{ mode: 'sealed' }, {}, SEALED_EVERY]) {
            const { value, refusal } = normaliseConfig(config, page);
            expect([refusal, value!.fetchPolicy, value!.origins.connect, value!.origins.images]).toEqual([null, null, [], []]);
        }
        expect(asked).toBe(0);
        for (const mode of ['strict', 'cooperative', 'worker']) {
            asked = 0;
            normaliseConfig({ mode, origins: { connect: [API] }, fetchBridge: { allow: [API] } }, page);
            expect(asked, String(mode)).toBe(1); // once per argument, for both rules
        }
    });

    it('readIn: sealed mode runs no rule of the network options; every other mode runs them all (the schema\'s order)', () => {
        const names = Object.keys(CONFIG_SCHEMA);
        expect(readIn('sealed')).toEqual(names.filter(name => !(NETWORK_OPTIONS as readonly string[]).includes(name)));
        for (const mode of ['strict', 'cooperative', 'worker', 'iframe', undefined]) expect(readIn(mode), String(mode)).toEqual(names);
    });
});

// ---- T4: what the sealed build wires, at the element

describe('T4: a sealed build wires no network source: its policy, its gate list, no bridge frame, nothing about origins in INIT_VIEW', () => {
    const build = async (config: Record<string, unknown>) => {
        const el = await started({ ...config, entry: 'main.js' }, { 'main.js': 'void 0', 'a.css': 'p {}', 'b.png': 'x', 'c.json': '{}', 'd.woff2': 'x', 'e.mp4': 'x' });
        expect(el.state).toBe('loading');
        return { el, prepared: el._prepareBuild(), features: featuresOf(el._strictInit.workerSource) };
    };

    it('sealed: the view policy is sealedViewPolicy over its file kinds, no gate and no gate list, sandboxFetch() refuses in the guest, one frame, INIT_VIEW names no origins, the build has no network', async () => {
        const { el, prepared, features } = await build({ mode: 'sealed' });
        const kinds = new Set<SealedFileKind>(['styles', 'images', 'fonts', 'media']);
        expect(policyOf(el)).toBe(sealedViewPolicy({ fileKinds: kinds, bootstrapHash: HASH }));
        expect(networkSources(policyOf(el))).toEqual([]);
        expect(directives(policyOf(el)).get('connect-src')).toEqual(["'none'"]);
        expect(features).not.toHaveProperty('connect');
        expect(features.sealed).toBe(true);
        expect(el._strictInit.workerSource).not.toContain('function requestGate(');
        expect(features).not.toHaveProperty('fetchBridge');
        // the prelude's text: the ready line names the build's own mode, and the prelude is built as strict mode's (BD7:NEW-1)
        expect(el._strictInit.workerSource).toMatch(/\? ?['"]sealed['"] ?: ?mode\} Ready/);
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(1);
        expect(Object.keys(el._strictInit)).not.toContain('origins');
        expect(prepared.network).toBeNull();
        expect(Object.keys(prepared.strictInit)).not.toContain('origins');
    });

    it('positive control: strict mode with origins and fetchBridge lists them in the policy, the gate and INIT_VIEW, and builds the bridge frame', async () => {
        const { el, prepared, features } = await build(STRICT_NETWORK);
        expect(networkSources(policyOf(el))).toEqual(expect.arrayContaining([LISTED, API]));
        expect(features.connect).toEqual(expect.arrayContaining([API]));
        expect(features).not.toHaveProperty('sealed');
        expect(features.fetchBridge).toEqual({ timeoutMs: expect.any(Number) });
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(2);
        expect(el._strictInit.origins).toEqual({ images: [LISTED], media: [LISTED] });
        expect(prepared.network.bridgeFrame).toBeInstanceOf(HTMLIFrameElement);
        // and strict mode with no option still has its (empty) lists: the field is strict mode's, absent only in sealed mode
        const plain = await build({ mode: 'strict' });
        expect(plain.el._strictInit.origins).toEqual({ images: [], media: [] });
        expect(plain.prepared.network).toEqual({ bridgeFrame: null, fetchPolicy: null });
    });
});

// ---- nothing of the host page's other state is carried into what the guest sees (BD5:TST-2)

describe("a sealed build carries no state of the host page into the worker's features, INIT_VIEW or the view's document", () => {
    // The scan of host-site.test.ts lists the members of the page a host-side file must not read; a list cannot hold what
    // nobody thought of. This is the same property from the other side: every kind of state the harness page can hold is
    // given a marker, and the marker must be in nothing the build hands the guest, whatever read put it there.
    const MARK = 'HOSTMARK-7f3a91';
    const poison = () => {
        document.title = `${MARK}-title`;
        document.documentElement.lang = `${MARK}-lang`;
        document.documentElement.setAttribute('data-host', `${MARK}-attribute`);
        document.body.setAttribute('data-host', `${MARK}-body`);
        document.head.insertAdjacentHTML('beforeend', `<meta name="description" content="${MARK}-meta"><meta name="viewport" content="${MARK}-viewport"><link rel="canonical" href="https://canonical.example/${MARK}">`);
        document.body.insertAdjacentHTML('beforeend', `<input id="host-field" value="${MARK}-field"><p id="host-text">${MARK}-text</p>`);
        window.name = `${MARK}-window-name`;
        window.history.replaceState({ host: `${MARK}-state` }, '', `#${MARK}-hash`);
        try { localStorage.setItem('host', `${MARK}-local`); sessionStorage.setItem('host', `${MARK}-session`); } catch { /* a jsdom origin without storage */ }
        document.cookie = `host=${MARK}-cookie`;
    };

    /** Everything a sealed build hands the guest, as text: the wrapper and view documents, INIT_VIEW (the worker's source included), each registered file. */
    const handedOver = (el: any): string => [wrapperOf(el)!.srcdoc, JSON.stringify(el._strictInit), JSON.stringify(el._prepareBuild().strictInit)].join('\n');

    it('markers in the title, the markup, the name, the history, the storage and the cookies appear in none of it, in the default mode and with every option set', async () => {
        poison();
        const control = document.title;
        expect(control).toContain(MARK); // the markers are in the page
        for (const config of [{ mode: 'sealed' }, {}, SEALED_EVERY]) {
            const el = await started({ ...config, entry: 'main.js', html: '<p>hello</p>' }, { 'main.js': 'void 0', 'a.css': 'p {}' });
            expect(el.state, JSON.stringify(config)).toBe('loading');
            const text = handedOver(el);
            expect(text.length).toBeGreaterThan(1000); // it reads what the build hands over, not an empty string
            expect(text, JSON.stringify(config)).not.toContain(MARK);
            el.remove();
        }
    });

    it('the check sees a leak: with the page title put into the features, the marker is found', async () => {
        poison();
        const el = await started({ mode: 'sealed', html: `<p>${document.title}</p>` }); // the leak the check is for, made by hand
        expect(handedOver(el)).toContain(MARK);
    });
});

// ---- the guest's sandboxFetch() in sealed mode (owner decision D4): refused in the guest, nothing sent

// Event classes as the platform makes them, and a port whose postMessage keeps what it is given (the bootstrap posts
// through MessagePort.prototype's, captured), as test/unit/egress.test.ts runs a bootstrap.
class TrustedEvent {
    readonly isTrusted = true;
    preventDefault() {}
    stopImmediatePropagation() {}
}
class KeptPort {
    frames: any[] = [];
    postMessage(frame: unknown) { (this.frames ??= []).push(structuredClone(frame)); }
    set onmessage(_handler: unknown) {}
}

function strictBootstrap(features: Record<string, unknown>) {
    vi.stubGlobal('addEventListener', () => {});
    vi.stubGlobal('Event', TrustedEvent);
    vi.stubGlobal('ErrorEvent', TrustedEvent);
    vi.stubGlobal('PromiseRejectionEvent', TrustedEvent);
    vi.stubGlobal('close', () => {});
    vi.stubGlobal('MessagePort', KeptPort);
    const port = new KeptPort();
    const all = { externalPort: true, callBudget: { calls: 1000, bytes: 67108864 }, uncaught: { count: UNCAUGHT_PER_SECOND, characters: UNCAUGHT_CHARACTERS_PER_SECOND }, ...features };
    const comms = inSandboxScript(false, 'strict', new Proxy({}, { get: () => () => {} }) as Console, createBroker, all as any, createSizeOf);
    comms.attach(port as unknown as MessagePort);
    return { requests: () => port.frames.filter(frame => frame?.type === 'RPC_REQ') };
}

describe("sealed mode's sandboxFetch(): defined, and refused in the guest with FETCH_NOT_ALLOWED, sending nothing to the host", () => {
    it('sealed: rejects FETCH_NOT_ALLOWED, posts no frame, and reads nothing of its arguments', async () => {
        const { requests } = strictBootstrap({ listeners: bootstrapListeners('sealed'), connect: [], sealed: true });
        expect(typeof (globalThis as any).sandboxFetch).toBe('function');
        let reads = 0;
        const init = new Proxy({}, { get: () => { reads++; return 'POST'; } });
        const refusal = await (globalThis as any).sandboxFetch(`${API}/x`, init).then(() => null, (error: unknown) => error);
        expect(refusal).toBeInstanceOf(Error);
        expect(refusal).toMatchObject({ code: 'FETCH_NOT_ALLOWED', message: '[sandboxFetch] FETCH_NOT_ALLOWED: sealed mode has no network' });
        expect(Object.getOwnPropertyDescriptor(refusal, 'code')).toMatchObject({ enumerable: true }); // as the host's refusal carries it
        expect(reads).toBe(0);
        expect(requests()).toEqual([]);
    });

    it("positive control: strict mode's sandboxFetch() sends the request to the host's reserved method", () => {
        const { requests } = strictBootstrap({ listeners: bootstrapListeners('strict'), connect: [API] });
        void (globalThis as any).sandboxFetch(`${API}/x`).catch(() => {});
        expect(requests().map(frame => frame.method)).toEqual(['sandbox:fetch']);
    });
});

// ---- T5: the call graph of the sealed path, from the source (test/unit/call-graph.ts)

/** The network code by node: the reads of the host page, the narrowing, the origins, the bridge, the non-sealed templates. */
const FORBIDDEN = [
    'src/lib/host-site.ts#hostPageOrigin', 'src/lib/host-site.ts#hostSiteOrigins', 'src/lib/network-config.ts#readHostPage',
    'src/lib/csp/host-connect.ts#hostReach', 'src/lib/csp/origins.ts#parseOrigins', 'src/lib/network-config.ts#limitHostReach',
    'src/lib/fetch-bridge.ts#toFetchPolicy', 'src/lib/fetch-bridge.ts#createFetchBridge',
    'src/lib/bridge-frame.ts#prepareBridgeFrame', 'src/lib/bridge-frame.ts#createBridgeFrame', 'src/lib/frame-documents.ts#buildBridgeDocument',
    'src/lib/csp/csp-generator.ts#connectSources', 'src/lib/csp/csp-generator.ts#strictViewPolicy', 'src/lib/csp/csp-generator.ts#cooperativePolicy', 'src/lib/csp/csp-generator.ts#bridgeFramePolicy',
    'src/lib/network-host.ts#this._reach', 'src/lib/network-host.ts#this._startFetchBridge', 'src/lib/network-host.ts#this._prepareNetwork', 'src/lib/network-host.ts#this._gateConnect', 'src/lib/network-host.ts#this._guestPolicy', 'src/lib/network-host.ts#this._policyInput',
];
const forbiddenIn = (paths: Map<string, string[]>) => FORBIDDEN.filter(node => paths.has(node)).map(node => paths.get(node)!.join(' → '));


describe('T5: the call graph of the sealed build path reaches no network code', () => {
    // _prepareBuild up to the end of its sealed branch: what runs for a sealed build before it returns
    const sealedPrefix = () => {
        const body = member('_prepareBuild');
        const branch = body.indexOf("if (this._config.mode === 'sealed') {");
        expect(branch, 'the sealed branch of _prepareBuild').toBeGreaterThan(0);
        const end = body.indexOf('}', branch);
        return body.slice(0, end + 1);
    };

    it('the graph sees what it must: every network node is code it can read, and _prepareBuild as a whole reaches them (positive control)', () => {
        for (const node of FORBIDDEN) {
            const [file, name] = node.split('#') as [string, string];
            expect(graphOf(file).units.has(name), node).toBe(true);
        }
        const whole = reach('src/host.ts', member('_prepareBuild'));
        expect(forbiddenIn(whole).map(trail => trail.split(' → ').at(-1))).toEqual(expect.arrayContaining([
            'src/lib/network-host.ts#this._reach', 'src/lib/csp/host-connect.ts#hostReach', 'src/lib/network-host.ts#this._prepareNetwork', 'src/lib/bridge-frame.ts#prepareBridgeFrame',
            'src/lib/csp/csp-generator.ts#connectSources', 'src/lib/csp/csp-generator.ts#strictViewPolicy', 'src/lib/csp/csp-generator.ts#cooperativePolicy',
        ]));
        // and strict mode's own frame reaches the narrowing's output, the gate list, the template and the bridge
        expect(forbiddenIn(reach('src/lib/network-host.ts', member('_prepareStrictFrame'))).length).toBeGreaterThan(0);
        // the attach reaches the bridge, and through it the host page's origin: what the sealed attach must not run
        expect(forbiddenIn(reach('src/host.ts', member('_attachBuild'))).map(trail => trail.split(' → ').at(-1))).toEqual(expect.arrayContaining([
            'src/lib/network-host.ts#this._startFetchBridge', 'src/lib/bridge-frame.ts#createBridgeFrame', 'src/lib/fetch-bridge.ts#createFetchBridge', 'src/lib/host-site.ts#hostPageOrigin',
        ]));
    });

    it('the sealed branch is the first thing _prepareBuild decides by mode, and nothing before it or in it reaches network code', () => {
        const prefix = sealedPrefix();
        expect(prefix.indexOf('this._reach(')).toBe(-1);
        expect(prefix).toMatch(/if \(this\._config\.mode === 'sealed'\) \{\s*this\._refuseByTrustedTypes\(\);\s*return this\._prepareSealedFrame\(built, files\);\s*\}$/);
        expect(forbiddenIn(reach('src/host.ts', prefix))).toEqual([]);
        expect(reach('src/host.ts', prefix).has('src/host.ts#this._prepareSealedFrame')).toBe(true);
    });

    it('the sealed frame (_prepareSealedFrame, the shared view, the worker source, the sealed policy) reaches no network code, and returns no network', () => {
        const paths = reach('src/host.ts', member('_prepareSealedFrame'));
        expect(forbiddenIn(paths)).toEqual([]);
        for (const node of ['src/host.ts#this._prepareViewFrame', 'src/host.ts#this._getStrictWorkerSource', 'src/host.ts#this._sealedPolicy', 'src/lib/csp/csp-generator.ts#sealedViewPolicy']) expect(paths.has(node), node).toBe(true);
        expect(member('_prepareSealedFrame')).toMatch(/return this\._prepareViewFrame\(built, files, this\._sealedPolicy\(files\), null\);\s*$/);
        expect(member('_prepareViewFrame')).toMatch(/return \{ iframe, built, strictInit, network: null \};\s*$/);
    });

    it("the attach runs the network only for a build that has one: without that statement it reaches no network code, and a sealed build has none (T4)", () => {
        const attach = member('_attachBuild');
        const guarded = 'prepared.network ? networkElement(this)?._startFetchBridge(prepared.network) ?? null : null;';
        expect(attach.split(guarded)).toHaveLength(2);
        expect(forbiddenIn(reach('src/host.ts', attach.replace(guarded, '')))).toEqual([]);
    });

    it("the host page's origin and site are read nowhere in the element's class, and in two places of the network modes: readHostPage (the config, when a network rule asks) and the bridge's start", () => {
        const readersIn = (file: string) => [...graphOf(file).units].filter(([, body]) => /\bhostPageOrigin\(|\bhostSiteOrigins\(/.test(body)).map(([name]) => name).sort();
        expect(readersIn('src/host.ts')).toEqual([]);
        expect(readersIn('src/lib/network-config.ts')).toEqual(['readHostPage']);
        expect(readersIn('src/lib/network-host.ts')).toEqual(['this._startFetchBridge']);
        // the class hands the config the reader the seam holds, which a build without the network modes does not have
        expect(member('start')).toContain('readStart(app, grants, networkModes()?.readHostPage ?? NO_HOST_PAGE)');
    });

    it("the host page is asked (host()) only by the rules of the network options, which are the network modes' (network-config.ts) and which sealed mode never runs (readIn)", () => {
        // config-schema.ts defines `host` and never calls it: no rule of its own reads the host page
        expect([...code('src/lib/config-schema.ts').matchAll(/\bhost\(\)/g)]).toEqual([]);
        const text = code('src/lib/network-config.ts');
        const asks = [...text.matchAll(/\bhost\(\)/g)].map(match => match.index!);
        const table = text.indexOf('\nexport const NETWORK_RULES = {');
        const rules = [[table, text.indexOf('\n} as const;', table)] as const];
        expect(table, 'the network rules').toBeGreaterThan(0);
        for (const name of NETWORK_OPTIONS) expect(text.slice(...rules[0]!), name).toContain(`\n    ${name}: (`);
        // the asks are inside the two rules, and nowhere else
        const outside = asks.filter(index => !rules.some(([start, end]) => index > start && index < end));
        expect(outside.map(index => text.slice(index - 40, index + 10).trim())).toEqual([]);
        expect(asks.length).toBeGreaterThanOrEqual(NETWORK_OPTIONS.length);
        expect(readIn('sealed').some(name => (NETWORK_OPTIONS as readonly string[]).includes(name))).toBe(false);
    });
});

// ---- T6: the egress table's sealed column

describe("T6: the egress table's sealed column: every surface of sealed mode is strict mode's but the bridge's, and no channel reaches the network but the embedder's links", () => {
    it('the sealed column is the strict column without the bridge frame: every row that lists sealed is strict\'s, and no bridge-frame row lists it', () => {
        const key = (row: (typeof EGRESS)[number]) => `${row.realm}|${row.surface}|${row.owner}`;
        const sealed = EGRESS.filter(row => row.modes.includes('sealed')).map(key).sort();
        const strict = EGRESS.filter(row => row.modes.includes('strict') && row.realm !== 'bridge-frame').map(key).sort();
        expect(sealed).toEqual(strict);
        expect(EGRESS.filter(row => row.realm === 'bridge-frame' && row.modes.includes('sealed'))).toEqual([]);
        // positive control: strict mode has the bridge frame's surfaces
        expect(EGRESS.filter(row => row.realm === 'bridge-frame' && row.modes.includes('strict')).length).toBeGreaterThan(0);
        expect(bootstrapListeners('sealed')).toEqual(bootstrapListeners('strict'));
    });

    it('the sealed build installs the listeners of its column and has none of the realms the column leaves out: no bridge frame; strict mode with fetchBridge has one', async () => {
        const el = await started({ mode: 'sealed' });
        expect(featuresOf(el._strictInit.workerSource).listeners).toEqual(bootstrapListeners('sealed'));
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(1);
        const strict = await started(STRICT_NETWORK);
        expect(featuresOf(strict._strictInit.workerSource).listeners).toEqual(bootstrapListeners('strict'));
        expect(strict.shadowRoot.querySelectorAll('iframe')).toHaveLength(2);
    });

    it("every channel says what it reaches of the network in sealed mode, none but the embedder's links, and the build bears out the two that could: the view's loads and sandboxFetch()", async () => {
        for (const row of CHANNEL_BUDGETS) expect(row.sealed, row.channel).toMatch(/^(none\b|only\b|not a channel of sealed mode$)/);
        const channel = (start: string) => CHANNEL_BUDGETS.find(row => row.channel.startsWith(start))!;
        // the one channel that reaches beyond the host page is the embedder's own grant, the URLs of `links` (design 02, I6)
        expect(CHANNEL_BUDGETS.filter(row => row.sealed.startsWith('only')).map(row => row.channel)).toEqual([channel('Strict and sealed: the user\'s click on a link the view marked').channel]);
        expect(channel('Strict and sealed: the user\'s click on a link the view marked').sealed).toContain('only the URLs the embedder lists in `links`');
        expect(channel('`sandboxFetch()`').sealed).toContain('rejects in the guest');
        expect(channel("Strict: the view's loads").sealed).toContain('`blob:`');
        // the view's loads: no network source in the sealed view's policy; strict mode's lists its origins (positive control)
        const el = await started({ mode: 'sealed', guestWrites: true }, { 'b.png': 'x' });
        expect(networkSources(policyOf(el))).toEqual([]);
        expect(directives(policyOf(el)).get('img-src')).toEqual(['blob:']);
        expect(networkSources(policyOf(await started(STRICT_NETWORK, { 'b.png': 'x' })))).toContain(LISTED);
        // sandboxFetch(): the sealed worker's bootstrap is told so (the guest's refusal: the describe above)
        expect(featuresOf((await started({ mode: 'sealed' }))._strictInit.workerSource).sealed).toBe(true);
    });

    it('docs/API.md renders the column', () => {
        const table = budgetsTable(limitValues());
        expect(table.split('\n')[0]).toContain('| Network in sealed mode |');
        for (const row of CHANNEL_BUDGETS) expect(table).toContain(row.sealed.replace(/\|/g, '\\|'));
    });
});

// ---- T9: INHERITED_CONTEXT's sealed field

describe("T9: every row of the host page's context says what it is in sealed mode, and the build bears out the rows sealed mode drops", () => {
    it('every row has its standing; a row that does not apply says why; 15 remain, 3 are reduced, 5 do not apply (research 24, §1.4; the autofill row, research 29)', () => {
        const rows = inheritedContextRows();
        for (const row of rows) {
            expect(['remains', 'reduced', 'not-applicable'], row.id).toContain(row.sealed?.standing);
            if (row.sealed.standing === 'not-applicable') expect(['no-network', 'no-guest-document'], row.id).toContain(row.sealed.because);
            if (row.sealed.standing !== 'remains') expect(row.sealed.note!.length, row.id).toBeGreaterThan(5);
        }
        const by = (standing: string) => rows.filter(row => row.sealed.standing === standing).map(row => row.id).sort();
        expect(by('not-applicable')).toEqual(['ancestorOrigins', 'cookies', 'referrer', 'serviceWorker', 'uiSurfaces']);
        expect(by('reduced')).toEqual(['autofill', 'cspFetch', 'cspReporting']);
        expect(by('remains')).toHaveLength(15);
        expect(rows).toHaveLength(Object.keys(INHERITED_CONTEXT).length);
    });

    it("the rows dropped for 'no-network' and the reduced cspFetch: a sealed build makes no request path (no network source, no request gate, no bridge frame, no origins); strict mode with a network has each (positive control)", async () => {
        const noNetwork = inheritedContextRows().filter(row => row.sealed.standing === 'not-applicable' && row.sealed.because === 'no-network').map(row => row.id);
        expect(noNetwork.sort()).toEqual(['cookies', 'referrer', 'serviceWorker']);
        const paths = async (config: Record<string, unknown>) => {
            const el = await started(config, { 'a.css': 'p {}', 'b.png': 'x' });
            const policy = directives(policyOf(el));
            return {
                sources: networkSources(policyOf(el)),
                fetchSources: ['img-src', 'font-src', 'media-src', 'style-src', 'connect-src'].flatMap(name => policy.get(name)!).filter(source => !["'none'", "'unsafe-inline'", 'blob:'].includes(source)),
                gate: (el._strictInit.workerSource as string).includes('function requestGate('),
                connect: featuresOf(el._strictInit.workerSource).connect as string[] | undefined,
                bridge: el.shadowRoot.querySelectorAll('iframe').length > 1,
                origins: Object.keys(el._strictInit).includes('origins'),
            };
        };
        expect(await paths({ mode: 'sealed' })).toEqual({ sources: [], fetchSources: [], gate: false, connect: undefined, bridge: false, origins: false });
        const strict = await paths(STRICT_NETWORK);
        expect(strict.sources.length).toBeGreaterThan(0);
        expect(strict.fetchSources.length).toBeGreaterThan(0);
        expect(strict.gate).toBe(true);
        expect(strict.connect!.length).toBeGreaterThan(0);
        expect([strict.bridge, strict.origins]).toEqual([true, true]);
    });

    it("the rows dropped for 'no-guest-document': a sealed build is the strict view, which has none; a cooperative build has one (positive control)", async () => {
        const rows = inheritedContextRows().filter(row => row.sealed.standing === 'not-applicable' && row.sealed.because === 'no-guest-document').map(row => row.id);
        expect(rows.sort()).toEqual(['ancestorOrigins', 'uiSurfaces']);
        expect((await started({ mode: 'sealed' }))._prepareBuild().strictInit).not.toBeNull();
        expect((await started({ mode: 'cooperative', capabilities: ['allow-scripts'] }))._prepareBuild().strictInit).toBeNull();
    });

    it("docs/THREAT-MODEL.md renders the column", () => {
        const table = inheritedContext.regions['inherited-context']!();
        expect(table.split('\n')[0]).toContain('| Sealed mode |');
        expect(table).toContain('N/A: no request leaves');
        expect(table).toContain('reduced: no origin is narrowed');
    });
});

// ---- the strict-html warning in the mode's words

describe("the warning about scripts in `html` names sealed mode in sealed mode", () => {
    it('sealed says sealed mode (the default), once per element; strict says strict mode', async () => {
        const warn = vi.mocked(console.warn);
        // what the view noted it dropped of the initial view (VIEW_INITIAL), which the element warns from (BD7:LIM-1)
        const viewDropped = (el: any, dropped: string[]) => {
            const { port1 } = new MessageChannel();
            el._viewPort = port1;
            el._onViewMessage(port1, { type: 'VIEW_INITIAL', dropped });
            port1.close();
        };
        const el = await started({ mode: 'sealed', html: '<script>x()</script><p onclick="y()">y</p>' });
        viewDropped(el, ['script']);
        el.reset();
        viewDropped(el, ['handler']);
        const said = () => warn.mock.calls.map(call => String(call[0])).filter(message => message.includes('runs no script in `html`'));
        expect(said()).toEqual(["[Sandbox] sealed mode (the default) runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`."]);
        viewDropped(await started({ mode: 'strict', html: '<script>x()</script>' }), ['script']);
        expect(said()[1]).toBe("[Sandbox] strict mode runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`.");
    });

    it("a registered stylesheet's network URL: sealed mode's warning names no origin to list, strict mode's does", async () => {
        const warn = vi.mocked(console.warn);
        const files = { 'a.css': `p { background: url(${LISTED}/x.png) }` };
        await started({ mode: 'sealed' }, files);
        await started({ mode: 'strict' }, files);
        const said = warn.mock.calls.map(call => String(call[0])).filter(message => message.includes('registered stylesheet "a.css"'));
        expect(said).toHaveLength(2);
        expect(said[0]).toMatch(/^\[Sandbox\] sealed mode: .*sealed mode has no network\. Register the file instead\.$/);
        expect(said[0]).not.toContain('origins');
        expect(said[1]).toMatch(/^\[Sandbox\] strict mode: .*from an origin listed in origins\.$/);
    });
});

// ---- BD7:TST-2: sealed mode's wirings, held by the unit run as well as by the e2e specs

describe("sealed mode's wirings are held by the unit run: the code-from-string refusal and the entry's import refusal (BD7:TST-2)", () => {
    const refusal = refuseCodeFromStrings.toString();

    it("the worker's source holds the code-from-string refusal exactly when scriptUnsafe is off: always in sealed mode, in strict mode without scriptUnsafe", async () => {
        const sourceOf = async (config: Record<string, unknown>) => {
            const el = await started(config, { 'main.js': 'void 0' });
            expect(el.state, JSON.stringify(config)).toBe('loading');
            return el._strictInit.workerSource as string;
        };
        for (const config of [{}, { mode: 'sealed' }, { mode: 'sealed', entry: 'main.js' }, { mode: 'strict' }, { mode: 'strict', entry: 'main.js' }]) {
            const source = await sourceOf(config);
            expect(source.split(refusal), `${JSON.stringify(config)}: the refusal runs once, before the entry`).toHaveLength(2);
            expect(source.indexOf(refusal), JSON.stringify(config)).toBeLessThan(source.indexOf('\n(function () {\n'));
        }
        // positive control: strict mode's scriptUnsafe runs strings as code, so its worker has no refusal
        expect((await sourceOf({ mode: 'strict', scriptUnsafe: true })).includes(refusal)).toBe(false);
    });

    it("an entry that holds an import expression is refused by the build in sealed and strict mode, with its reason; one without builds", async () => {
        for (const mode of ['sealed', 'strict'] as const) {
            for (const entry of ["import('https://x.example/a')", "import.source('https://x.example/a')", "import /* */ . defer('https://x.example/a')", "x = 1; // import(later)"]) {
                const el = await started({ mode, entry: 'main.js' }, { 'main.js': entry });
                expect(el.state, `${mode}: ${entry}`).toBe('terminated');
                expect(el._buildRefusal(), `${mode}: ${entry}`).toBe(reasonText('entryImport'));
            }
            const el = await started({ mode, entry: 'main.js' }, { 'main.js': 'const imports = 1; sandboxView.render("<p>x</p>");' });
            expect(el.state).toBe('loading');
            expect(el._buildRefusal(), `${mode}: no import expression`).toBeNull();
        }
        // the termination says why
        const el = await mount();
        const reasons: string[] = [];
        el.addEventListener('terminated', (event: CustomEvent) => reasons.push(event.detail.reason));
        startWith(el, { entry: 'main.js' }, { files: { 'main.js': "import.defer('https://x.example/a')" } });
        await vi.waitFor(() => expect(reasons.at(-1)).toBe(reasonText('entryImport')));
    });
});
