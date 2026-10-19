import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFetchBridge, toFetchPolicy, FETCH_ERROR_CODES, type FetchBridge, type FetchBridgeConfig, type FetchRecord } from '@src/lib/fetch-bridge';

/**
 * Class L (docs/research/18_finding_classes/README.md), finding LM-1: after its environment's teardown, the fetch bridge
 * reports only 'aborted' (docs/API.md, FetchRecord). The model-based lifecycle suite found a `fetch` listener that tore the
 * environment down receiving an 'ok' record of that environment afterwards: the outcome was decided on each settle path,
 * and only the catch looked at the teardown. Now one chokepoint decides it (fetch-bridge.ts, createFetchBridge's record),
 * and this is its structural test.
 *
 * Every way a request can settle is one entry of PATHS. Each entry is run twice:
 *   - alone: nothing tears the bridge down, and the record has the outcome the path stands for (so the entry really
 *     reaches its path, and stays reaching it);
 *   - torn: abortAll() runs at the path's last possible point, and the record made after it is 'aborted' with code
 *     FETCH_FAILED, its status and bytes as measured, and the guest's call rejects with the teardown refusal.
 * The last possible point is, for most paths, inside record() itself, just before the outcome is decided: the bridge's
 * clock is read there first, and the test's clock calls abortAll() (`record`). Later than that nothing can run before
 * the record is handed over. Paths whose teardown happens elsewhere say so: `reading` (during the body read, from the
 * response's own stream), `before` (abortAll() before the request reaches the bridge).
 *
 * A new settle path has to be added here: every FetchErrorCode and every outcome must appear in PATHS (below), and the
 * bridge calls onRecord in one place only, so no path can report around the chokepoint.
 */

const ORIGIN = 'https://api.example';
const HOST = 'https://host.example';

/** Where abortAll() runs: inside record() before the outcome is decided, during the body read, or before the request. */
type TeardownPoint = 'record' | 'reading' | 'before';

interface Context {
    signal: AbortSignal;
    /** Tears the bridge down here when the path's point is 'reading' and the run is the torn one; else nothing. */
    reading: () => void;
}

interface SettlePath {
    name: string;
    config?: Partial<FetchBridgeConfig>;
    request: Record<string, unknown>;
    /** The fake fetch's answer. Like the browser's fetch, a response's body errors when the request's signal aborts. */
    respond: (context: Context) => Promise<Response>;
    /** Another request first, on the same bridge (the busy path's blocker); its records are not this path's. */
    before?: (bridge: FetchBridge) => void;
    last: TeardownPoint;
    /** What the path records when nothing tears the bridge down; null for a path that exists only after a teardown. */
    alone: Pick<FetchRecord, 'outcome' | 'code' | 'status' | 'bytes' | 'reason'> | null;
    /** Status and bytes of the torn record: what was measured when the teardown came. */
    torn: Pick<FetchRecord, 'status' | 'bytes'>;
}

const bytes = (n: number) => new Uint8Array(n).fill(65);

/** A body of these chunks; `pause` runs before the chunk at that index is given (the reading teardown point). */
function streamed(context: Context, chunks: Uint8Array[], pause = -1): Response {
    let index = 0;
    let errored = false;
    const body = new ReadableStream<Uint8Array>({
        start(stream) {
            context.signal.addEventListener('abort', () => {
                errored = true;
                stream.error(new DOMException('aborted', 'AbortError'));
            });
        },
        pull(stream) {
            if (index === pause) context.reading();
            if (errored) return;
            const chunk = chunks[index++];
            if (chunk) stream.enqueue(chunk);
            else stream.close();
        },
    });
    return new Response(body, { status: 200 });
}

/** A fetch that never answers on its own: it rejects, as the browser's does, with the signal's reason when aborted. */
const hanging = ({ signal }: Context) => new Promise<Response>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
});

