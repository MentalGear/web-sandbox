import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import { useRecorder, wss } from './recorder';
import { WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS } from '@src/lib/worker-globals';

/**
 * Independent verification 2026-10-14 (docs/security/VERIFICATION-2026-10-14.md), where browser behaviour decides:
 *   V1  a guest worker (worker mode, strict mode) keeps only the allowlisted globals: Firefox sent a worker's
 *       EventSource (and loaded a worker's FontFace) past the policy; every other network API of a worker is gone or
 *       governed. A worker the guest creates in iframe mode is a realm of its own (residual, measured).
 * Evidence (T5): the recorder's listeners outside the browser, with a positive control beside each negative.
 */

const recorder = useRecorder();

// The globals the library itself puts on the worker after the allowlist ran (bridge, sandboxFiles, sandboxFetch,
// sandboxView, and strict mode's per-build entry marker).
const LIBRARY_GLOBALS = ['bridge', 'sandboxFiles', 'sandboxFetch', 'sandboxView'];

// Every network-capable thing a worker global has offered on some engine, aimed at the blocked listener.
const ATTEMPTS = (blocked: string) => `
    const attempt = (name, fn) => { try { const r = fn(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) {} };
    attempt('EventSource', () => new EventSource('${blocked}/v1-es?x=1'));
    attempt('WebTransport', () => new WebTransport('${blocked}/v1-wt'));
    attempt('WebSocketStream', () => new WebSocketStream('${wss(blocked)}/v1-wss'));
    attempt('FontFace', () => new FontFace('v1', 'url(${blocked}/v1-font.woff)').load());
    attempt('fonts', () => fonts.load('12px v1'));
    attempt('caches', () => caches.open('v1').then((c) => c.add('${blocked}/v1-cache')));
    attempt('serviceWorker', () => navigator.serviceWorker.register('${blocked}/v1-sw.js'));
    attempt('Notification', () => new Notification('v1', { icon: '${blocked}/v1-icon.png' }));
    attempt('sendBeacon', () => navigator.sendBeacon('${blocked}/v1-beacon', 'x'));
    attempt('Worker', () => new Worker(URL.createObjectURL(new Blob(["fetch('${blocked}/v1-nested').catch(() => {}); try { new EventSource('${blocked}/v1-nested-es') } catch (e) {}"], { type: 'text/javascript' }))));
    attempt('SharedWorker', () => new SharedWorker(URL.createObjectURL(new Blob(["fetch('${blocked}/v1-shared').catch(() => {})"], { type: 'text/javascript' }))));
    attempt('import', () => import('${blocked}/v1-dynamic.js'));
    attempt('importScripts', () => importScripts('${blocked}/v1-import.js'));
    attempt('fetch', () => fetch('${blocked}/v1-fetch', { mode: 'no-cors' }));
    attempt('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', '${blocked}/v1-xhr', false); x.send(); });
    attempt('WebSocket', () => new WebSocket('${wss(blocked)}/v1-ws'));
    attempt('compileStreaming', () => WebAssembly.compileStreaming(fetch('${blocked}/v1-wasm')));
`;

