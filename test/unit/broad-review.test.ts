import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFetchBridge, toFetchPolicy, validateRequest, type FetchRecord } from '@src/lib/fetch-bridge';
import { cooperativePolicy, fileKinds, strictViewPolicy } from '@src/lib/csp/csp-generator';
import { parseOrigins } from '@src/lib/csp/origins';
import { prng } from './policy-helpers';
import { rewriteGuestMarkup, VIRTUAL_DOCUMENT_URL } from '@src/lib/markup-references';
import { rewriteInlineModule } from '@src/lib/module-specifiers';
import { admitsAll, linkKinds } from '@src/lib/load-kinds';
import { isViewFileType, RENDER_RULES, sanitizeRender } from '@src/lib/in-sandbox-view';

/**
 * Broad review 2026-10-14 (docs/security/BROAD-REVIEW-2026-10-14.md), host and library side: the guarantees that
 * library logic decides. The browser halves are in test/e2e/broad-review.spec.ts; the bootstrap's in
 * src/lib/in-sandbox-script.test.ts and test/unit/broad-review-bootstrap.test.ts.
 */

async function mount(config?: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    if (config) el.setConfig(config);
    return el;
}

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

// The guest policy the element built, as a browser reads it (guest srcdoc inside the wrapper srcdoc).
const policyOf = (el: HTMLElement): string => {
    const wrapper = el.shadowRoot!.querySelector('iframe')!.srcdoc;
    const guest = new DOMParser().parseFromString(wrapper, 'text/html').querySelector('iframe')!.getAttribute('srcdoc')!;
    return new DOMParser().parseFromString(guest, 'text/html').querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
};

// ---- CB3 ------------------------------------------------------------------------------------------------

describe('CB3: the host queue holds only calls still waiting for their answer', () => {
    it('a call made while loading that times out leaves the queue with its promise: it is never sent at the next flush', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ capabilities: ['allow-scripts'] });
        expect(el.state).toBe('loading');
        const timedOut = el.callWithTimeout(20, 'count').catch((error: any) => error.code);
        const waiting = el.call('later').catch(() => {}); // positive control: still pending, so still queued
        expect(el._queue).toHaveLength(2);
        expect(await timedOut).toBe('TIMEOUT');
        await settle();
        expect(el._queue.map((item: any) => item.frame.method)).toEqual(['later']);
        el.reset(); // teardown rejects the waiting one
        await waiting;
    });
});

// ---- CB4 ------------------------------------------------------------------------------------------------

// Sends sandbox:write requests on a port of the current environment, as the guest's broker would (jsdom never loads the frame).
function connect(el: any) {
    const { port1 } = new MessageChannel();
    el._port = port1;
    const answers: any[] = [];
    let id = 0;
    const send = (request: unknown) => el._onGuestMessage(port1, (frame: unknown) => answers.push(frame), { type: 'RPC_REQ', id: ++id, method: 'sandbox:write', args: [request] }, null);
    return { answers, send, close: () => port1.close() };
}

