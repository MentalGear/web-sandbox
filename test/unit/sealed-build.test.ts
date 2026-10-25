import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comments, SyntaxKind, tokenize } from '../../scripts/js-tokens';
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
import { inheritedContext } from '../../tools/docgen/extractors/inherited-context';

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** The network code, and the reads of the host page's origin and site: none may run on the sealed path. */
const NETWORK = { hostPageOrigin, hostSiteOrigins, hostReach, parseOrigins, toFetchPolicy, createFetchBridge, prepareBridgeFrame, createBridgeFrame, connectSources, strictViewPolicy, cooperativePolicy } as unknown as Record<string, ReturnType<typeof vi.fn>>;
const called = () => Object.keys(NETWORK).filter(name => NETWORK[name]!.mock.calls.length > 0).sort();

const HASH = viewBootstrapHash();
const LISTED = 'https://cdn.listed.example';
const API = 'https://api.listed.example';
/** Strict mode with every network option: the positive control. `false`: the page sends no policy, so the lists stay. */
const STRICT_NETWORK = { mode: 'strict', origins: { images: [LISTED], media: [LISTED], connect: [API] }, fetchBridge: { allow: [API] }, hostContentSecurityPolicy: false };
/** Every option sealed mode takes, each set. */
const SEALED_EVERY = {
    mode: 'sealed', html: '<p onclick="x()">x</p><script>y()</script>', capabilities: ['allow-scripts'], scriptUnsafe: true, hostContentSecurityPolicy: "default-src 'self'",
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
    it('setConfig(), reset(), load(), registerFiles() and a switch from strict mode: no read of the host page and no network code, in the config or the build', async () => {
        const el = await mount();
        el.registerFiles({ 'main.js': 'void 0', 'a.css': 'p { color: red }', 'b.png': 'x', 'c.json': '{}' });
        for (const fn of Object.values(NETWORK)) fn.mockClear(); // the element's first build (strict, the default)
        el.setConfig(SEALED_EVERY);
        expect(el.state).toBe('loading');
        el.reset();
        el.load('<p>again</p>');
        el.registerFiles({ 'd.css': 'p { color: blue }' });
        el.setConfig({ mode: 'sealed' });
        el.setConfig({ mode: 'sealed', origins: undefined, fetchBridge: undefined });
        expect(el.state).toBe('loading');
        expect(called()).toEqual([]);

        // a strict build with a bridge, then sealed again: the switch reads nothing, and leaves no bridge
        el.setConfig(STRICT_NETWORK);
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(2);
        for (const fn of Object.values(NETWORK)) fn.mockClear();
        el.setConfig({ mode: 'sealed' });
        expect(called()).toEqual([]);
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(1);
        expect([el._fetchBridge, el._bridgeFrame]).toEqual([null, null]);
    });

    it('positive control: strict mode with origins and fetchBridge runs every one of them, the host page read in the config and the bridge at attach', async () => {
        const el = await mount();
        for (const fn of Object.values(NETWORK)) fn.mockClear();
        el.setConfig(STRICT_NETWORK);
        expect(called()).toEqual(Object.keys(NETWORK).filter(name => name !== 'cooperativePolicy').sort());
        for (const fn of Object.values(NETWORK)) fn.mockClear();
        el.setConfig({ ...STRICT_NETWORK, mode: 'cooperative', capabilities: ['allow-scripts'] });
        expect(called()).toContain('cooperativePolicy');
        expect(called()).toContain('hostPageOrigin');
    });

    it("normaliseConfig: a sealed config never asks for the host page (its function is not called); strict, cooperative and worker configs ask once", () => {
        let asked = 0;
        const page = (): NormaliseContext => { asked++; return { hostOrigin: 'https://app.example', hostSites: ['https://app.example'] }; };
        for (const config of [{ mode: 'sealed' }, SEALED_EVERY]) {
            const { value, refusal } = normaliseConfig(config, page);
            expect([refusal, value!.fetchPolicy, value!.origins.connect, value!.origins.images]).toEqual([null, null, [], []]);
        }
        expect(asked).toBe(0);
        for (const mode of ['strict', 'cooperative', 'worker', undefined]) {
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
        const el = await mount();
        el.registerFiles({ 'main.js': 'void 0', 'a.css': 'p {}', 'b.png': 'x', 'c.json': '{}', 'd.woff2': 'x', 'e.mp4': 'x' });
        el.setConfig({ ...config, entry: 'main.js' });
        expect(el.state).toBe('loading');
        return { el, prepared: el._prepareBuild(), features: featuresOf(el._strictInit.workerSource) };
    };

    it('sealed: the view policy is sealedViewPolicy over its file kinds, the gate list is [], sandboxFetch() refuses in the guest, one frame, INIT_VIEW names no origins, the build has no network', async () => {
        const { el, prepared, features } = await build({ mode: 'sealed' });
        const kinds = new Set<SealedFileKind>(['styles', 'images', 'fonts', 'media']);
        expect(policyOf(el)).toBe(sealedViewPolicy({ fileKinds: kinds, bootstrapHash: HASH, scriptUnsafe: false }));
        expect(networkSources(policyOf(el))).toEqual([]);
        expect(directives(policyOf(el)).get('connect-src')).toEqual(["'none'"]);
        expect(features.connect).toEqual([]);
        expect(features.sealed).toBe(true);
        expect(features).not.toHaveProperty('fetchBridge');
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

// ---- T5: the call graph of the sealed path, from the source

/**
 * A call graph over src/: a node is a module-level function or const of a file, or a member of host.ts's element class;
 * an edge is any reference to one in another's text (a call, or a function handed on), resolved through the file's
 * imports. Conservative: a reference counts as a call. Comments are not code. The lifecycle executor (`step`) is where a
 * path hands the reducer an input and ends: what the reducer starts from it is a build path of its own.
 */
type Graph = { units: Map<string, string>; imports: Map<string, string> };
const files = new Map<string, Graph>();
const BOUNDARY = new Set(['src/host.ts#step']);

function code(file: string): string {
    let text = read(file);
    for (const comment of comments(text)) text = text.slice(0, comment.start) + ' '.repeat(comment.end - comment.start) + text.slice(comment.end);
    return text;
}

function resolve(from: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const base = path.posix.join(path.posix.dirname(from), specifier);
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) if (existsSync(path.join(ROOT, candidate))) return candidate;
    return null;
}

function graphOf(file: string): Graph {
    const known = files.get(file);
    if (known) return known;
    const text = code(file);
    const imports = new Map<string, string>();
    for (const match of text.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/gm)) {
        if (match[1]) continue;
        const target = resolve(file, match[3]!);
        if (!target) continue;
        for (const part of match[2]!.split(',').map(entry => entry.trim()).filter(entry => entry && !entry.startsWith('type '))) {
            const [name, local] = part.split(/\s+as\s+/);
            imports.set((local ?? name)!, `${target}#${name}`);
        }
    }
    const units = new Map<string, string>();
    const starts: { name: string; at: number; close: RegExp }[] = [];
    for (const match of text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)) starts.push({ name: match[1]!, at: match.index!, close: /^\}$/m });
    for (const match of text.matchAll(/^(?:export\s+)?const\s+(\w+)/gm)) starts.push({ name: match[1]!, at: match.index!, close: /^(?=\S)/m });
    if (file === 'src/host.ts') {
        // the element class's members only (the interfaces below it name some of the same members)
        const from = text.indexOf('\nexport class WebSandbox ');
        const to = text.indexOf('\n}\n', from);
        const body = text.slice(from, to);
        for (const match of body.matchAll(/^ {4}(?:(?:private|public|static|async|get|set)\s+)*(\w+)\s*\(/gm)) starts.push({ name: `this.${match[1]}`, at: from + match.index!, close: /^ {4}\}$/m });
    }
    for (const start of starts) {
        // the unit's text: its first line, and every line up to the one that closes it
        const lineEnd = text.indexOf('\n', start.at);
        const rest = text.slice(lineEnd + 1);
        const end = rest.search(start.close);
        units.set(start.name, text.slice(start.at, lineEnd + 1) + (end < 0 ? rest : rest.slice(0, end)));
    }
    const graph = { units, imports };
    files.set(file, graph);
    return graph;
}

/** The nodes a text references: `this.name` (host.ts's members), a module-level unit of its file, an import. */
function references(file: string, text: string): string[] {
    const { units, imports } = graphOf(file);
    const tokens = tokenize(text);
    const found = new Set<string>();
    tokens.forEach((token, i) => {
        if (token.kind !== SyntaxKind.Identifier) return;
        const before = tokens[i - 1];
        if (before?.kind === SyntaxKind.DotToken || before?.kind === SyntaxKind.QuestionDotToken) {
            if (tokens[i - 2]?.kind === SyntaxKind.ThisKeyword && units.has(`this.${token.text}`)) found.add(`${file}#this.${token.text}`);
            return;
        }
        if (units.has(token.text)) found.add(`${file}#${token.text}`);
        else if (imports.has(token.text)) found.add(imports.get(token.text)!);
    });
    return [...found];
}

/** Every node reachable from `text` of `file`, and the path that reached each. */
function reach(file: string, text: string): Map<string, string[]> {
    const paths = new Map<string, string[]>();
    const queue: [string, string[]][] = references(file, text).map(node => [node, [node]]);
    while (queue.length > 0) {
        const [node, trail] = queue.shift()!;
        if (paths.has(node)) continue;
        paths.set(node, trail);
        if (BOUNDARY.has(node)) continue;
        const [owner, name] = node.split('#') as [string, string];
        const body = graphOf(owner).units.get(name);
        if (body === undefined) continue; // a type, a class, or a value of no code
        for (const next of references(owner, body)) if (!paths.has(next)) queue.push([next, [...trail, next]]);
    }
    return paths;
}

/** The network code by node: the reads of the host page, the narrowing, the origins, the bridge, the non-sealed templates. */
const FORBIDDEN = [
    'src/lib/host-site.ts#hostPageOrigin', 'src/lib/host-site.ts#hostSiteOrigins', 'src/host.ts#readHostPage',
    'src/lib/csp/host-connect.ts#hostReach', 'src/lib/csp/origins.ts#parseOrigins', 'src/lib/config-schema.ts#limitHostReach',
    'src/lib/fetch-bridge.ts#toFetchPolicy', 'src/lib/fetch-bridge.ts#createFetchBridge',
    'src/lib/bridge-frame.ts#prepareBridgeFrame', 'src/lib/bridge-frame.ts#createBridgeFrame', 'src/lib/frame-documents.ts#buildBridgeDocument',
    'src/lib/csp/csp-generator.ts#connectSources', 'src/lib/csp/csp-generator.ts#strictViewPolicy', 'src/lib/csp/csp-generator.ts#cooperativePolicy', 'src/lib/csp/csp-generator.ts#bridgeFramePolicy',
    'src/host.ts#this._reach', 'src/host.ts#this._startFetchBridge', 'src/host.ts#this._prepareNetwork', 'src/host.ts#this._gateConnect', 'src/host.ts#this._guestPolicy', 'src/host.ts#this._policyInput',
];
const forbiddenIn = (paths: Map<string, string[]>) => FORBIDDEN.filter(node => paths.has(node)).map(node => paths.get(node)!.join(' → '));

const member = (name: string) => graphOf('src/host.ts').units.get(`this.${name}`)!;

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
            'src/host.ts#this._reach', 'src/lib/csp/host-connect.ts#hostReach', 'src/host.ts#this._prepareNetwork', 'src/lib/bridge-frame.ts#prepareBridgeFrame',
            'src/lib/csp/csp-generator.ts#connectSources', 'src/lib/csp/csp-generator.ts#strictViewPolicy', 'src/lib/csp/csp-generator.ts#cooperativePolicy',
        ]));
        // and strict mode's own frame reaches the narrowing's output, the gate list, the template and the bridge
        expect(forbiddenIn(reach('src/host.ts', member('_prepareStrictFrame'))).length).toBeGreaterThan(0);
        // the attach reaches the bridge, and through it the host page's origin: what the sealed attach must not run
        expect(forbiddenIn(reach('src/host.ts', member('_attachBuild'))).map(trail => trail.split(' → ').at(-1))).toEqual(expect.arrayContaining([
            'src/host.ts#this._startFetchBridge', 'src/lib/bridge-frame.ts#createBridgeFrame', 'src/lib/fetch-bridge.ts#createFetchBridge', 'src/lib/host-site.ts#hostPageOrigin',
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
        const guarded = 'if (prepared.network) this._startFetchBridge(prepared.network);';
        expect(attach.split(guarded)).toHaveLength(2);
        expect(forbiddenIn(reach('src/host.ts', attach.replace(guarded, '')))).toEqual([]);
    });

    it("the host page's origin and site are read in two places of host.ts: readHostPage (the config, when a network rule asks) and the bridge's start", () => {
        const host = graphOf('src/host.ts');
        const readers = [...host.units].filter(([, body]) => /\bhostPageOrigin\(|\bhostSiteOrigins\(/.test(body)).map(([name]) => name).sort();
        expect(readers).toEqual(['readHostPage', 'this._startFetchBridge']);
        const handedOn = [...host.units].filter(([name, body]) => name !== 'readHostPage' && /\breadHostPage\b/.test(body)).map(([name]) => name);
        expect(handedOn).toEqual(['this._applyConfig']);
    });

    it("config-schema.ts: the host page is asked (host()) only by the rules of the network options, which sealed mode never runs (readIn)", () => {
        const text = code('src/lib/config-schema.ts');
        const asks = [...text.matchAll(/\bhost\(\)/g)].map(match => match.index!);
        const ruleOf = (name: string) => {
            const start = text.indexOf(`\n    ${name}: {`);
            return [start, text.indexOf('\n    },', start)] as const;
        };
        const rules = NETWORK_OPTIONS.map(ruleOf);
        for (const [start, end] of rules) {
            expect(start, 'a network rule').toBeGreaterThan(0);
            expect(end).toBeGreaterThan(start);
        }
        // the one definition (normaliseConfig's `host`), and the asks inside the two rules
        const outside = asks.filter(index => !rules.some(([start, end]) => index > start && index < end));
        expect(outside.map(index => text.slice(index - 40, index + 10).trim())).toEqual([]);
        expect(asks.length).toBeGreaterThanOrEqual(NETWORK_OPTIONS.length);
        expect(readIn('sealed').some(name => (NETWORK_OPTIONS as readonly string[]).includes(name))).toBe(false);
    });
});

// ---- T6: the egress table's sealed column

describe("T6: the egress table's sealed column: every surface of sealed mode is strict mode's but the bridge's, and no channel reaches the network", () => {
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
        const el = await mount();
        el.setConfig({ mode: 'sealed' });
        expect(featuresOf(el._strictInit.workerSource).listeners).toEqual(bootstrapListeners('sealed'));
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(1);
        el.setConfig(STRICT_NETWORK);
        expect(featuresOf(el._strictInit.workerSource).listeners).toEqual(bootstrapListeners('strict'));
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(2);
    });

    it("every channel says what it reaches of the network in sealed mode, none, and the build bears out the two that could: the view's loads and sandboxFetch()", async () => {
        for (const row of CHANNEL_BUDGETS) expect(row.sealed, row.channel).toMatch(/^(none\b|not a channel of sealed mode$)/);
        const channel = (start: string) => CHANNEL_BUDGETS.find(row => row.channel.startsWith(start))!;
        expect(channel('`sandboxFetch()`').sealed).toContain('rejects in the guest');
        expect(channel("Strict: the view's loads").sealed).toContain('`blob:`');
        // the view's loads: no network source in the sealed view's policy; strict mode's lists its origins (positive control)
        const el = await mount();
        el.registerFiles({ 'b.png': 'x' });
        el.setConfig({ mode: 'sealed', guestWrites: true });
        expect(networkSources(policyOf(el))).toEqual([]);
        expect(directives(policyOf(el)).get('img-src')).toEqual(['blob:']);
        el.setConfig(STRICT_NETWORK);
        expect(networkSources(policyOf(el))).toContain(LISTED);
        // sandboxFetch(): the sealed worker's bootstrap is told so (the guest's refusal: the describe above)
        el.setConfig({ mode: 'sealed' });
        expect(featuresOf(el._strictInit.workerSource).sealed).toBe(true);
    });

    it('docs/API.md renders the column', () => {
        const table = budgetsTable(limitValues());
        expect(table.split('\n')[0]).toContain('| Network in sealed mode |');
        for (const row of CHANNEL_BUDGETS) expect(table).toContain(row.sealed.replace(/\|/g, '\\|'));
    });
});