test.describe('V1: a guest worker keeps only the allowlisted globals; every request it can make is governed by the policy', () => {
    for (const mode of ['worker', 'strict'] as const) {
        test(`${mode} mode: new EventSource() to an origin connect-src blocks reaches nothing (Firefox sent it); fetch to the allowed listener arrives (positive control)`, async ({ sandbox }) => {
            expect(await sandbox.mount({ mode, connectionsAllowed: { 'connect-src': [recorder.allowed] } })).toBe('ready');
            await sandbox.run(`try { new EventSource('${recorder.blocked}/es?x=1'); } catch (e) {} fetch('${recorder.allowed}/es-control').catch(() => {});`);
            await recorder.waitFor('allowed', '/es-control');
            await sandbox.page.waitForTimeout(1000);
            expect(recorder.paths('blocked')).toEqual([]);
        });

        test(`${mode} mode: the worker's globals are the allowlist and nothing else, and no network API of any engine reaches the blocked listener; fetch, XMLHttpRequest, WebSocket${mode === 'worker' ? ' and importScripts' : ''} reach the allowed one (positive controls)`, async ({ sandbox }) => {
            const scriptSources = mode === 'worker' ? { 'script-src': ["'unsafe-inline'", recorder.allowed] } : {};
            expect(await sandbox.mount({ mode, connectionsAllowed: { 'connect-src': [recorder.allowed, wss(recorder.allowed)], 'font-src': [recorder.allowed], ...scriptSources } })).toBe('ready');
            const seen = await sandbox.inGuest(`
                // a WebIDL constant (a non-configurable primitive, Chromium's TEMPORARY) cannot be deleted and requests nothing
                const isConstant = (owner, n) => { const d = Object.getOwnPropertyDescriptor(owner, n); return !d.configurable && 'value' in d && Object(d.value) !== d.value; };
                const names = Object.getOwnPropertyNames(globalThis).filter((n) => !isConstant(globalThis, n));
                for (let p = Object.getPrototypeOf(globalThis); p && p !== EventTarget.prototype; p = Object.getPrototypeOf(p)) names.push(...Object.getOwnPropertyNames(p).filter((n) => n !== 'constructor' && !isConstant(p, n)));
                const navigatorMembers = Object.getOwnPropertyNames(Object.getPrototypeOf(navigator)).filter((n) => n !== 'constructor');
                return { names: [...new Set(names)].sort(), navigatorMembers: navigatorMembers.sort() };
            `);
            const allowed = new Set([...WORKER_GLOBALS, ...LIBRARY_GLOBALS]);
            expect(seen.names.filter((name: string) => !allowed.has(name) && !name.startsWith('__sandboxEntryRan_'))).toEqual([]);
            expect(seen.navigatorMembers.filter((name: string) => !WORKER_NAVIGATOR_MEMBERS.includes(name))).toEqual([]);

            await sandbox.run(ATTEMPTS(recorder.blocked) + `
                fetch('${recorder.allowed}/v1-fetch-control').catch(() => {});
                const x = new XMLHttpRequest(); x.open('GET', '${recorder.allowed}/v1-xhr-control'); x.send();
                new WebSocket('${wss(recorder.allowed)}/v1-ws-control');
                ${mode === 'worker' ? `importScripts('${recorder.allowed}/v1-import-control.js');` : ''}
            `);
            for (const control of ['/v1-fetch-control', '/v1-xhr-control', '/v1-ws-control', ...(mode === 'worker' ? ['/v1-import-control.js'] : [])]) {
                await recorder.waitFor('allowed', control);
            }
            await sandbox.page.waitForTimeout(1500);
            expect(recorder.paths('blocked')).toEqual([]);
        });
    }

    test('positive control of the evidence: an EventSource the policy allows reaches the allowed listener (iframe mode, the document)', async ({ sandbox }) => {
        expect(await sandbox.mount({ connectionsAllowed: { 'connect-src': [recorder.allowed] } })).toBe('ready');
        await sandbox.run(`new EventSource('${recorder.allowed}/es-allowed?x=1');`);
        await recorder.waitFor('allowed', '/es-allowed');
        expect(recorder.hits.find(hit => hit.path.startsWith('/es-allowed'))?.headers.accept).toBe('text/event-stream');
    });

    test('residual (measured), iframe mode: a worker the guest creates is a realm of its own; Firefox sends its EventSource and loads its FontFace past the policy, Chromium and WebKit do not', async ({ sandbox, browserName }) => {
        expect(await sandbox.mount({ connectionsAllowed: { 'connect-src': [recorder.allowed] } })).toBe('ready');
        const body = `try { new EventSource('${recorder.blocked}/v1-guest-worker-es') } catch (e) {} try { new FontFace('v1', 'url(${recorder.blocked}/v1-guest-worker-font.woff)').load().catch(() => {}) } catch (e) {} fetch('${recorder.allowed}/v1-guest-worker-control').catch(() => {});`;
        await sandbox.run(`new Worker(URL.createObjectURL(new Blob([${JSON.stringify(body)}], { type: 'text/javascript' })));`);
        await recorder.waitFor('allowed', '/v1-guest-worker-control'); // the guest's worker runs (positive control)
        await sandbox.page.waitForTimeout(1000);
        expect(recorder.paths('blocked').sort()).toEqual(browserName === 'firefox' ? ['/v1-guest-worker-es', '/v1-guest-worker-font.woff'] : []);
    });
});
