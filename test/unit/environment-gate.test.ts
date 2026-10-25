import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSandboxEnvironment, ENVIRONMENT_CHECKS, ENVIRONMENT_EXPECTED, ENVIRONMENT_REFUSED_TYPE, type EnvironmentCheckId } from '@src/lib/environment-check';
import { TERMINATION_REASONS } from '@src/lib/reasons';
import { BRIDGE_POLICY_START } from '@src/lib/frame-documents';
import { prepareBridgeFrame } from '@src/lib/bridge-frame';
import { BRIDGE_ROLE, environmentGate, viewBootstrapSource, viewBootstrapText, VIEW_OPTIONS } from '@src/lib/in-sandbox-view';
import { SyntaxKind, tokenize } from '../../scripts/js-tokens';
import { runBootstrap, type SandboxEnvironmentRecord } from './sandbox-environment';

/**
 * The environment check is the first statement of every bootstrap that runs in a sandbox document (S74, class B;
 * src/lib/environment-check.ts), and a document that is not the one the library built leaves the bootstrap inert: for
 * each of the four bootstraps and each row of the table, a mismatch registers nothing, runs nothing of the guest's and
 * posts the one refusal. The browsers' side (a host page's `base-uri`, a copy of the bootstrap elsewhere) is
 * test/e2e/environment-check.spec.ts.
 */

const IDS = Object.keys(ENVIRONMENT_CHECKS) as EnvironmentCheckId[];
const ANOTHER: Record<EnvironmentCheckId, string> = { origin: 'https://host.example', url: 'https://host.example/page?q=1#f', base: 'https://host.example/page?q=1#f', isolated: 'true' };

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

/** The bootstrap script of the guest document the element writes for `config` (cooperative mode's, or worker mode's frame's). */
async function guestBootstrapOf(config: Record<string, unknown>): Promise<string> {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    el.setConfig(config);
    const wrapper = new DOMParser().parseFromString(el.shadowRoot.querySelector('iframe').srcdoc, 'text/html');
    const guest = new DOMParser().parseFromString(wrapper.querySelector('iframe')!.getAttribute('srcdoc')!, 'text/html');
    return guest.head.querySelector('script')!.textContent!;
}

const COOPERATIVE = { mode: 'cooperative', capabilities: ['allow-scripts'], html: '<p>x</p>' };
const WORKER = { mode: 'worker' };

// ---- the first statement

/**
 * The gate of a bootstrap's text and what is wrong with where it stands. It is the first statement (the text starts with
 * it, inside the hashed bootstrap's own function for that one) and the only one: its block closes at the end of the
 * bootstrap, so everything else is inside it. `host` and `stop` are the arguments after the table's values.
 */
function gateOf(text: string, shape: 'script' | 'function'): { problems: string[]; host: string | null; stop: string | null } {
    const open = shape === 'function' ? '(function () {' : '';
    const check = `if ((${checkSandboxEnvironment.toString()})(${JSON.stringify(ENVIRONMENT_EXPECTED)}, `;
    const none = (problem: string) => ({ problems: [problem], host: null, stop: null });
    if (!text.startsWith(open + check)) return none('the check is not the first statement, or is not given the rows in their order');
    const tokens = tokenize(text);
    const first = tokens.findIndex(token => token.start === open.length);
    const closing = (from: number, opens: SyntaxKind, closes: SyntaxKind) => {
        let depth = 0;
        for (let i = from; i < tokens.length; i++) {
            if (tokens[i]!.kind === opens) depth++;
            else if (tokens[i]!.kind === closes && --depth === 0) return i;
        }
        return -1;
    };
    const condition = closing(first + 1, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    if (tokens[condition + 1]?.kind !== SyntaxKind.OpenBraceToken) return none('the check is not the condition of a block');
    const last = closing(condition + 1, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken);
    const tail = tokens.slice(last + 1).map(token => token.text).join('');
    const problems: string[] = [];
    if (tail !== (shape === 'function' ? '})();' : '')) problems.push(`something follows the gate's block: ${tail}`);
    const call = text.slice(tokens[first]!.start, tokens[condition]!.end);
    const match = /^if \([^]*\}, ([^]*), (true|false)\) === null\)$/.exec(call);
    if (!match) problems.push('the condition is not the check compared with null');
    return { problems, host: match?.[1] ?? null, stop: match?.[2] ?? null };
}