describe('CB4: a guest write is answered from the build the guest has, never from files registered later', () => {
    it('removing a path the host registered after the build: answered "none", as for any path the guest does not have', async () => {
        const el = await mount({ capabilities: ['allow-scripts'], guestWrites: true });
        el.registerFiles({ 'late.txt': 'registered after the build' });
        const { answers, send, close } = connect(el);
        send({ change: 'remove', path: 'late.txt' });
        send({ change: 'remove', path: 'never.txt' }); // the same answer: nothing tells the two apart
        await settle();
        expect(answers.map(a => a.value)).toEqual([{ path: 'late.txt', change: 'none' }, { path: 'never.txt', change: 'none' }]);
        expect(el.listGuestWrites()).toEqual([]);
        close();
    });

    it('a file the build delivered can be removed (positive control)', async () => {
        const el = await mount({ capabilities: ['allow-scripts'], guestWrites: true });
        el.registerFiles({ 'built.txt': 'x' });
        el.reset();
        const { answers, send, close } = connect(el);
        send({ change: 'remove', path: 'built.txt' });
        await settle();
        expect(answers[0].value).toEqual({ path: 'built.txt', change: 'remove' });
        close();
    });

    it('the write-time quota counts the build, not files registered later: a write the build has room for is recorded', async () => {
        const { MAX_FILES } = await import('@src/lib/files');
        const el = await mount({ capabilities: ['allow-scripts'], guestWrites: true });
        const late: Record<string, string> = {};
        for (let i = 0; i < MAX_FILES; i++) late[`late/${i}.txt`] = 'x';
        el.registerFiles(late); // the store is full now; the guest's build holds none of these
        const { answers, send, close } = connect(el);
        send({ change: 'write', path: 'mine.txt', entry: 'x' });
        await settle();
        expect(answers[0]).toMatchObject({ ok: true, value: { path: 'mine.txt', change: 'write' } });
        // the commit is the store's full check, against the store as it is: refused there, on the host's side
        expect(() => el.commitGuestWrites(['mine.txt'])).toThrow(expect.objectContaining({ code: 'FILES_QUOTA_EXCEEDED' }));
        close();
    });
});

// ---- CB5 ------------------------------------------------------------------------------------------------

describe('CB5: a terminated listener that builds again from the same inputs is answered once', () => {
    // a build's 'terminated' comes in a task of its own (review round 1, R3-2)
    const settled = () => new Promise(resolve => setTimeout(resolve, 0));
    it.each([
        ['an unknown mode (a refusal)', { mode: 'Strict' }, false],
        ['origins that cannot be read (a refusal)', { origins: { images: 'x; script-src *' } }, false],
        // a config other than the mount's: the same one again would be no change, and build nothing (review round 1, R3-7)
        ['a build that throws (a build failure)', { capabilities: ['allow-scripts'], html: '<p>other</p>' }, true],
    ])('%s: one termination, one warning, no recursion; the state stays terminated', async (_, config, breakBuild) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ capabilities: ['allow-scripts'] });
        if (breakBuild) el._guestPolicy = () => { throw new Error('no policy'); };
        let heard = 0;
        el.addEventListener('terminated', () => {
            heard++;
            if (heard < 2000) el.reset();
        });
        expect(() => el.setConfig(config)).not.toThrow();
        await settled();
        expect(heard).toBe(1);
        expect(el.state).toBe('terminated');
        expect(warn.mock.calls.filter(call => String(call[0]).startsWith('[Sandbox] terminated:'))).toHaveLength(1);
        // later, outside the listener, reset() says again why it cannot start (unchanged)
        el.reset();
        await settled();
        expect(heard).toBe(2);
    });

    it('load() of other markup from the listener under an unknown mode: the refusal does not depend on the markup, so one dispatch', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ capabilities: ['allow-scripts'] });
        let heard = 0;
        el.addEventListener('terminated', () => {
            heard++;
            if (heard < 2000) el.load(`<p>${heard}</p>`);
        });
        el.setConfig({ mode: 'Strict' });
        await settled();
        expect([heard, el.state]).toEqual([1, 'terminated']);
    });

    it('a listener that changes the inputs first builds normally (positive control)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ capabilities: ['allow-scripts'] });
        const states: string[] = [];
        el.addEventListener('terminated', () => {
            el.setConfig({ capabilities: ['allow-scripts'] });
            states.push(el.state);
        }, { once: true });
        el.setConfig({ mode: 'Strict' });
        await settled();
        expect(states).toEqual(['loading']);
        expect(el.state).toBe('loading');
    });
});

// ---- CB6 ------------------------------------------------------------------------------------------------