// ---- T9: INHERITED_CONTEXT's sealed field

describe("T9: every row of the host page's context says what it is in sealed mode, and the build bears out the rows sealed mode drops", () => {
    it('every row has its standing; a row that does not apply says why; 12 remain, 1 is reduced, 5 do not apply (research 24, §1.4)', () => {
        const rows = inheritedContextRows();
        for (const row of rows) {
            expect(['remains', 'reduced', 'not-applicable'], row.id).toContain(row.sealed?.standing);
            if (row.sealed.standing === 'not-applicable') expect(['no-network', 'no-guest-document'], row.id).toContain(row.sealed.because);
            if (row.sealed.standing !== 'remains') expect(row.sealed.note!.length, row.id).toBeGreaterThan(5);
        }
        const by = (standing: string) => rows.filter(row => row.sealed.standing === standing).map(row => row.id).sort();
        expect(by('not-applicable')).toEqual(['ancestorOrigins', 'cookies', 'referrer', 'serviceWorker', 'uiSurfaces']);
        expect(by('reduced')).toEqual(['cspFetch']);
        expect(by('remains')).toHaveLength(12);
        expect(rows).toHaveLength(Object.keys(INHERITED_CONTEXT).length);
    });

    it("the rows dropped for 'no-network' and the reduced cspFetch: a sealed build makes no request path (no network source, an empty gate, no bridge frame, no origins); strict mode with a network has each (positive control)", async () => {
        const noNetwork = inheritedContextRows().filter(row => row.sealed.standing === 'not-applicable' && row.sealed.because === 'no-network').map(row => row.id);
        expect(noNetwork.sort()).toEqual(['cookies', 'referrer', 'serviceWorker']);
        const paths = async (config: Record<string, unknown>) => {
            const el = await mount();
            el.registerFiles({ 'a.css': 'p {}', 'b.png': 'x' });
            el.setConfig(config);
            const policy = directives(policyOf(el));
            return {
                sources: networkSources(policyOf(el)),
                fetchSources: ['img-src', 'font-src', 'media-src', 'style-src', 'connect-src'].flatMap(name => policy.get(name)!).filter(source => !["'none'", "'unsafe-inline'", 'blob:'].includes(source)),
                gate: featuresOf(el._strictInit.workerSource).connect as string[],
                bridge: el.shadowRoot.querySelectorAll('iframe').length > 1,
                origins: Object.keys(el._strictInit).includes('origins'),
            };
        };
        expect(await paths({ mode: 'sealed' })).toEqual({ sources: [], fetchSources: [], gate: [], bridge: false, origins: false });
        const strict = await paths(STRICT_NETWORK);
        expect(strict.sources.length).toBeGreaterThan(0);
        expect(strict.fetchSources.length).toBeGreaterThan(0);
        expect(strict.gate.length).toBeGreaterThan(0);
        expect([strict.bridge, strict.origins]).toEqual([true, true]);
    });

    it("the rows dropped for 'no-guest-document': a sealed build is the strict view, which has none; a cooperative build has one (positive control)", async () => {
        const rows = inheritedContextRows().filter(row => row.sealed.standing === 'not-applicable' && row.sealed.because === 'no-guest-document').map(row => row.id);
        expect(rows.sort()).toEqual(['ancestorOrigins', 'uiSurfaces']);
        const el = await mount();
        el.setConfig({ mode: 'sealed' });
        expect(el._prepareBuild().strictInit).not.toBeNull();
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        expect(el._prepareBuild().strictInit).toBeNull();
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
    it('sealed says sealed mode, once per element; strict says strict mode (the default)', async () => {
        const warn = vi.mocked(console.warn);
        const el = await mount();
        el.setConfig({ mode: 'sealed', html: '<script>x()</script>' });
        el.setConfig({ mode: 'sealed', html: '<p onclick="y()">y</p>' });
        const said = () => warn.mock.calls.map(call => String(call[0])).filter(message => message.includes('runs no script in `html`'));
        expect(said()).toEqual(["[Sandbox] sealed mode runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`."]);
        el.setConfig({ mode: 'strict', html: '<script>x()</script>' });
        expect(said()[1]).toBe("[Sandbox] strict mode (the default) runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`.");
    });

    it("a registered stylesheet's network URL: sealed mode's warning names no origin to list, strict mode's does", async () => {
        const warn = vi.mocked(console.warn);
        const el = await mount();
        el.registerFiles({ 'a.css': `p { background: url(${LISTED}/x.png) }` });
        el.setConfig({ mode: 'sealed' });
        el.setConfig({ mode: 'strict' });
        const said = warn.mock.calls.map(call => String(call[0])).filter(message => message.includes('registered stylesheet "a.css"'));
        expect(said).toHaveLength(2);
        expect(said[0]).toMatch(/^\[Sandbox\] sealed mode: .*sealed mode has no network\. Register the file instead\.$/);
        expect(said[0]).not.toContain('origins');
        expect(said[1]).toMatch(/^\[Sandbox\] strict mode: .*from an origin listed in origins\.$/);
    });
});
