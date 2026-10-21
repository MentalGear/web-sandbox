/**
 * The fetch bridge's frame, frame side (ADR-006; P1-ISO-1, class E-net): the only code that performs a request of the
 * bridge. The host decides every request (fetch-bridge.ts: the allowlist, methods, headers, the budgets, the redirect
 * and size refusals, the record); this frame makes it, from an opaque origin of its own, so the request is never the
 * host page's: no Service Worker controls an opaque origin, no wrapper of the host page's `fetch` can reach a
 * cross-origin realm, and the target sees `Origin: null`, as for a direct request of the guest's.
 *
 * Stringified into the library's hashed bootstrap (in-sandbox-view.ts, viewBootstrapSource), which runs it in the
 * frame's document (bridge-frame.ts, buildBridgeDocument) and nowhere else. No guest code or markup ever reaches that
 * document: the guest has no handle on the frame (it is in the element's shadow root), and the frame hears only its
 * parent, the host page, once, and then its own port.
 */

/** What the frame's function is given, in the bootstrap's text: constants of the library. */
export interface BridgeFrameOptions {
    /** The options every request is made with, whatever the host sends (BRIDGE_REQUEST_OPTIONS). */
    request: Readonly<Record<string, string | boolean>>;
    /** Most characters of a response's status text and header names and values together (MAX_RESPONSE_HEAD). */
    maxHead: number;
}

/**
 * The options every bridge request is made with: no credentials, no referrer, no redirect followed, CORS, no HTTP
 * cache, never kept alive past the frame. The host builds the Request it checks with these (fetch-bridge.ts); the frame
 * makes the request with these, and only the method, the headers and the body come from the host's frame.
 */
export const BRIDGE_REQUEST_OPTIONS = Object.freeze({
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'manual',
    mode: 'cors',
    cache: 'no-store',
    keepalive: false,
} as const);

/**
 * Most characters of one response's status text and header names and values together, checked by the bridge's frame
 * before it posts them: past it the request fails with `FETCH_TOO_LARGE`. Browsers refuse a response whose header
 * block is about this size, so no response a browser reads is refused for it.
 */
export const MAX_RESPONSE_HEAD = 262144;

/** The literal the frame's function is given. */
export const BRIDGE_FRAME_OPTIONS: BridgeFrameOptions = { request: BRIDGE_REQUEST_OPTIONS, maxHead: MAX_RESPONSE_HEAD };

/**
 * The frame's bootstrap. It accepts exactly one BRIDGE_INIT, from its parent (the host page's window), with one port,
 * in a capture listener that stops the event there; any other message is ignored. On the port it answers BRIDGE_READY
 * once, then serves the host's requests: BRIDGE_FETCH makes one, BRIDGE_PULL reads the next chunk of its body (one chunk
 * a pull, none once the request's total passed the `maxBytes` BRIDGE_INIT gave), BRIDGE_ABORT ends it. Every frame it
 * posts carries the host's id; the head's strings are checked against `maxHead` before they are posted.
 */
