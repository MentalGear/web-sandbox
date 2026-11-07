import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_PASSES, type HostPassId } from '@src/lib/host-passes';
import { dynamicImportAt } from '@src/lib/entry-imports';
import { FileStore, viewStylesheets, type ByteEdits, type FileSnapshotEntry } from '@src/lib/files';
import { normaliseConfig } from '@src/lib/config-schema';
import { createGuestWrites } from '@src/lib/guest-writes';
import { createBroker } from '@src/lib/rpc';
import { toLogDetail } from '@src/lib/sandbox-log';
import { toViolationDetail } from '@src/lib/violation';
import { validateRequest, type FetchPolicy } from '@src/lib/fetch-bridge';
import { hostLine } from '@src/lib/reasons';
import { elementEvent } from '@src/lib/element-events';
import { scriptInMarkup } from '@src/lib/markup-scripts';
import { VIEW_RENDER_MAX_LENGTH } from '@src/lib/in-sandbox-view';
import type { Origin } from '@src/lib/origin';
import { scalingRatio, type ScalingSize } from './scaling';

/**
 * Every pass of the host realm over guest content (HOST_PASSES, src/lib/host-passes.ts) costs time linear in what it
 * takes (class E-cpu; BD7:LIM-2: the entry scan was quadratic on crafted entries, 128 KiB took 13 s inside setConfig()).
 * Each row has its adversarial shapes here, each timed at a small size and at 8 times it with scalingRatio (bound 24:
 * linear takes about 8, quadratic about 64); a row without shapes fails, so a new pass cannot ship untimed.
 */

const BOUND = 24;
const HOST = 'https://host.example';

/** A shape of input for a pass: `make(n)` builds an input of size n (untimed) and returns the work to time. */
interface Shape {
    readonly name: string;
    readonly n: number;
    readonly make: (n: number) => () => unknown;
}

const timed = (make: (n: number) => () => unknown, n: number): ScalingSize => () => ({ run: make(n) });

/** `length` characters as one flat string: a repeated string is a rope the engine flattens at its first read, which would be timed. */
const chars = (length: number, char = 'x'): string => JSON.parse(JSON.stringify(char.repeat(length)));

let element: any = null;
async function host() {
    if (element) return element;
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    element = document.createElement('web-sandbox');
    return element;
}

/** `n` registered files of the given shape, as a build's snapshot. */
function snapshotOf(files: Record<string, string>): FileSnapshotEntry[] {
    const store = new FileStore(() => {});
    store.register(files);
    return store.snapshot();
}
const manyFiles = (n: number, content = 'x') => {
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) files[`dir/sub/${'p'.repeat(150)}${i}.${['js', 'css', 'png', 'json', 'woff2'][i % 5]}`] = content;
    return files;
};