describe('CB6: one refusal text to the guest for every origin that is not listed', () => {
    const HOST = 'http://localhost:4444';
    const policy = toFetchPolicy({ allow: ['https://api.example'] }, () => {})!;

    it('the host page\'s origin, a private host and any other origin read the same; the reason stays in the record', async () => {
        const urls = [`${HOST}/secret`, 'https://127.0.0.1/x', 'https://10.0.0.1/', 'https://other.example/'];
        for (const url of urls) {
            const refusal = validateRequest({ url }, policy, HOST) as Error & { code: string };
            expect(refusal.message, url).toBe(`[sandboxFetch] FETCH_NOT_ALLOWED: ${new URL(url).origin} is not in fetchBridge.allow`);
        }
        const records: FetchRecord[] = [];
        const bridge = createFetchBridge({ policy, hostOrigin: HOST, onRecord: (record) => records.push(record), fetchImpl: (() => Promise.reject(new Error('not called'))) as unknown as typeof fetch });
        for (const url of urls) await bridge.handle({ url }).catch(() => {});
        expect(records.map(record => [record.outcome, record.code, record.reason ?? null])).toEqual([
            ['refused', 'FETCH_NOT_ALLOWED', "the host page's own origin, which is not in fetchBridge.allow"],
            ['refused', 'FETCH_NOT_ALLOWED', 'a loopback, private or link-local host, which is not in fetchBridge.allow'],
            ['refused', 'FETCH_NOT_ALLOWED', 'a loopback, private or link-local host, which is not in fetchBridge.allow'],
            ['refused', 'FETCH_NOT_ALLOWED', null],
        ]);
    });
});

// ---- PD1 ------------------------------------------------------------------------------------------------

describe('PD1: no worker loads from data: in the guest policy', () => {
    it('the default policy admits blob: workers only', async () => {
        const el = await mount({ capabilities: ['allow-scripts'] });
        expect(policyOf(el)).toContain('worker-src blob:;');
        expect(policyOf(el)).not.toContain('data:');
    });

    it('a config cannot reach worker-src at all (no kind names it), and data: is not an origin for any kind: one warning each across builds', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], origins: { 'worker-src': ['data:'], scripts: ['data:'], images: ['data:'] } });
        el.reset();
        expect(policyOf(el)).toContain('worker-src blob:;');
        expect(policyOf(el)).not.toContain('data:');
        const messages = warn.mock.calls.map(call => String(call[0]));
        expect(messages.filter(m => m.includes('origins."worker-src" was dropped'))).toHaveLength(1);
        expect(messages.filter(m => m.includes('entry "data:" was dropped'))).toHaveLength(2);
    });
});

// ---- PA1 ------------------------------------------------------------------------------------------------

// An oracle independent of the library's table: CSP Level 3's fallback lists, written out here.
const FALLBACKS: Record<string, string[]> = {
    'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
    'style-src-elem': ['style-src-elem', 'style-src', 'default-src'],
    'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
    'frame-src': ['frame-src', 'child-src', 'default-src'],
    'connect-src': ['connect-src', 'default-src'],
    'img-src': ['img-src', 'default-src'],
    'font-src': ['font-src', 'default-src'],
    'media-src': ['media-src', 'default-src'],
    'object-src': ['object-src', 'default-src'],
    'manifest-src': ['manifest-src', 'default-src'],
};
// The URL sources a browser checks a load of `kind` against, in the emitted policy ('none' is none).
function urlSources(policy: string, kind: string): Set<string> {
    const directives = new Map<string, string[]>();
    for (const part of policy.split(';')) {
        const [name, ...tokens] = part.trim().split(/\s+/);
        if (name && !directives.has(name)) directives.set(name, tokens.filter(Boolean));
    }
    for (const name of FALLBACKS[kind]!) {
        const tokens = directives.get(name);
        if (tokens) return new Set(tokens.map(t => t.toLowerCase()).filter(t => t !== "'none'"));
    }
    return new Set();
}