const PATHS: SettlePath[] = [
    {
        name: 'ok (the teardown after the body was read, before the record: LM-1)',
        request: { url: `${ORIGIN}/ok` },
        respond: async (context) => streamed(context, [bytes(5)]),
        last: 'record',
        alone: { outcome: 'ok', status: 200, bytes: 5 },
        torn: { status: 200, bytes: 5 },
    },
    {
        name: 'an HTTP error status, which is still ok',
        request: { url: `${ORIGIN}/down` },
        respond: async () => new Response(bytes(4), { status: 503 }),
        last: 'record',
        alone: { outcome: 'ok', status: 503, bytes: 4 },
        torn: { status: 503, bytes: 4 },
    },
    {
        name: 'a redirect, never followed',
        request: { url: `${ORIGIN}/moved` },
        respond: async () => new Response(null, { status: 302, headers: { location: `${ORIGIN}/elsewhere` } }),
        last: 'record',
        alone: { outcome: 'failed', code: 'FETCH_REDIRECT', bytes: 0 },
        torn: { bytes: 0 },
    },
    {
        name: 'a network failure',
        request: { url: `${ORIGIN}/unreachable` },
        respond: () => Promise.reject(new TypeError('Failed to fetch')),
        last: 'record',
        alone: { outcome: 'failed', code: 'FETCH_FAILED', bytes: 0 },
        torn: { bytes: 0 },
    },
    {
        name: 'a timeout',
        config: { timeoutMs: 5 },
        request: { url: `${ORIGIN}/slow` },
        respond: hanging,
        last: 'record',
        alone: { outcome: 'failed', code: 'FETCH_TIMEOUT', bytes: 0 },
        torn: { bytes: 0 },
    },
    {
        name: 'a body over maxBytes, read incrementally',
        config: { maxBytes: 4 },
        request: { url: `${ORIGIN}/large` },
        respond: async (context) => streamed(context, [bytes(3), bytes(3)]),
        last: 'record',
        alone: { outcome: 'failed', code: 'FETCH_TOO_LARGE', status: 200, bytes: 6 },
        torn: { status: 200, bytes: 6 },
    },
    {
        name: "refused by the bridge's policy (an unlisted origin, with the host's reason)",
        request: { url: `${HOST}/own` },
        respond: () => Promise.reject(new Error('not called')),
        last: 'record',
        alone: { outcome: 'refused', code: 'FETCH_NOT_ALLOWED', bytes: 0, reason: "the host page's own origin, which is not in fetchBridge.allow" },
        torn: { bytes: 0 },
    },
    {
        name: 'refused by the Request constructor',
        request: { url: `${ORIGIN}/header`, headers: [['accept', 'a\nb']] },
        respond: () => Promise.reject(new Error('not called')),
        last: 'record',
        alone: { outcome: 'refused', code: 'FETCH_NOT_ALLOWED', bytes: 0 },
        torn: { bytes: 0 },
    },
    {
        name: 'refused as busy (maxConcurrent in flight)',
        config: { maxConcurrent: 1 },
        request: { url: `${ORIGIN}/second` },
        before: (bridge) => { bridge.handle({ url: `${ORIGIN}/blocker` }).catch(() => {}); },
        respond: hanging,
        last: 'record',
        alone: { outcome: 'refused', code: 'FETCH_BUSY', bytes: 0 },
        torn: { bytes: 0 },
    },
    {
        name: 'refused after close (a request of the torn-down environment that reaches its bridge late)',
        request: { url: `${ORIGIN}/late` },
        respond: () => Promise.reject(new Error('not called')),
        last: 'before',
        alone: null,
        torn: { bytes: 0 },
    },
    {
        name: 'the teardown while the body is being read',
        request: { url: `${ORIGIN}/reading` },
        respond: async (context) => streamed(context, [bytes(3), bytes(3)], 1),
        last: 'reading',
        alone: { outcome: 'ok', status: 200, bytes: 6 },
        torn: { status: 200, bytes: 3 },
    },
];

/** Runs one path on a bridge of its own; `torn` tears it down at the path's last point. */
async function run(entry: SettlePath, torn: boolean) {
    const records: FetchRecord[] = [];
    let clockReads = 0;
    let bridge: FetchBridge | null = null;
    const policy = toFetchPolicy({ allow: [ORIGIN], ...entry.config }, () => {})!;
    // one request per run reaches record(): the clock is read when it arrives, and again inside record()
    let armed = false;
    bridge = createFetchBridge({
        policy,
        hostOrigin: HOST,
        onRecord: (record) => records.push(record),
        fetchImpl: ((_request: Request, init: RequestInit) => entry.respond({
            signal: init.signal!,
            reading: () => { if (torn && entry.last === 'reading') bridge!.abortAll(); },
        })) as unknown as typeof fetch,
        now: () => {
            if (armed && ++clockReads === 2 && torn && entry.last === 'record') bridge!.abortAll();
            return 0;
        },
    });
    entry.before?.(bridge);
    if (torn && entry.last === 'before') bridge.abortAll();
    armed = true;
    const settled = await bridge.handle(entry.request).then(
        (result) => ({ result, error: null }),
        (error: Error & { code?: string }) => ({ result: null, error }),
    );
    bridge.abortAll(); // ends the busy path's blocker
    await new Promise(resolve => setTimeout(resolve, 0));
    const url = String(entry.request.url);
    return { settled, records: records.filter(record => record.url === url) };
}