const gateProblems = (text: string, shape: 'script' | 'function') => gateOf(text, shape).problems;

describe('the check is the first statement of each bootstrap, and everything else is inside its block', () => {
    it('the gate is the text environmentGate() builds, around a body', () => {
        expect(environmentGate('parent.parent', true, 'void 0;')).toBe(`if ((${checkSandboxEnvironment.toString()})(${JSON.stringify(ENVIRONMENT_EXPECTED)}, parent.parent, true) === null) {void 0;}`);
    });

    it('the hashed bootstrap (the view and the bridge frame): the gate is the one statement of its function', () => {
        for (const text of [viewBootstrapText(), viewBootstrapSource(VIEW_OPTIONS)]) {
            expect(gateOf(text, 'function')).toEqual({ problems: [], host: `(document.currentScript && document.currentScript.getAttribute('data-role') === '${BRIDGE_ROLE}' ? parent : parent.parent)`, stop: 'false' });
        }
    });

    it("the cooperative guest's bootstrap, as the element writes it: the gate is its one statement, and the parser is stopped on a refusal", async () => {
        const text = await guestBootstrapOf(COOPERATIVE);
        expect(gateOf(text, 'script')).toEqual({ problems: [], host: 'parent.parent', stop: 'true' });
    });

    it("worker mode's frame bootstrap, as the element writes it: the gate is its one statement", async () => {
        const text = await guestBootstrapOf(WORKER);
        expect(gateOf(text, 'script')).toEqual({ problems: [], host: 'parent.parent', stop: 'false' });
    });

    it("the gate's refusal goes to the host page's window: the bridge frame's parent, every other frame's grandparent", () => {
        const text = viewBootstrapText();
        expect(text).toContain(`document.currentScript.getAttribute('data-role') === '${BRIDGE_ROLE}' ? parent : parent.parent`);
    });

    it('and the scan sees a statement before the gate, a second one after it, a gate that skips the check and one given other values', async () => {
        const gated = await guestBootstrapOf(COOPERATIVE);
        expect(gateProblems(`var s = document.currentScript; ${gated}`, 'script')).not.toEqual([]);
        expect(gateProblems(`${gated} void 0;`, 'script')).not.toEqual([]);
        expect(gateProblems(gated.replace(/\) === null\) \{/, ') !== null) {'), 'script')).not.toEqual([]);
        expect(gateProblems(gated.replace(/"base":\s*"about:blank"/, '"base":"about:srcdoc"'), 'script')).not.toEqual([]);
        expect(gateProblems(`if (true) {${gated}}`, 'script')).not.toEqual([]);
        const hashed = viewBootstrapText();
        expect(gateProblems(hashed.replace('(function () {', '(function () {var early = 1;'), 'function')).not.toEqual([]);
        expect(gateProblems(hashed.replace(/\}\)\(\);$/, ' var late = 1;})();'), 'function')).not.toEqual([]);
    });
});

// ---- a mismatch leaves each bootstrap inert

interface Probe {
    /** Runs the bootstrap in a document whose rows read as given; returns what was posted and stopped, and what the probe saw. */
    run(overrides: Partial<Record<EnvironmentCheckId, string>>): { record: SandboxEnvironmentRecord; effects: string[] };
}

const globalsOf = () => new Set(Reflect.ownKeys(globalThis).map(String));

/** Wraps a platform function for the run: every call is an `effect`, and the call goes through. */
function watch(target: any, name: string, effects: string[], label = name) {
    const original = target[name];
    const spy = vi.spyOn(target, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        effects.push(label);
        return original.apply(this, args);
    });
    return spy;
}

