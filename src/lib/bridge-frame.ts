/**
 * The fetch bridge's frame, host side (ADR-006; P1-ISO-1, class E-net): the frame that makes every bridge request, and
 * the transport the bridge is given (fetch-bridge.ts, createFetchBridge). The one chokepoint for where a bridge request
 * runs: the host decides it, this frame makes it, and nothing of the host page's makes it.
 *
 *   host page
 *   └─ element's shadow root
 *      ├─ wrapper frame (the sandbox)
 *      └─ bridge frame  (hidden; sandbox="allow-scripts": an opaque origin of its own; srcdoc, the library's document)
 *
 * Why a frame of its own: a request made with the host page's `fetch` runs in the host page's fetch environment, so the
 * host page's Service Worker answers it (from the host app's cache, in Chromium and WebKit) and any wrapper of the host
 * page's `fetch` (an auth header, a tracing header) applies to it. An opaque origin is never a Service Worker client, a
 * cross-origin realm is out of reach of the host page's wrappers, and its requests carry `Origin: null`, as a direct
 * request of the guest's would. A fresh same-origin realm would not do: WebKit's same-origin frames and every engine's
 * host-made blob: workers are controlled by the host page's Service Worker.
 *
 * The frame's document is built by the frame builder (frame-documents.ts, buildBridgeDocument): its own policy
 * (csp-generator.ts, bridgeFramePolicy: the bootstrap's hash, and connect-src the allowlist's origins only) and the
 * library's hashed bootstrap, so the host page's policy admits it exactly when it admits strict mode's view
 * (viewScriptHash(), docs/API.md#host-page-policy). Its channel: one BRIDGE_INIT from the host, at the frame's load, with
 * the port; the frame answers BRIDGE_READY on it. A frame that has not answered within the startup bound (the build's,
 * LOAD_TIMEOUT_MS, in host ticks) never will: the host page's policy refused its script. The bridge then fails closed:
 * every request is refused (FETCH_FAILED, with BRIDGE_FRAME_REFUSED as its record's reason), and the sandbox is
 * otherwise untouched.
 *
 * One frame per environment, made by the build with the bridge and removed by the teardown with it (host.ts): once
 * closed, every request it holds rejects, and the frame's removal ends its fetches upstream.
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */
import { fetchRefusal, type BridgeResponse, type BridgeTransport, type FetchErrorCode, type FetchRefusal } from './fetch-bridge';
import { BRIDGE_FRAME_SANDBOX, buildBridgeDocument, FRAME_REFERRER_POLICY } from './frame-documents';
import { bridgeFramePolicy } from './csp/csp-generator';
import { BRIDGE_ROLE, viewBootstrapHash, viewBootstrapText } from './in-sandbox-view';
import { setLibrarySrcdoc } from './trusted-types';
import { startWatchdog } from './watchdog';
import type { Origin } from './origin';

/** The record's reason when the bridge's frame never started: what the host page's policy refused. */
export const BRIDGE_FRAME_REFUSED = "the fetch bridge's frame did not start: the host page's Content-Security-Policy must allow its script, the hash viewScriptHash() returns (see docs/API.md#host-page-policy)";

/** The frame's iframe, its document written, not yet in the document (the build prepares it: host.ts, _prepareBuild). */
export function prepareBridgeFrame(allow: readonly Origin[]): HTMLIFrameElement {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', BRIDGE_FRAME_SANDBOX);
    iframe.setAttribute('referrerpolicy', FRAME_REFERRER_POLICY);
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.hidden = true; // the user agent's own style: no style-src governs it
    // srcdoc goes in before the frame is inserted, so its first load is this document's
    setLibrarySrcdoc(iframe, buildBridgeDocument(bridgeFramePolicy({ allow, bootstrapHash: viewBootstrapHash() }), viewBootstrapText(), BRIDGE_ROLE));
    return iframe;
}

export interface BridgeFrameSetup {
    /** The prepared frame (prepareBridgeFrame). */
    iframe: HTMLIFrameElement;
    /** Where it goes: the element's shadow root. */
    parent: ParentNode;
    /** `fetchBridge.maxBytes`: the frame posts no further chunk of a body once more than this was read. */
    maxBytes: number;
    /** How long the frame may take to answer, in ms of host ticks. */
    startupTimeoutMs: number;
    /** Called once, when the frame did not answer in time. */
    onRefused: () => void;
}