export function inBridgeFrame(options: BridgeFrameOptions) {
    const g = globalThis as any;
    const runs = (g.__sandboxBridgeRuns || 0) + 1;
    g.__sandboxBridgeRuns = runs;
    if (runs > 1) return;
    // Read once, now: the parent is the host page, the only window that may hand the frame its port.
    const host = parent;
    const platformFetch = fetch;
    const RequestConstructor = Request;
    const ControllerConstructor = AbortController;
    const pinned = options.request;
    const maxHead = options.maxHead;

    let port: MessagePort | null = null;
    let maxBytes = 0;
    type Entry = { controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> | null; bytes: number };
    const requests = new Map<number, Entry>();

    const post = (frame: unknown, transfer: Transferable[]) => {
        if (port) port.postMessage(frame, transfer);
    };
    // Ends a request here: its fetch and its body are aborted, and nothing more of it is posted.
    const end = (id: number) => {
        const entry = requests.get(id);
        if (!entry) return;
        requests.delete(id);
        entry.controller.abort();
    };
    const fail = (id: number, code: string) => {
        end(id);
        post({ type: 'BRIDGE_ERROR', id, code }, []);
    };

    const start = (id: number, url: unknown, method: unknown, headers: unknown, body: unknown) => {
        if (requests.has(id)) return;
        const controller = new ControllerConstructor();
        const entry: Entry = { controller, reader: null, bytes: 0 };
        requests.set(id, entry);
        // The pinned options last, so nothing the frame was sent can change them.
        const init: Record<string, unknown> = { method, headers, body, signal: controller.signal };
        for (const name of Object.keys(pinned)) init[name] = pinned[name];
        let request: Request;
        try {
            request = new RequestConstructor(String(url), init as RequestInit);
        } catch {
            fail(id, 'FETCH_NOT_ALLOWED');
            return;
        }
        // The init again, whole (fetch-bridge.ts: an abort through the Request's own signal alone does not stop a
        // response in WebKit, and a partial init resets the referrer policy).
        platformFetch(request, init as RequestInit).then((response) => {
            const stream = response.body;
            const drop = () => {
                if (stream) stream.cancel().catch(() => {});
            };
            if (!requests.has(id)) {
                drop();
                return;
            }
            const statusText = response.statusText;
            const pairs: [string, string][] = [];
            let length = statusText.length;
            response.headers.forEach((value, name) => {
                pairs.push([name, value]);
                length += name.length + value.length;
            });
            if (length > maxHead) {
                drop();
                fail(id, 'FETCH_TOO_LARGE');
                return;
            }
            entry.reader = stream ? stream.getReader() : null;
            if (!stream) requests.delete(id); // nothing more of it comes
            post({ type: 'BRIDGE_HEAD', id, responseType: response.type, status: response.status, statusText, headers: pairs, hasBody: stream !== null }, []);
        }, () => {
            if (requests.has(id)) fail(id, 'FETCH_FAILED');
        });
    };

    const pull = (id: number) => {
        const entry = requests.get(id);
        if (!entry) return;
        const reader = entry.reader;
        if (!reader) return;
        // A request whose total already passed the cap gets no further chunk: the host refuses it at that chunk anyway.
        if (entry.bytes > maxBytes) {
            fail(id, 'FETCH_TOO_LARGE');
            return;
        }
        reader.read().then((result) => {
            if (!requests.has(id)) return;
            const value = result.value;
            if (result.done || !value) {
                requests.delete(id);
                post({ type: 'BRIDGE_END', id }, []);
                return;
            }
            const size = value.byteLength;
            entry.bytes += size;
            const whole = value.byteOffset === 0 && size === value.buffer.byteLength;
            const chunk = whole ? value : value.slice();
            post({ type: 'BRIDGE_CHUNK', id, chunk }, [chunk.buffer]);
        }, () => {
            if (requests.has(id)) fail(id, 'FETCH_FAILED');
        });
    };

    const onPort = (event: MessageEvent) => {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        const type = data.type;
        const id = data.id;
        if (typeof id !== 'number') return;
        if (type === 'BRIDGE_FETCH') start(id, data.url, data.method, data.headers, data.body);
        else if (type === 'BRIDGE_PULL') pull(id);
        else if (type === 'BRIDGE_ABORT') end(id);
    };

    const onInit = (event: MessageEvent) => {
        if (port || event.source !== host) return;
        const data = event.data;
        const ports = event.ports;
        if (!data || data.type !== 'BRIDGE_INIT' || ports.length !== 1) return;
        event.stopImmediatePropagation();
        const given = data.maxBytes;
        maxBytes = typeof given === 'number' && given > 0 ? given : 0;
        const opened = ports[0]!;
        port = opened;
        opened.onmessage = onPort;
        post({ type: 'BRIDGE_READY' }, []);
    };
    addEventListener('message', onInit, true);
}