/** The effects of a bootstrap are the listeners it registers and the globals it defines, on top of what its kind does (below). */
function probeOf(text: string, kind: 'view' | 'bridge' | 'cooperative' | 'worker-frame'): Probe {
    return {
        run(overrides) {
            const effects: string[] = [];
            const before = globalsOf();
            const g = globalThis as any;
            delete g.__sandboxViewRuns;
            delete g.__sandboxBridgeRuns;
            const listeners: [string, EventListenerOrEventListenerObject][] = [];
            const addListener = window.addEventListener;
            vi.spyOn(window, 'addEventListener').mockImplementation(function (this: unknown, type: string, listener: any, options?: any) {
                effects.push(`listener ${type}`);
                listeners.push([type, listener]);
                return addListener.call(this, type, listener, options);
            } as typeof window.addEventListener);
            const stubs: (() => void)[] = [];
            if (kind === 'cooperative') {
                const RealChannel = g.MessageChannel;
                g.MessageChannel = class extends RealChannel { constructor() { super(); effects.push('MessageChannel'); } };
                stubs.push(() => { g.MessageChannel = RealChannel; });
            }
            if (kind === 'worker-frame') {
                const hadCreate = Object.hasOwn(URL, 'createObjectURL');
                const hadWorker = Object.hasOwn(g, 'Worker');
                const RealWorker = g.Worker;
                g.Worker = class { onmessage: unknown = null; onerror: unknown = null; constructor() { effects.push('Worker'); } postMessage() {} };
                (URL as any).createObjectURL = () => { effects.push('createObjectURL'); return 'blob:null/probe'; };
                stubs.push(() => {
                    if (hadWorker) g.Worker = RealWorker;
                    else delete g.Worker;
                    if (!hadCreate) delete (URL as any).createObjectURL;
                });
            }
            const currentScript = kind === 'bridge' ? Object.assign(document.createElement('script'), {}) : undefined;
            currentScript?.setAttribute('data-role', BRIDGE_ROLE);
            try {
                const record = runBootstrap(text, { overrides, captureRefusals: true, ...(currentScript ? { currentScript } : {}) });
                for (const stub of stubs.splice(0)) stub();
                for (const key of globalsOf()) if (!before.has(key)) effects.push(`global ${key}`);
                if (g.__sandboxViewRuns !== undefined) effects.push('__sandboxViewRuns');
                if (g.__sandboxBridgeRuns !== undefined) effects.push('__sandboxBridgeRuns');
                return { record, effects };
            } finally {
                for (const stub of stubs) stub();
                for (const [type, listener] of listeners) window.removeEventListener(type, listener, true);
                for (const key of globalsOf()) if (!before.has(key)) delete g[key];
                vi.restoreAllMocks();
            }
        },
    };
}

const BOOTSTRAPS: readonly [kind: 'view' | 'bridge' | 'cooperative' | 'worker-frame', text: () => Promise<string>][] = [
    ['view', async () => viewBootstrapText()],
    ['bridge', async () => viewBootstrapText()],
    ['cooperative', () => guestBootstrapOf(COOPERATIVE)],
    ['worker-frame', () => guestBootstrapOf(WORKER)],
];

describe('a document that is not the one built leaves each bootstrap inert (S74)', () => {
    describe.each(BOOTSTRAPS)('%s', (kind, textOf) => {
        const via = kind === 'bridge' ? 'parent' : 'parent.parent';

        it('in the document the library built it registers, defines and constructs what it does (the control: the probe sees a bootstrap that runs)', async () => {
            const { record, effects } = probeOf(await textOf(), kind).run({});
            expect(effects.length, effects.join(', ')).toBeGreaterThan(0);
            expect(record.posted.some(post => (post.data as any)?.type === ENVIRONMENT_REFUSED_TYPE)).toBe(false);
            expect(record.stops).toBe(0);
        });

        it.each(IDS)('%s: a mismatch of that row alone leaves it inert: no listener, no global, nothing constructed, one portless refusal naming the row', async (id) => {
            const { record, effects } = probeOf(await textOf(), kind).run({ [id]: ANOTHER[id] });
            expect(effects).toEqual([]);
            expect(record.posted).toEqual([{ data: { type: ENVIRONMENT_REFUSED_TYPE, refused: id }, targetOrigin: '*', transferred: 0, via }]);
            // the cooperative guest's document, where it reads like a frame of the library's (an opaque origin, about:srcdoc), is stopped: the guest markup after the bootstrap never runs
            expect(record.stops).toBe(kind === 'cooperative' && (id === 'base' || id === 'isolated') ? 1 : 0);
        });

        it('all rows wrong: the first row of the table is the one named', async () => {
            const { record, effects } = probeOf(await textOf(), kind).run(ANOTHER);
            expect(effects).toEqual([]);
            expect(record.posted.map(post => (post.data as any).refused)).toEqual([IDS[0]]);
        });
    });
});