const SHAPES: Record<HostPassId, readonly Shape[]> = {
    entryScan: [
        // the four shapes that were quadratic (BD7:LIM-2), and the lines of a comment that names it
        { name: 'a run of `import//`', n: 16384, make: n => { const text = 'import//'.repeat(n / 8); return () => dynamicImportAt(text); } },
        { name: 'an unclosed `import/*` run', n: 16384, make: n => { const text = 'import/*'.repeat(n / 8); return () => dynamicImportAt(text); } },
        { name: 'a run of `import<!--`', n: 16384, make: n => { const text = 'import<!--'.repeat(n / 10); return () => dynamicImportAt(text); } },
        { name: 'lines of `import//import`', n: 16384, make: n => { const text = 'import//import\n'.repeat(n / 15); return () => dynamicImportAt(text); } },
        { name: 'lines of `//import`', n: 16384, make: n => { const text = '//import\n'.repeat(n / 9); return () => dynamicImportAt(text); } },
    ],
    configCopy: [{
        name: 'setConfig() again with the same `html` (the copy and the comparison)', n: VIEW_RENDER_MAX_LENGTH / 8,
        make: n => {
            const html = `<p>${chars(n - 7)}</p>`;
            const el = element;
            el.setConfig({ html });
            return () => el.setConfig({ html });
        },
    }],
    configSchema: [{ name: 'normaliseConfig() of a long `html`', n: VIEW_RENDER_MAX_LENGTH / 8, make: n => { const config = { html: chars(n) }; return () => normaliseConfig(config, { hostOrigin: HOST, hostSites: [HOST] }); } }],
    fileStore: [
        { name: 'registerFiles() of many files with long paths', n: 120, make: n => { const files = manyFiles(n); return () => new FileStore(() => {}).register(files); } },
        { name: 'a large binary file', n: 512 * 1024, make: n => { const bytes = new Uint8Array(n).fill(7); return () => new FileStore(() => {}).register({ 'a.bin': bytes }); } },
        {
            name: 'snapshot() of a chain of stylesheets that import each other', n: 120,
            make: n => {
                const files: Record<string, string> = {};
                for (let i = 0; i < n; i++) files[`s${i}.css`] = `@import url(s${i + 1}.css); @import url(s${i}.css); p { color: red }`;
                const store = new FileStore(() => {});
                store.register(files);
                return () => store.snapshot();
            },
        },
    ],
    moduleRewrite: [{ name: 'a module with many relative imports', n: 1000, make: n => { const text = Array.from({ length: n }, (_, i) => `import x${i} from './m${i}.js';`).join('\n'); return () => new FileStore(() => {}).register({ 'a.js': text }); } }],
    stylesheetReferences: [{ name: 'a stylesheet with many references', n: 2000, make: n => { const text = Array.from({ length: n }, (_, i) => `p${i} { background: url(i${i}.png) }`).join('\n'); return () => new FileStore(() => {}).register({ 'a.css': text }); } }],
    viewStylesheets: [
        {
            // each network URL is followed by a registered file's slot, as the snapshot gives it: the slots and the references
            // are read in one walk, not every slot for every reference
            name: "a stylesheet whose network URLs interleave with its registered files' slots", n: 8000,
            make: n => {
                const pair = 'url(https://a.example/x)url(p.png)';
                const css = pair.repeat(n);
                const slots: ByteEdits = [];
                for (let i = 0; i < n; i++) slots.push(i * pair.length + 24, (i + 1) * pair.length, ['p.png']);
                const entries: FileSnapshotEntry[] = [['p.png', 'image/png', btoa('x')], ['a.css', 'text/css', btoa(css), slots]];
                return () => viewStylesheets(entries);
            },
        },
        { name: 'a stylesheet of network URLs only', n: 2000, make: n => { const entries = snapshotOf({ 'a.css': Array.from({ length: n }, (_, i) => `b${i} { background: url(https://n.example/${i}.png) }`).join('\n') }); return () => viewStylesheets(entries); } },
    ],
    viewBuild: [
        { name: "the worker's source of a long entry that holds </script>", n: 64 * 1024, make: n => { const el = element; const entry = '"</script><!--"; '.repeat(n / 16); return () => el._getStrictWorkerSource([], entry); } },
        { name: "the worker's source of many files", n: 120, make: n => { const el = element; const files = snapshotOf(manyFiles(n, '</script>'.repeat(20))); return () => el._getStrictWorkerSource(files, ''); } },
    ],
    policyFromKinds: [{ name: 'the sealed policy of many files', n: 120, make: n => { const el = element; const files = snapshotOf(manyFiles(n)); return () => el._sealedPolicy(files); } }],
    workerBuild: [{ name: "worker mode's bootstrap of many files", n: 120, make: n => { const el = element; const files = snapshotOf(manyFiles(n, '</script>'.repeat(20))); return () => el._getWorkerBootstrapScript(files, []); } }],
    cooperativeDocument: [{ name: "cooperative mode's inert parse of a long document", n: 2000, make: n => { const html = '<p class="a">x</p>'.repeat(n); return () => scriptInMarkup(html); } }],
    guestWrites: [{
        name: 'a large guest write', n: 256 * 1024,
        make: n => {
            let now = 0;
            const writes = createGuestWrites({ store: new FileStore(() => {}), now: () => (now += 5000) });
            const request = { change: 'write', path: 'w.bin', entry: new Uint8Array(n).fill(1) };
            return () => writes.record(request);
        },
    }],
    rpcFrames: [{
        name: 'a request whose argument is a long list of objects', n: 2000,
        make: n => {
            const broker = createBroker(() => {});
            broker.expose('m', (list: unknown) => (list as unknown[]).length);
            const frame = { type: 'RPC_REQ', id: 1, method: 'm', args: [Array.from({ length: n }, (_, i) => ({ i, s: 'abc' }))] };
            return () => broker.handleMessage(frame, () => {});
        },
    }],
    logLines: [{ name: 'a log line of many arguments and long strings', n: 4000, make: n => { const frame = { type: 'LOG', level: 'log', args: [Array.from({ length: n }, (_, i) => `s${i}`), chars(n * 8)] }; return () => toLogDetail(frame, 'guest'); } }],
    violations: [{ name: 'a violation report with long fields', n: 64 * 1024, make: n => { const frame = { type: 'VIOLATION', directive: 'img-src', blockedURI: chars(n), sourceFile: chars(n, 'y'), lineNumber: 1, columnNumber: 2 }; return () => toViolationDetail(frame, 'view'); } }],
    viewFrames: [{
        name: "the view's notes of the initial view, and a height", n: 4000,
        make: n => {
            const el = element;
            const { port1 } = new MessageChannel();
            el._viewPort = port1;
            const notes = { type: 'VIEW_INITIAL', dropped: Array.from({ length: n }, () => 'reference') };
            return () => { el._onViewMessage(port1, notes); el._onViewMessage(port1, { type: 'RESIZE', height: n }); };
        },
    }],
    fetchBridge: [{
        name: 'a request with a long URL and every header', n: 1024,
        make: n => {
            const policy: FetchPolicy = { allow: ['https://api.example' as Origin], maxBytes: 1 << 20, timeoutMs: 1000, methods: ['GET', 'POST'], headers: ['x-a'], maxConcurrent: 4 };
            const request = { url: `https://api.example/${chars(n, 'p')}`, method: 'POST', headers: Array.from({ length: 64 }, () => ['x-a', chars(n / 8, 'v')]), body: chars(n * 8, 'b') };
            return () => validateRequest(request, policy, HOST);
        },
    }],
    announcement: [{ name: "a refusal's line, with a long reason", n: 64 * 1024, make: n => { const reason = chars(n, 'r'); return () => hostLine('refusedByHostPage', reason); } }],
    carried: [{ name: "an event's detail, frozen", n: 4000, make: n => { const detail = { paths: Array.from({ length: n }, (_, i) => `p${i}`) }; return () => elementEvent('fileschanged', detail); } }],
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe('every pass of the host realm over guest content is linear in it (HOST_PASSES; BD7:LIM-2)', () => {
    it('every row has its shapes, and every shape names a row', () => {
        expect(Object.keys(SHAPES).sort(), 'a row of HOST_PASSES with no shapes here: give it the inputs that would cost it most').toEqual(Object.keys(HOST_PASSES).sort());
        for (const shapes of Object.values(SHAPES)) expect(shapes.length).toBeGreaterThan(0);
    });

    const cases = (Object.keys(SHAPES) as HostPassId[]).flatMap(id => SHAPES[id].map(shape => [id, shape.name, shape] as const));
    it.each(cases)('%s: %s', async (_, __, shape) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await host();
        const result = scalingRatio(timed(shape.make, shape.n), timed(shape.make, shape.n * 8), { bound: BOUND });
        expect(result.ratio, result.message).toBeLessThan(BOUND);
    }, 120000);
});