describe('PA1: blob: for files widens only the kinds of load they are for', () => {
    it('a JavaScript file: blob: reaches scripts, not workers', () => {
        const origins = parseOrigins({ scripts: ['https://cdn.example'] }, 'cooperative', () => {});
        const before = cooperativePolicy({ origins, fileKinds: new Set(), scriptUnsafe: false });
        const after = cooperativePolicy({ origins, fileKinds: fileKinds(['text/javascript']), scriptUnsafe: false });
        expect(urlSources(after, 'script-src-elem')).toContain('blob:'); // what the files are for
        expect([...urlSources(after, 'worker-src')]).toEqual([...urlSources(before, 'worker-src')]);
    });

    it('property: over random origins × file types, in both templates, every kind the types do not need keeps exactly its sources', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const random = prng(0x5eed);
        const KINDS = ['scripts', 'styles', 'images', 'fonts', 'media', 'connect'];
        const ENTRIES = ['https://a.example', 'https://b.example:8443', 'http://localhost:3000', 'wss://w.example'];
        const TYPES = ['text/javascript', 'text/css', 'image/png', 'font/woff2', 'audio/mpeg', 'text/vtt', 'application/json'];
        // the CSP Level 3 kinds each registered type is for, written out independently of the library's table
        const NEEDED: Record<string, string[]> = {
            'text/javascript': ['script-src-elem', 'connect-src'], 'text/css': ['style-src-elem', 'connect-src'], 'image/png': ['img-src', 'connect-src'],
            'font/woff2': ['font-src', 'connect-src'], 'audio/mpeg': ['media-src', 'connect-src'], 'text/vtt': ['media-src', 'connect-src'], 'application/json': ['connect-src'],
        };
        const hash = `'sha256-${'A'.repeat(43)}='`;
        for (let run = 0; run < 400; run++) {
            const config: Record<string, string[]> = {};
            for (const kind of KINDS) if (random() < 0.5) config[kind] = ENTRIES.filter(() => random() < 0.4);
            const types = TYPES.filter(() => random() < 0.35);
            const needed = new Set(types.flatMap(type => NEEDED[type]!));
            for (const mode of ['cooperative', 'strict']) {
                const origins = parseOrigins(config, mode, () => {});
                const make = (kinds: Set<never> | ReturnType<typeof fileKinds>) => (mode === 'strict'
                    ? strictViewPolicy({ origins, fileKinds: kinds, scriptUnsafe: false, bootstrapHash: hash })
                    : cooperativePolicy({ origins, fileKinds: kinds, scriptUnsafe: false }));
                const [before, after] = [make(new Set()), make(fileKinds(types))];
                for (const kind of Object.keys(FALLBACKS)) {
                    const was = urlSources(before, kind);
                    const now = urlSources(after, kind);
                    const added = [...now].filter(source => !was.has(source));
                    const context = `${kind} in ${mode} ${JSON.stringify(config)} with ${types.join(', ')}`;
                    if (!needed.has(kind) || (mode === 'strict' && kind === 'script-src-elem')) expect(added, context).toEqual([]);
                    else expect(added, context).toEqual(['blob:']);
                }
            }
        }
    });
});

// ---- PA3 ------------------------------------------------------------------------------------------------