// ---- the bridge frame's document keeps the table

describe("the bridge frame's document holds the table's values as the wrapper's documents do", () => {
    it("has the wrapper's base, which its own policy admits (about: alone), before its script", () => {
        const parsed = new DOMParser().parseFromString(prepareBridgeFrame(['https://api.example' as any]).srcdoc, 'text/html');
        const csp = parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
        expect(csp.startsWith(BRIDGE_POLICY_START)).toBe(true);
        expect(csp.split('; ')).toContain('base-uri about:');
        expect(csp).not.toContain("base-uri 'none'");
        const head = [...parsed.head.children].map(child => child.tagName + (child.getAttribute('href') ?? ''));
        expect(head).toEqual(['META', 'META', 'BASEabout:blank', 'SCRIPT']);
        expect(parsed.querySelector('base')!.getAttribute('href')).toBe(ENVIRONMENT_EXPECTED.base);
    });
});

// ---- the element's side

describe('the element ends the sandbox on a refusal, by its own table', () => {
    const host = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/host.ts'), 'utf8');

    // (The rule that the element takes a refusal only from the guest frame's window or the bridge frame's, as a trusted
    // message, by a row of its own table, is run with real messages in test/e2e/environment-check.spec.ts, BD3:TST-7; a pin of
    // the source's text held a mutant that kept the pinned line and made the check vacuous.)
    it("takes the reason from the table by the check's id: one reason for each row of the table, whatever the guest names", () => {
        expect(host).toContain('Object.entries(ENVIRONMENT_CHECKS).map(([id, row]) => [id, reasonText(row.reason)])');
    });

    it('listens in every mode: a strict build installs the listener too, and announces nothing', () => {
        expect(host).toContain('this._listenForAnnouncement(iframe, prepared.network ? prepared.network.bridgeFrame : null, prepared.strictInit === null);');
        expect(host).toContain('if (!announces || !guestWindow || event.source !== guestWindow) return;');
    });
});

// ---- the element's own check of the host page

describe('the element refuses to build on a cross-origin isolated host page, before any frame exists', () => {
    afterEach(() => { delete (window as any).crossOriginIsolated; });

    const build = async (config: Record<string, unknown>) => {
        const { defineWebSandbox } = await import('@src/host');
        defineWebSandbox();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        const events: { type: string; reason: string | null }[] = [];
        for (const type of ['ready', 'terminated']) el.addEventListener(type, (event: any) => events.push({ type, reason: event.detail?.reason ?? event.reason ?? null }));
        document.body.appendChild(el);
        el.setConfig(config);
        await new Promise(resolve => setTimeout(resolve, 0)); // the element's events are dispatched on a later task
        return { el, events };
    };

    it.each([['strict', {}], ['cooperative', COOPERATIVE], ['worker', WORKER]])('%s: a host page that reads crossOriginIsolated === true ends with the isolation reason, and builds no frame', async (_mode, config) => {
        Object.defineProperty(window, 'crossOriginIsolated', { value: true, configurable: true });
        const { el, events } = await build(config);
        expect(el.state).toBe('terminated');
        expect(events.map(event => event.type)).toEqual(['terminated']);
        expect(events[0]!.reason).toBe(TERMINATION_REASONS[ENVIRONMENT_CHECKS.isolated.reason].text);
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(0);
    });

    it.each([undefined, false, 'true', 1])('a host page that reads %s is not isolated: the element builds its frame', async (value) => {
        if (value !== undefined) Object.defineProperty(window, 'crossOriginIsolated', { value, configurable: true });
        const { el } = await build(COOPERATIVE);
        expect(el.state).not.toBe('terminated');
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(1);
    });
});
