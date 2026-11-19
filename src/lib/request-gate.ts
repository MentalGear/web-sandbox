import type { GATE_SOURCE_FILE } from './violation';

/**
 * The request gate of strict, cooperative and worker mode (S74): the network modes' one chokepoint for the platform's three
 * request makers, `fetch`, `XMLHttpRequest` and `WebSocket`. Sealed mode has none of the three names, so it has no gate: its
 * worker's allowlist leaves them off (SEALED_WORKER_GLOBALS, worker-globals.ts) and this function is never built into its
 * source (a `network` module: the default build's bundle does not hold it).
 *
 * Stringified into the guest's bootstrap (in-sandbox-script.ts), which calls it once, before any guest code runs; so it
 * is self-contained: it names no import at run time, and it takes everything it uses in its own captured list, ended by
 * `CAPTURE_POINT`, which the capture-point scan reads (test/unit/bootstrap-capture-and-measure.test.ts).
 *
 * @param g - The realm's global object.
 * @param mode - The bootstrap's mode: a strict guest has no cookie carrier for a WebSocket handshake, so every one is refused.
 * @param connect - The sources of the guest policy's connect-src, exactly (csp-generator.ts, connectSources).
 * @param report - The bootstrap's report of a refusal as a VIOLATION frame, within its limit: the URL as the engines report it, and the gate's source.
 */