describe('PA3: the inline-module rewrite never changes which script elements the markup has, or where they end', () => {
    // Module texts built from fragments that a rewrite could turn into markup: specifiers to rewrite, and text that
    // looks like a tag, a comment opener or an end tag in strings, comments and template literals.
    const FRAGMENTS = [
        'import a from "./a.js";', "import './b.js';", 'import("./a.js");', 'export * from "../a.js";', 'import x from "https://cdn.example/x.js";',
        '"</scr" + "ipt>";', "'<!--';", '/* <script> */', '// -->\n', '`${"<"}/script>`;', 'const s = "<\\/script>";', '"\u2028";',
        'import y from "./<x>.js";', 'import z from "./%3C/script%3E.js";', '\n', ' ',
    ];
    const scripts = (markup: string) => [...new DOMParser().parseFromString(markup, 'text/html').querySelectorAll('script')]
        .map(script => ({ type: script.getAttribute('type'), text: script.textContent ?? '' }));

    it('property: over random markups, the rewritten markup parses to the same scripts, in order, each module holding exactly its rewritten text', () => {
        const random = prng(0xbadc0de);
        const files = new Map([['a.js', 'text/javascript'], ['b.js', 'text/javascript']]);
        for (let run = 0; run < 200; run++) {
            const pieces: string[] = [];
            for (let i = 1 + Math.floor(random() * 3); i > 0; i--) {
                let text = '';
                for (let j = Math.floor(random() * 6); j > 0; j--) text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
                const type = random() < 0.7 ? 'module' : random() < 0.5 ? 'text/javascript' : 'importmap';
                pieces.push(type === 'importmap' ? '<script type="importmap">{"imports":{}}</script>' : `<script type="${type}">${text}</script>`, random() < 0.5 ? '<p>between</p>' : '');
            }
            const markup = pieces.join('');
            const before = scripts(markup).filter(script => script.type !== 'importmap'); // import maps are taken out, by design
            const { parts } = rewriteGuestMarkup(markup, files, { modules: true }, 'f'.repeat(32));
            const written = parts === null ? markup : parts.map((part, i) => (i % 2 === 0 ? part : 'blob:null/x')).join('');
            const after = scripts(written);
            expect(after.map(script => script.type), markup).toEqual(before.map(script => script.type));
            for (let i = 0; i < before.length; i++) {
                const expected = before[i]!.type === 'module' ? rewriteInlineModule(before[i]!.text, VIRTUAL_DOCUMENT_URL, () => {}) ?? before[i]!.text : before[i]!.text;
                expect(after[i]!.text, markup).toBe(expected);
            }
        }
    }, 30000);
});

// ---- I1 -------------------------------------------------------------------------------------------------

describe("I1: the strict renderer's own copy of a <link>'s load kinds agrees with load-kinds.ts", () => {
    // The renderer (src/lib/in-sandbox-view.ts, stringified, so it carries a copy of the logic over the table as data)
    // keeps a <link> only when every rel token is a relation it renders (RENDER_RULES.linkRelations) and its href
    // resolves to a file the view minted. A link it keeps must be one load-kinds.ts resolves for the same file type,
    // and every such link of those relations must be kept, restricted to the types the view mints URLs for at all
    // (VIEW_FILE_TYPES: no document-capable type such as SVG, broad review ST1): checked over every combination of
    // rel tokens, `as` and type.
    const TOKENS = ['stylesheet', 'icon', 'preload', 'modulepreload', 'prefetch', 'alternate', 'STYLESHEET'];
    const AS = [null, 'style', 'image', 'script', 'font', 'fetch', 'bogus'];
    const TYPES = ['text/css', 'image/png', 'image/svg+xml', 'text/javascript', 'font/woff2', 'text/plain'];

    it('every rel (up to two tokens) × as × type', () => {
        const rels: string[] = [];
        for (const a of TOKENS) {
            rels.push(a);
            for (const b of TOKENS) if (a !== b) rels.push(`${a} ${b}`);
        }
        for (const type of TYPES) {
            // one fragment per type, one link per rel and as: the renderer judges each link on its own
            const fragment = new DOMParser().parseFromString('<template></template>', 'text/html').querySelector('template')!.content;
            const cases: [string, string | null][] = [];
            for (const rel of rels) for (const as of AS) {
                const link = fragment.ownerDocument.createElement('link');
                link.id = `l${cases.length}`;
                link.setAttribute('rel', rel);
                if (as !== null) link.setAttribute('as', as);
                link.setAttribute('href', 'file');
                fragment.append(link);
                cases.push([rel, as]);
            }
            sanitizeRender(fragment, (path) => (path === 'file' ? { url: 'blob:null/file', type } : null), (url) => url === 'blob:null/file', RENDER_RULES);
            cases.forEach(([rel, as], i) => {
                const kept = fragment.getElementById(`l${i}`) !== null;
                const rendered = rel.toLowerCase().split(' ').every(token => RENDER_RULES.linkRelations.includes(token));
                const kinds = linkKinds(rel, as);
                expect(kept, `${rel} as=${as} ${type}`).toBe(rendered && kinds !== null && admitsAll(kinds, type) && isViewFileType(type));
            });
        }
    }, 30000);
});