export interface BridgeFrame {
    /** The bridge's transport (createFetchBridge): makes one request in the frame. */
    readonly transport: BridgeTransport;
    /** Ends the frame with its environment: removes it and closes its port; every request it holds rejects. Idempotent. */
    close(): void;
}

// The guest's text for each code the frame reports; the record's code is the frame's.
const FRAME_MESSAGES: Readonly<Record<string, string>> = {
    FETCH_FAILED: 'the request failed (network error or CORS)',
    FETCH_TOO_LARGE: "the response's headers are too large",
    FETCH_NOT_ALLOWED: 'the browser refused the request',
};

type HeaderList = BridgeResponse['headers'];

const headerList = (pairs: readonly (readonly [string, string])[]): HeaderList => {
    const get = (name: string): string | null => {
        const lower = name.toLowerCase();
        for (const [key, value] of pairs) if (key === lower) return value;
        return null;
    };
    return {
        get,
        has: (name) => get(name) !== null,
        forEach: (callback) => {
            for (const [key, value] of pairs) callback(value, key);
        },
    };
};

// A head the frame posted, checked on receipt (the frame is the library's, so this is a check of shape only).
const isPairs = (value: unknown): value is [string, string][] =>
    Array.isArray(value) && value.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string');

interface Pending {
    head(type: string, status: number, statusText: string, headers: [string, string][], hasBody: boolean): void;
    chunk(bytes: Uint8Array): void;
    end(): void;
    fail(error: Error): void;
}