describe('LM-1, class L: after abortAll() every record of the bridge is aborted, on every settle path', () => {
    describe.each(PATHS)('$name', (entry) => {
        // a path that exists only after a teardown (refused after close) has no alone half
        if (entry.alone !== null) it('alone: the path is reached and records what it stands for', async () => {
            const { records } = await run(entry, false);
            expect(records).toHaveLength(1);
            const { durationMs: _ignored, method: _method, url: _url, ...record } = records[0]!;
            const expected: Partial<FetchRecord> = { ...entry.alone };
            if (expected.status === undefined) delete expected.status;
            const actual: Partial<FetchRecord> = { ...record };
            if (actual.status === undefined) delete actual.status;
            expect(actual).toEqual(expected);
        });

        it(`torn at its last possible point (${entry.last}): aborted, as measured, and the guest is told the sandbox was torn down`, async () => {
            const { settled, records } = await run(entry, true);
            expect(records).toHaveLength(1);
            const record = records[0]!;
            expect(record.outcome).toBe('aborted');
            expect(record.code).toBe('FETCH_FAILED');
            expect(record.reason).toBeUndefined();
            expect(record.status).toBe(entry.torn.status);
            expect(record.bytes).toBe(entry.torn.bytes);
            expect(settled.result).toBeNull();
            expect(settled.error).toMatchObject({ code: 'FETCH_FAILED', message: expect.stringContaining('the sandbox was torn down') });
        });
    });

    it('PATHS names every refusal code and every outcome, so a new settle path has to be added to it', () => {
        const codes = new Set(PATHS.map(entry => entry.alone?.code));
        for (const code of FETCH_ERROR_CODES) expect(codes, code).toContain(code);
        const outcomes = new Set(PATHS.map(entry => entry.alone?.outcome));
        for (const outcome of ['ok', 'refused', 'failed'] as const) expect(outcomes, outcome).toContain(outcome);
        // 'aborted' is what the torn half checks on every path
        for (const point of ['record', 'reading', 'before'] as const) expect(PATHS.some(entry => entry.last === point), point).toBe(true);
    });

    it('the bridge reports through one place only: onRecord is called in record() and nowhere else', () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(path.join(here, '../../src/lib/fetch-bridge.ts'), 'utf8');
        const body = source.slice(source.indexOf('export function createFetchBridge'));
        const recordFn = body.slice(body.indexOf('const record = '), body.indexOf('const tornDown = '));
        expect([...body.matchAll(/onRecord\(/g)].length).toBe(2); // the closed branch and the open one, both in record()
        expect([...recordFn.matchAll(/onRecord\(/g)].length).toBe(2);
        // and the outcome 'aborted' is chosen nowhere else: no path proposes it, record() alone sets it
        expect(body).not.toMatch(/record\(base, 'aborted'/);
        expect([...recordFn.matchAll(/outcome: 'aborted'/g)].length).toBe(1);
        expect([...body.matchAll(/outcome: 'aborted'/g)].length).toBe(1);
    });

    it('the shape of LM-1: a listener of one record tears the bridge down, and a request whose body was read is aborted', async () => {
        const records: FetchRecord[] = [];
        const gate: (() => void)[] = [];
        let bridge: FetchBridge | null = null;
        bridge = createFetchBridge({
            policy: toFetchPolicy({ allow: [ORIGIN] }, () => {})!,
            hostOrigin: HOST,
            onRecord: (record) => {
                records.push(record);
                if (records.length === 1) bridge!.abortAll(); // the first record's listener resets the sandbox
            },
            // the four answers come at once: their bodies are read together, as in the e2e test of LM-1
            fetchImpl: (() => new Promise<Response>(resolve => {
                gate.push(() => resolve(new Response(bytes(70), { status: 200 })));
                if (gate.length === 4) for (const open of gate) open();
            })) as unknown as typeof fetch,
        });
        const settled = await Promise.allSettled([0, 1, 2, 3].map(i => bridge!.handle({ url: `${ORIGIN}/r${i}` })));
        expect(records.map(record => record.outcome)).toEqual(['ok', 'aborted', 'aborted', 'aborted']);
        expect(records.slice(1).every(record => record.status === 200 && record.bytes === 70)).toBe(true);
        expect(settled.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'rejected', 'rejected']);
    });
});