export function requestGate(g: any, mode: 'cooperative' | 'worker' | 'strict', connect: readonly string[], report: (blockedURI: string, sourceFile: string) => void): void {
    // ---- The captured list: the platform's request makers, taken once, and the platform's own members the gate works
    // them with. These are the originals: nothing after this list hands one out, and the gate removes every other
    // reference to them from the realm before guest code runs.
    const apply = Reflect.apply;
    const construct = Reflect.construct;
    const defineOwn = Reflect.defineProperty;
    const deleteOwn = Reflect.deleteProperty;
    const getOwn = Object.getOwnPropertyDescriptor;
    const protoOf = Object.getPrototypeOf;
    const setPrototype = Object.setPrototypeOf;
    const namesOf = Object.getOwnPropertyNames;
    const PromiseConstructor = Promise;
    const rejected = Promise.reject;
    const StringConstructor = String;
    const TypeErrorConstructor = TypeError;
    const DOMExceptionConstructor = typeof DOMException === 'function' ? DOMException : null;
    const slice = String.prototype.slice;
    const WeakMapConstructor = WeakMap;
    const weakGet = WeakMap.prototype.get;
    const weakSet = WeakMap.prototype.set;
    const dispatch = EventTarget.prototype.dispatchEvent;
    const setTimer = g.setTimeout;
    const clearTimer = g.clearTimeout;
    const nativeFetch = g.fetch;
    const RequestConstructor = g.Request;
    let keepaliveOf: (() => unknown) | undefined; // BR:PD2 (below)
    let requestUrlOf: (() => unknown) | undefined;
    for (let proto = typeof RequestConstructor === 'function' ? RequestConstructor.prototype : null; proto && !(keepaliveOf && requestUrlOf); proto = protoOf(proto)) {
        keepaliveOf = keepaliveOf ?? getOwn(proto, 'keepalive')?.get; // own on Request.prototype in every engine measured
        requestUrlOf = requestUrlOf ?? getOwn(proto, 'url')?.get;
    }
    const NativeXMLHttpRequest = g.XMLHttpRequest;
    const xhrPrototype = typeof NativeXMLHttpRequest === 'function' ? NativeXMLHttpRequest.prototype : null;
    const xhrOpen = xhrPrototype ? getOwn(xhrPrototype, 'open')?.value : undefined;
    const xhrSend = xhrPrototype ? getOwn(xhrPrototype, 'send')?.value : undefined;
    const xhrAbort = xhrPrototype ? getOwn(xhrPrototype, 'abort')?.value : undefined;
    const xhrReadyState = xhrPrototype ? getOwn(xhrPrototype, 'readyState')?.get : undefined;
    const xhrWithCredentials = xhrPrototype ? getOwn(xhrPrototype, 'withCredentials')?.get : undefined;
    const NativeWebSocket = g.WebSocket;
    const URLConstructor = g.URL;
    const ObjectPrototypeFound = Object.prototype;
    let urlHref: (() => unknown) | undefined;
    let urlHost: (() => unknown) | undefined;
    let urlProtocol: PropertyDescriptor | undefined;
    let urlUsernameTo: ((value: string) => void) | undefined;
    let urlPasswordTo: ((value: string) => void) | undefined;
    let urlHashTo: ((value: string) => void) | undefined;
    for (let proto = typeof URLConstructor === 'function' ? URLConstructor.prototype : null; proto && proto !== ObjectPrototypeFound; proto = protoOf(proto)) {
        urlHref = urlHref ?? getOwn(proto, 'href')?.get; // own on URL.prototype in every engine
        urlHost = urlHost ?? getOwn(proto, 'host')?.get;
        urlProtocol = urlProtocol ?? getOwn(proto, 'protocol');
        urlUsernameTo = urlUsernameTo ?? getOwn(proto, 'username')?.set;
        urlPasswordTo = urlPasswordTo ?? getOwn(proto, 'password')?.set;
        urlHashTo = urlHashTo ?? getOwn(proto, 'hash')?.set;
    }
    const ProgressEventConstructor = g.ProgressEvent;
    const EventConstructor = g.Event;
    // The base URL a relative one resolves against, as XMLHttpRequest and WebSocket resolve it: the document's base
    // (cooperative mode), or the worker's location.
    const doc: Document | null = mode === 'cooperative' ? document : null;
    const NodeConstructor = doc ? g.Node : null;
    const baseUriOf = NodeConstructor ? getOwn(NodeConstructor.prototype, 'baseURI')?.get : undefined;
    const locationFound = doc ? null : g.location;
    let locationHrefOf: (() => unknown) | undefined;
    for (let proto = locationFound ?? null; proto && !locationHrefOf; proto = protoOf(proto)) locationHrefOf = getOwn(proto, 'href')?.get;
    const CAPTURE_POINT = 'nothing below reads a global, or an intrinsic guest code can replace';

    // Lists of our own: an index written to them never reaches an inherited setter, and they are read by index only.
    const list = <T>(): T[] => setPrototype([], null);
    const append = (target: unknown[], value: unknown) => defineOwn(target, target.length, { value, writable: true, enumerable: true, configurable: true });

    // ---- The request gate (S74): one chokepoint for every request the guest's
    // realm can make with fetch, XMLHttpRequest and WebSocket, so a request behaves, and is reported, the same on every
    // engine. Each request's URL is resolved as the platform resolves it and admitted only when it is exactly one of the
    // sources of the guest policy's connect-src (`connect`, the list the host writes that directive from:
    // csp-generator.ts, connectSources): an origin by its scheme, host and port, or `blob:` for any blob: URL where the
    // build's files put it there. A refused request never reaches the platform. It fails as the platform fails a request
    // its policy refuses (fetch: a rejected TypeError; XMLHttpRequest: a network error, an `error` event, or a NetworkError
    // from a synchronous send(); WebSocket: a SecurityError from the constructor), with one text of the library's, and the
    // gate reports it itself, as a VIOLATION frame of `connect-src` whose sourceFile is the gate's (GATE_SOURCE_FILE,
    // violation.ts), within the bootstrap's VIOLATION_LIMIT (`report`): so an engine that raises no violation in a worker (WebKit) reports
    // it too, and every engine reports one thing. The browser's policy stays underneath (the second layer): a redirect to
    // an origin it refuses is the browser's to refuse and to report, per engine (test/e2e/redirect-refusal.spec.ts, ledger row
    // redirect-refusal-outcome). A gate that errs can only refuse more.
    //
    // fetch and XMLHttpRequest never carry credentials (class A, S74): every fetch is made from a Request built again
    // with `credentials: 'omit'`, and an XMLHttpRequest's `withCredentials` stays false (its setter changes nothing), so
    // no cookie of a listed origin's site rides on either, on any engine. A WebSocket handshake cannot be stripped, and
    // carries what the engine sends (cookie-facts.ts): in strict mode the gate refuses every one (below).
    //
    // BR:PD2, keepalive: Firefox sends `fetch(url, { keepalive: true })` without checking connect-src, so the gate also
    // refuses a keepalive request. It reads `keepalive` and `url` from the Request it built with the captured constructor,
    // exactly as fetch() itself would, so a getter on the init, or a Request made with keepalive, cannot answer twice.
    //
    // The originals cannot be reached from guest code, by construction: each was taken once in the captured list and is
    // only ever called by the gate (test/unit/request-gate.test.ts scans this text for that). Every copy of a gated name on
    // the global object and on its prototype chain is removed (a worker's fetch lives on WorkerGlobalScope.prototype in
    // every engine, BD1:ISO-2), the gated function is put on the global object, writable (guest code can still wrap it)
    // and not configurable (the gate stays underneath any wrapper); XMLHttpRequest's request-making members are replaced on
    // its prototype, and each constructor's prototype names the gated constructor as its `constructor`. A frame the guest
    // creates is cross-origin to this realm (no allow-same-origin), so the guest cannot take an original from it; that
    // frame, and a worker the guest creates in cooperative mode, are realms of their own with the platform's request
    // makers, under the same policy (the residual of backlog S13). If any member the gate needs is missing, the request
    // maker is removed instead: the gate fails closed.
    const GATE_SOURCE: typeof GATE_SOURCE_FILE = 'web-sandbox:request-gate'; // GATE_SOURCE_FILE (violation.ts), typed by it
    const admittedSources: string[] = list();
    for (let i = 0; i < connect.length; i++) {
        if (typeof connect[i] === 'string') append(admittedSources, connect[i]);
    }
    const urlReady = typeof URLConstructor === 'function' && urlHref && urlHost && urlProtocol?.get && urlProtocol.set && urlUsernameTo && urlPasswordTo && urlHashTo;
    const protocolOf = urlProtocol?.get;
    const protocolTo = urlProtocol?.set;
    const parseUrl = (text: string, base?: unknown): URL => construct(URLConstructor, base === undefined ? [text] : [text, base]);
    // Whether the policy's connect-src lists the URL `href`: its exact origin, or `blob:` for a blob: URL.
    const admits = (href: string): boolean => {
        let url: URL;
        try {
            url = parseUrl(href);
        } catch {
            return false;
        }
        const protocol = apply(protocolOf!, url, []) as string;
        const key = protocol === 'blob:' ? protocol : protocol + '//' + (apply(urlHost!, url, []) as string);
        for (let i = 0; i < admittedSources.length; i++) {
            if (admittedSources[i] === key) return true;
        }
        return false;
    };
    // The URL a refusal names, as the engines report it: an http(s) or ws(s) URL without credentials or fragment, and
    // any other by its scheme alone.
    const reportedUrl = (href: string): string => {
        let url: URL;
        try {
            url = parseUrl(href);
        } catch {
            return href;
        }
        const protocol = apply(protocolOf!, url, []) as string;
        if (protocol !== 'https:' && protocol !== 'http:' && protocol !== 'wss:' && protocol !== 'ws:') return apply(slice, protocol, [0, -1]) as string;
        apply(urlUsernameTo!, url, ['']);
        apply(urlPasswordTo!, url, ['']);
        apply(urlHashTo!, url, ['']);
        return apply(urlHref!, url, []) as string;
    };
    const refuse = (href: string) => report(reportedUrl(href), GATE_SOURCE);
    // The text of a URL XMLHttpRequest or WebSocket was given; read once.
    const urlText = (value: unknown): string => {
        if (typeof value === 'symbol') throw construct(TypeErrorConstructor, ['a URL cannot be a Symbol']);
        return StringConstructor(value);
    };
    const baseOfRealm = (): unknown => baseUriOf && doc ? apply(baseUriOf, doc, []) : locationHrefOf && locationFound ? apply(locationHrefOf, locationFound, []) : undefined;
    // A URL text resolved against the base they use; throws a SyntaxError for one that does not parse.
    const resolveText = (text: string): URL => {
        try {
            return parseUrl(text, baseOfRealm());
        } catch {
            throw construct(DOMExceptionConstructor!, ['the URL does not parse', 'SyntaxError']);
        }
    };
    // A URL text resolved against the base they use, or null for a relative one that no base here can resolve (a blob
    // worker's location, `blob:null/…`, has no path to resolve against). Such a text names no address the gate could
    // admit, so XMLHttpRequest and WebSocket refuse it in the gate's words, not by a parse error of the platform's
    // (BD6:NEW-2). A text that is not a URL at all still throws the SyntaxError.
    const resolvedOrRelative = (text: string): URL | null => {
        try {
            return resolveText(text);
        } catch (error) {
            try {
                parseUrl(text, 'https://base.invalid/');
            } catch {
                throw error; // not a relative reference either: the platform's SyntaxError
            }
            return null;
        }
    };
    // The address XMLHttpRequest.open() checks: the resolved URL, or the text as written for a relative one no base resolves.
    const addressOf = (text: string): string => {
        const target = resolvedOrRelative(text);
        return target ? (apply(urlHref!, target, []) as string) : text;
    };
    const refusal = 'refused by the sandbox: the origin is not in its origins.connect';
    // Every copy of `name` on the global object and its prototype chain removed, then `value` put on the global object
    // (nothing for undefined). Throws where a copy that holds `original` stays: the bootstrap ends before any guest code.
    // The global object's own copy is replaced in place where it cannot be deleted (a writable one, which the gate itself
    // leaves).
    const replaceGlobal = (name: string, original: unknown, value: unknown, enumerable: boolean) => {
        for (let owner: object | null = g; owner; owner = protoOf(owner)) {
            if (!getOwn(owner, name)) continue;
            deleteOwn(owner, name);
            const left = getOwn(owner, name);
            if (left && left.value === original && original !== undefined && (owner !== g || value === undefined)) throw construct(TypeErrorConstructor, ['[Sandbox] the request gate could not remove ' + name]);
        }
        if (value !== undefined && !defineOwn(g, name, { value, writable: true, enumerable, configurable: false })) throw construct(TypeErrorConstructor, ['[Sandbox] the request gate could not install ' + name]);
    };
    // A gated constructor in place of `original`: its statics, its prototype (the platform's, whose `constructor` now
    // names the gated one), and its own prototype's chain.
    const adopt = (gated: object, original: { prototype: object }) => {
        const names = namesOf(original);
        for (let i = 0; i < names.length; i++) {
            const name = names[i]!;
            if (name !== 'prototype' && name !== 'length' && name !== 'name') defineOwn(gated, name, getOwn(original, name)!);
        }
        setPrototype(gated, protoOf(original));
        const prototype = original.prototype;
        if (!defineOwn(gated, 'prototype', { value: prototype, writable: false, enumerable: false, configurable: false })) throw construct(TypeErrorConstructor, ['[Sandbox] the request gate could not adopt a prototype']);
        if (!defineOwn(prototype, 'constructor', { value: gated, writable: true, enumerable: false, configurable: false })) throw construct(TypeErrorConstructor, ['[Sandbox] the request gate could not adopt a prototype']);
    };
    const NEW_REQUIRED = "Failed to construct: please use the 'new' operator";

    // fetch: the Request built as fetch() builds it, then again without credentials; checked; handed to the platform.
    if (typeof nativeFetch === 'function' && typeof RequestConstructor === 'function' && keepaliveOf && requestUrlOf && urlReady) {
        const keepalive = keepaliveOf;
        const urlOf = requestUrlOf;
        const omit = setPrototype({ credentials: 'omit' }, null); // no prototype: the init is read member by member
        // keepalive is read from the Request fetch() itself would make: Firefox does not carry it into a Request built
        // from another, so the one sent is checked before it is built.
        const gatedFetch = function fetch(input: unknown, init?: unknown) {
            let request;
            try {
                request = construct(RequestConstructor, init === undefined ? [input] : [input, init]);
            } catch (error) {
                return apply(rejected, PromiseConstructor, [error]);
            }
            const href = apply(urlOf, request, []) as string;
            if (!admits(href)) {
                refuse(href);
                return apply(rejected, PromiseConstructor, [construct(TypeErrorConstructor, ['fetch() ' + refusal])]);
            }
            if (apply(keepalive, request, []) === true) {
                return apply(rejected, PromiseConstructor, [construct(TypeErrorConstructor, ['fetch() with keepalive is not available in the sandbox'])]);
            }
            let sent;
            try {
                sent = construct(RequestConstructor, [request, omit]);
            } catch (error) {
                return apply(rejected, PromiseConstructor, [error]);
            }
            return apply(nativeFetch, g, [sent]);
        };
        replaceGlobal('fetch', nativeFetch, gatedFetch, true);
    } else {
        replaceGlobal('fetch', nativeFetch, undefined, true);
    }

    // XMLHttpRequest: open() checks the URL and hands the platform the resolved URL, or, for a refused one, a placeholder
    // it never sends; send() of a refused request fails as a network error does (asynchronously: loadstart, then
    // readystatechange, error and loadend, with readyState 4 and status 0; a synchronous one throws a NetworkError), and
    // abort() and readyState follow the same states. A record per opened request, by index: [state, URL, async, timer], whose
    // state is `admitted` for a URL the gate admitted. The platform's send() is called for an admitted record only: a request
    // the gate never opened, or opened with a refused URL, never reaches it, whatever a later open() that throws left
    // behind (class A: INHERITED_CONTEXT.cspReporting; a send of the platform's to the placeholder is a check of the host
    // page's inherited policy, which reports it to the page's endpoint).
    const xhrReady = typeof NativeXMLHttpRequest === 'function' && xhrPrototype && typeof xhrOpen === 'function' && typeof xhrSend === 'function'
        && typeof xhrAbort === 'function' && xhrReadyState && xhrWithCredentials && typeof ProgressEventConstructor === 'function'
        && typeof EventConstructor === 'function' && DOMExceptionConstructor && urlReady;
    if (xhrReady) {
        const readyStateOfRequest = xhrReadyState!;
        const openedRequests = construct(WeakMapConstructor, []) as WeakMap<object, unknown[]>;
        const recordOf = (xhr: unknown): unknown[] | undefined => apply(weakGet, openedRequests, [xhr]) as unknown[] | undefined;
        const progressInit = setPrototype({ lengthComputable: false, loaded: 0, total: 0 }, null);
        const fire = (xhr: unknown, type: string) => apply(dispatch, xhr, [type === 'readystatechange' ? construct(EventConstructor, [type]) : construct(ProgressEventConstructor, [type, progressInit])]);
        const settle = (xhr: unknown, record: unknown[], type: string) => {
            record[0] = 'done';
            fire(xhr, 'readystatechange');
            fire(xhr, type);
            fire(xhr, 'loadend');
        };
        const open = function open(this: unknown, method: unknown, url: unknown) {
            apply(readyStateOfRequest, this, []); // the platform's own check that `this` is a request
            const count = arguments.length;
            const href = count >= 2 ? addressOf(urlText(url)) : '';
            const refused = count < 2 || !admits(href);
            const args: unknown[] = list();
            append(args, method);
            if (count >= 2) append(args, refused ? 'about:blank' : href);
            for (let i = 2; i < count; i++) append(args, arguments[i]);
            apply(xhrOpen, this, args);
            // The platform opened it (an open() that throws, the gate's or the platform's, changes neither's state): it
            // replaces the earlier open, and its record says whether the URL the platform now holds is one the gate admitted.
            const earlier = recordOf(this);
            if (earlier) apply(clearTimer, g, [earlier[3]]);
            const record: unknown[] = list();
            append(record, refused ? 'opened' : 'admitted');
            append(record, href);
            append(record, count < 3 || !!arguments[2]);
            append(record, undefined);
            apply(weakSet, openedRequests, [this, record]);
        };
        const sendRequest = function send(this: unknown, body?: unknown) {
            const record = recordOf(this);
            if (record && record[0] === 'admitted') return apply(xhrSend, this, arguments.length === 0 ? [] : [body]);
            if (!record || record[0] !== 'opened') throw construct(DOMExceptionConstructor!, ['send() needs an opened request', 'InvalidStateError']);
            refuse(record[1] as string);
            if (record[2] !== true) {
                record[0] = 'done';
                throw construct(DOMExceptionConstructor!, ['XMLHttpRequest ' + refusal, 'NetworkError']);
            }
            record[0] = 'sending';
            fire(this, 'loadstart');
            const xhr = this;
            record[3] = apply(setTimer, g, [() => {
                if (recordOf(xhr) === record && record[0] === 'sending') settle(xhr, record, 'error');
            }, 0]);
        };
        const abort = function abort(this: unknown) {
            const record = recordOf(this);
            apply(xhrAbort, this, []);
            if (!record || record[0] === 'admitted') return;
            const state = record[0];
            if (state === 'sending') {
                apply(clearTimer, g, [record[3]]);
                settle(this, record, 'abort');
            }
            if (state === 'sending' || state === 'done') record[0] = 'unsent';
        };
        const readyState = function (this: unknown) {
            const value = apply(readyStateOfRequest, this, []);
            const record = recordOf(this);
            const state = record ? record[0] : null;
            return state === 'done' ? 4 : state === 'unsent' ? 0 : value;
        };
        const withCredentialsOf = xhrWithCredentials!;
        const withCredentials = function (this: unknown) {
            return apply(withCredentialsOf, this, []); // false: the platform's setter is never called
        };
        const unchanged = function (this: unknown) {
            apply(withCredentialsOf, this, []); // the platform's check that `this` is a request; the value stays false
        };
        const gatedXMLHttpRequest = function XMLHttpRequest(this: unknown) {
            if (new.target === undefined) throw construct(TypeErrorConstructor, [NEW_REQUIRED]);
            return construct(NativeXMLHttpRequest, [], new.target);
        };
        // Configurable, as the platform's: what replaces or deletes them reaches no original either.
        const MEMBERS: [string, PropertyDescriptor][] = [
            ['open', { value: open, writable: true, enumerable: true, configurable: true }],
            ['send', { value: sendRequest, writable: true, enumerable: true, configurable: true }],
            ['abort', { value: abort, writable: true, enumerable: true, configurable: true }],
            ['readyState', { get: readyState, enumerable: true, configurable: true }],
            ['withCredentials', { get: withCredentials, set: unchanged, enumerable: true, configurable: true }],
        ];
        for (let i = 0; i < MEMBERS.length; i++) {
            if (!defineOwn(xhrPrototype, MEMBERS[i]![0], MEMBERS[i]![1])) throw construct(TypeErrorConstructor, ['[Sandbox] the request gate could not install XMLHttpRequest.' + MEMBERS[i]![0]]);
        }
        adopt(gatedXMLHttpRequest, NativeXMLHttpRequest);
        replaceGlobal('XMLHttpRequest', NativeXMLHttpRequest, gatedXMLHttpRequest, false);
    } else {
        replaceGlobal('XMLHttpRequest', NativeXMLHttpRequest, undefined, false);
    }

    // WebSocket: the URL resolved, an http(s) one taken as its ws(s) form, as the constructor does; checked; the
    // platform's constructor given the resolved URL. Strict mode has no cookie carrier (COOKIE_CARRIERS, cookie-facts.ts;
    // S74): a handshake carries the cookies the browser attaches by site, so there the gate refuses every WebSocket,
    // whatever its list says, and never calls the platform's constructor.
    const socketsRefused = mode === 'strict';
    const socketRefusal = 'refused by the sandbox: strict mode opens no WebSocket';
    if (typeof NativeWebSocket === 'function' && DOMExceptionConstructor && urlReady) {
        const gatedWebSocket = function WebSocket(this: unknown, url: unknown, protocols?: unknown) {
            if (new.target === undefined) throw construct(TypeErrorConstructor, [NEW_REQUIRED]);
            const count = arguments.length;
            if (count === 0 && socketsRefused) throw construct(TypeErrorConstructor, ["Failed to construct 'WebSocket': 1 argument required"]);
            if (count === 0) return construct(NativeWebSocket, [], new.target);
            const text = urlText(url);
            const target = resolvedOrRelative(text);
            if (!target) {
                refuse(text);
                throw construct(DOMExceptionConstructor!, ['WebSocket ' + (socketsRefused ? socketRefusal : refusal), 'SecurityError']);
            }
            const protocol = apply(protocolOf!, target, []);
            if (protocol === 'https:') apply(protocolTo!, target, ['wss:']);
            else if (protocol === 'http:') apply(protocolTo!, target, ['ws:']);
            else if (protocol !== 'wss:' && protocol !== 'ws:') throw construct(DOMExceptionConstructor!, ['a WebSocket URL is ws:, wss:, http: or https:', 'SyntaxError']);
            const href = apply(urlHref!, target, []) as string;
            if (socketsRefused || !admits(href)) {
                refuse(href);
                throw construct(DOMExceptionConstructor!, ['WebSocket ' + (socketsRefused ? socketRefusal : refusal), 'SecurityError']);
            }
            return construct(NativeWebSocket, count < 2 ? [href] : [href, protocols], new.target);
        };
        adopt(gatedWebSocket, NativeWebSocket);
        replaceGlobal('WebSocket', NativeWebSocket, gatedWebSocket, false);
    } else {
        replaceGlobal('WebSocket', NativeWebSocket, undefined, false);
    }
}