/** Puts the prepared frame in `parent` and opens its channel. */
export function createBridgeFrame(setup: BridgeFrameSetup): BridgeFrame {
    const { iframe } = setup;
    let state: 'starting' | 'ready' | 'refused' | 'closed' = 'starting';
    let initSent = false;
    let ids = 0;
    const channel = new MessageChannel();
    const port = channel.port1;
    const waiting = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
    const pending = new Map<number, Pending>();

    const unsent = (): FetchRefusal => {
        const refusal = fetchRefusal('FETCH_FAILED', 'the fetch bridge is not available');
        refusal.reason = BRIDGE_FRAME_REFUSED;
        refusal.unsent = true;
        return refusal;
    };
    const aborted = () => fetchRefusal('FETCH_FAILED', 'the request was aborted');

    const deadline = startWatchdog({
        timeoutMs: setup.startupTimeoutMs,
        ping: () => {},
        onExpire: () => {
            if (state !== 'starting') return;
            state = 'refused';
            for (const waiter of [...waiting]) waiter.reject(unsent());
            setup.onRefused();
        },
    });

    // Only this frame's port, only while it is open (the other library ports' rule: AR:B4).
    port.onmessage = (event) => {
        if (state === 'closed' || state === 'refused') return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        const type = data.type;
        if (state === 'starting') {
            if (type !== 'BRIDGE_READY') return;
            state = 'ready';
            deadline.stop();
            for (const waiter of [...waiting]) waiter.resolve();
            return;
        }
        const entry = typeof data.id === 'number' ? pending.get(data.id) : undefined;
        if (!entry) return;
        if (type === 'BRIDGE_HEAD') {
            const { responseType, status, statusText, headers, hasBody } = data;
            if (typeof responseType !== 'string' || typeof status !== 'number' || typeof statusText !== 'string' || !isPairs(headers) || typeof hasBody !== 'boolean') {
                entry.fail(fetchRefusal('FETCH_FAILED', FRAME_MESSAGES.FETCH_FAILED!));
                return;
            }
            entry.head(responseType, status, statusText, headers, hasBody);
        } else if (type === 'BRIDGE_CHUNK') {
            const chunk = data.chunk;
            // by its tag, not instanceof: a chunk is the frame's bytes, made in the realm the port delivers into
            if (ArrayBuffer.isView(chunk) && Object.prototype.toString.call(chunk) === '[object Uint8Array]') entry.chunk(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            else entry.fail(fetchRefusal('FETCH_FAILED', FRAME_MESSAGES.FETCH_FAILED!));
        } else if (type === 'BRIDGE_END') {
            entry.end();
        } else if (type === 'BRIDGE_ERROR') {
            const code = typeof data.code === 'string' && Object.hasOwn(FRAME_MESSAGES, data.code) ? data.code as FetchErrorCode : 'FETCH_FAILED';
            entry.fail(fetchRefusal(code, FRAME_MESSAGES[code]!));
        }
    };

    // At the frame's load its bootstrap has run, if the host page's policy let it: it is listening for BRIDGE_INIT.
    iframe.onload = () => {
        if (state !== 'starting' || initSent) return;
        const target = iframe.contentWindow;
        if (!target) return;
        initSent = true;
        target.postMessage({ type: 'BRIDGE_INIT', maxBytes: setup.maxBytes }, '*', [channel.port2]);
    };
    setup.parent.appendChild(iframe);

    const ready = (signal: AbortSignal): Promise<void> => {
        if (state === 'ready') return Promise.resolve();
        if (state === 'refused') return Promise.reject(unsent());
        if (state === 'closed' || signal.aborted) return Promise.reject(aborted());
        return new Promise<void>((resolve, reject) => {
            const waiter = {
                resolve: () => { done(); resolve(); },
                reject: (error: Error) => { done(); reject(error); },
            };
            const onAbort = () => waiter.reject(aborted());
            const done = () => {
                waiting.delete(waiter);
                signal.removeEventListener('abort', onAbort);
            };
            waiting.add(waiter);
            signal.addEventListener('abort', onAbort, { once: true });
        });
    };

    const transport: BridgeTransport = async (request, init) => {
        const signal = init.signal;
        if (!signal) throw fetchRefusal('FETCH_FAILED', 'the request has no signal'); // createFetchBridge always gives one
        await ready(signal);
        if (signal.aborted) throw aborted();
        const id = ++ids;
        return new Promise<BridgeResponse>((resolve, reject) => {
            let headed = false;
            let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
            let pulled: (() => void) | null = null;
            const finish = () => {
                pending.delete(id);
                signal.removeEventListener('abort', onAbort);
            };
            const release = () => {
                const resume = pulled;
                pulled = null;
                if (resume) resume();
            };
            const fail = (error: Error) => {
                finish();
                if (!headed) {
                    headed = true;
                    reject(error);
                    return;
                }
                try { stream?.error(error); } catch {}
                release();
            };
            const onAbort = () => {
                if (state === 'ready') port.postMessage({ type: 'BRIDGE_ABORT', id });
                fail(aborted());
            };
            pending.set(id, {
                head: (type, status, statusText, headers, hasBody) => {
                    if (headed) return;
                    headed = true;
                    // highWaterMark 0: a chunk is asked for only when the bridge reads one, so at most one is in flight
                    const body = hasBody ? new ReadableStream<Uint8Array>({
                        start: (controller) => { stream = controller; },
                        pull: () => new Promise<void>((resume) => {
                            if (!pending.has(id)) { resume(); return; }
                            pulled = resume;
                            port.postMessage({ type: 'BRIDGE_PULL', id });
                        }),
                        cancel: () => {
                            if (!pending.has(id)) return;
                            port.postMessage({ type: 'BRIDGE_ABORT', id });
                            finish();
                        },
                    }, { highWaterMark: 0 }) : null;
                    if (!hasBody) finish();
                    resolve({ type, status, statusText, headers: headerList(headers), body });
                },
                chunk: (bytes) => {
                    if (!stream || !pulled) return;
                    stream.enqueue(bytes);
                    release();
                },
                end: () => {
                    finish();
                    try { stream?.close(); } catch {}
                    release();
                },
                fail,
            });
            signal.addEventListener('abort', onAbort, { once: true });
            port.postMessage({
                type: 'BRIDGE_FETCH',
                id,
                url: request.url,
                method: init.method,
                headers: init.headers,
                body: init.body,
            });
        });
    };

    const close = () => {
        if (state === 'closed') return;
        state = 'closed';
        deadline.stop();
        for (const waiter of [...waiting]) waiter.reject(aborted());
        for (const entry of [...pending.values()]) entry.fail(aborted());
        port.onmessage = null;
        port.close();
        iframe.onload = null;
        iframe.remove();
    };

    return { transport, close };
}
