import { inSandboxFiles } from './in-sandbox-files';
import { assertHashableScript, scriptHashSource } from './csp/script-hash';
import { escapeAttribute } from './frame-documents';
import { REFERENCES, VIRTUAL_DOCUMENT_URL, VIRTUAL_ROOT } from './markup-references';

/**
 * Strict mode (backlog S6, S13, S17; ADR-005): guest logic runs only in a worker, and the DOM frame — the
 * "view" — runs exactly one script, the library's own bootstrap, admitted by its SHA-256 hash.
 *
 *   host page
 *   └─ wrapper  (unchanged: frame-src 'none', inert base, no-referrer; frame-documents.ts)
 *      └─ view  srcdoc = CSP <meta> + referrer <meta> + ONE <script> (this file's bootstrap), no guest bytes
 *         └─ worker  new Worker(blob:) spawned by the view: the guest's logic, the bridge, sandboxView
 *
 * Three ports, all MessageChannels created per environment:
 *   logic   host ↔ worker   RPC, LOG, PING/PONG, VIOLATION (source 'logic'), EXECUTE — as in worker mode
 *   view    host ↔ view     VIOLATION (source 'view'), RESIZE, GUEST_ERROR, VIEW_PING/VIEW_PONG
 *   render  view ↔ worker   VIEW_RENDER, VIEW_ACK, VIEW_LISTEN, VIEW_EVENT — the host is not on this path
 * The render port is created by the view and handed to the library's worker prelude, which keeps it in a
 * closure and only ever uses primitives it captured before any guest code ran (A4): guest code cannot post
 * on it, so it cannot get past the flow control below.
 *
 * Three self-contained functions here are stringified (same rules as in-sandbox-script.ts: no module
 * scope, no async/await): inSandboxView (the view's bootstrap), sanitizeRender (the renderer it calls) and
 * inStrictWorker (the worker's prelude). The rest is host-only.
 */

/** The largest html one render may carry, in UTF-16 code units (256 Ki characters; A4). */
export const VIEW_RENDER_MAX_LENGTH = 262144;

/** The longest element id a render may target. */
export const VIEW_TARGET_MAX_LENGTH = 1024;

/** The events sandboxView.on() can subscribe to (ADR-005). */
export const VIEW_EVENT_TYPES = ['click', 'input', 'change', 'submit', 'keydown'] as const;

/** Limits of one event's detail: every string, the ids of the target and its ancestors, the form fields. */
export const VIEW_EVENT_LIMITS = { maxString: 65536, maxIds: 32, maxFields: 1000 } as const;

/** The name of the worker's one-time "the entry ran to its end" marker, called by the line after the entry. */
export const ENTRY_DONE_NAME = '__sandboxEntryRan';

/**
 * Elements the renderer removes, with everything inside them, before any rendered markup is inserted
 * (amendment A1): every nested browsing context and every document-level control. So strict mode renders
 * no nested frame at all, no script of any namespace, no <meta> (refresh, referrer, CSP), no <base>, and
 * no inert subtree (<template>, <noscript>) that could later become live. <link> is handled separately:
 * it stays only as a stylesheet or icon that names a file the view minted.
 */
export const RENDER_REMOVED_ELEMENTS = [
    'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe',
    'script', 'meta', 'base', 'noscript', 'template',
] as const;

export interface RenderRules {
    /** Local names removed with their subtree (RENDER_REMOVED_ELEMENTS). */
    removed: readonly string[];
    /** [element, attribute] pairs that may name a registered file (markup-references.ts, minus <script src>). */
    references: readonly (readonly [string, string])[];
    /** The only rel tokens a kept <link> may have. */
    linkRelations: readonly string[];
    /** The only rel tokens an <a> or <area> keeps. */
    anchorRelations: readonly string[];
    /** Elements that always get referrerpolicy="no-referrer" (A1). */
    referrerElements: readonly string[];
    /** The URL references resolve against, and the root of the files' URL space (markup-references.ts). */
    documentUrl: string;
    virtualRoot: string;
}

export const RENDER_RULES: RenderRules = {
    removed: RENDER_REMOVED_ELEMENTS,
    // derived, not copied: the table markup-references.ts resolves in default mode. Scripts never survive
    // the renderer, so <script src> names nothing here.
    references: REFERENCES.filter(([element]) => element !== 'script'),
    linkRelations: ['stylesheet', 'icon'],
    anchorRelations: ['noopener', 'noreferrer', 'nofollow'],
    referrerElements: ['a', 'area', 'img', 'link'],
    documentUrl: VIRTUAL_DOCUMENT_URL,
    virtualRoot: VIRTUAL_ROOT,
};

/**
 * The renderer (A1, A8), run by the view on a freshly parsed template fragment BEFORE any of it is
 * inserted. Stringified into the view bootstrap; self-contained. It never clones or imports a node (A2):
 * the caller moves the fragment's own nodes into the document, which never runs or even prepares a
 * script (research 15, P6) — and there are none left anyway.
 *
 *   1. every element named in rules.removed goes, with its subtree, whatever its namespace;
 *   2. an HTML element's file reference (rules.references) that names a registered file, resolved like a
 *      browser would against rules.documentUrl, becomes the view's own blob: URL for it (`fileUrl`);
 *   3. a <link> stays only if all its rel tokens are in rules.linkRelations and its href is a URL the
 *      view minted;
 *   4. any attribute whose value contains "blob:" (after removing the tabs and newlines the URL parser
 *      ignores) goes, unless it is a file-reference attribute holding exactly a URL the view minted (A8);
 *   5. ping goes; referrerpolicy, where present, becomes no-referrer, and is set on rules.referrerElements;
 *      rel on <a>/<area> keeps only rules.anchorRelations (A1).
 */
export function sanitizeRender(fragment: DocumentFragment, fileUrl: (path: string) => string | null, isMinted: (url: string) => boolean, rules: RenderRules): void {
    const HTML = 'http://www.w3.org/1999/xhtml';
    const resolve = (value: string): string | null => {
        if (/^[\u0000- ]*$/.test(value)) return null;
        let href: string;
        try {
            href = new URL(value, rules.documentUrl).href;
        } catch {
            return null;
        }
        if (href.indexOf(rules.virtualRoot) !== 0) return null;
        const path = href.slice(rules.virtualRoot.length);
        if (path.indexOf('?') >= 0 || path.indexOf('#') >= 0) return null;
        return fileUrl(path);
    };
    const tokens = (value: string | null) => (value || '').toLowerCase().split(/[\t\n\f\r ]+/).filter((token) => token !== '');
    const isReference = (element: string, attribute: string) => {
        for (let i = 0; i < rules.references.length; i++) {
            if (rules.references[i]![0] === element && rules.references[i]![1] === attribute) return true;
        }
        return false;
    };

    const elements = fragment.querySelectorAll('*');
    for (let i = 0; i < elements.length; i++) {
        const element = elements[i]!;
        const name = element.localName.toLowerCase();
        if (rules.removed.indexOf(name) >= 0) {
            element.remove();
            continue;
        }
        const html = element.namespaceURI === HTML;
        if (html) {
            for (let r = 0; r < rules.references.length; r++) {
                const [tag, attribute] = rules.references[r]!;
                if (tag !== name || !element.hasAttribute(attribute)) continue;
                const url = resolve(element.getAttribute(attribute) || '');
                if (url) element.setAttribute(attribute, url);
            }
        }
        if (name === 'link') {
            const rel = tokens(element.getAttribute('rel'));
            const kept = html && rel.length > 0 && rel.every((token) => rules.linkRelations.indexOf(token) >= 0) && isMinted(element.getAttribute('href') || '');
            if (!kept) {
                element.remove();
                continue;
            }
        }
        const names = element.getAttributeNames();
        for (let a = 0; a < names.length; a++) {
            const attribute = names[a]!;
            const lower = attribute.toLowerCase();
            const value = element.getAttribute(attribute) || '';
            if (lower === 'ping') {
                element.removeAttribute(attribute);
                continue;
            }
            if (/blob:/i.test(value.replace(/[\t\n\r]/g, '')) && !(html && isReference(name, lower) && isMinted(value))) {
                element.removeAttribute(attribute);
                continue;
            }
            if (lower === 'referrerpolicy') element.setAttribute(attribute, 'no-referrer');
        }
        if (rules.referrerElements.indexOf(name) >= 0) element.setAttribute('referrerpolicy', 'no-referrer');
        if ((name === 'a' || name === 'area') && element.hasAttribute('rel')) {
            element.setAttribute('rel', tokens(element.getAttribute('rel')).filter((token) => rules.anchorRelations.indexOf(token) >= 0).join(' '));
        }
    }
}

/** What the view bootstrap is given, as one literal in its (constant) text. */
export interface ViewOptions {
    render: RenderRules;
    maxRender: number;
    maxTarget: number;
    violationLimit: number;
    events: { types: readonly string[]; maxString: number; maxIds: number; maxFields: number };
}

/**
 * The view's bootstrap: the only script the view document has, and the only one its policy admits (by
 * hash). Stringified with its arguments into one constant text per page (viewBootstrapText). Self-contained.
 *
 * Before INIT_VIEW it only listens: violation reports wait in a bounded outbox, and link clicks and form
 * submissions have their default cancelled from the start. It accepts exactly one INIT_VIEW, from the host
 * page (event.source === parent.parent), in a capture listener that stops the event there; any other
 * message is ignored. A copy of this text that ever ran a second time in the same document would return
 * at once (the run counter), and a copy elsewhere would never receive INIT_VIEW (research 15, P1).
 */
export function inSandboxView(installFiles: typeof inSandboxFiles, sanitize: typeof sanitizeRender, options: ViewOptions) {
    const g = globalThis as any;
    const runs = (g.__sandboxViewRuns || 0) + 1;
    g.__sandboxViewRuns = runs;
    if (runs > 1) return;

    let viewPort: MessagePort | null = null;
    let renderPort: MessagePort | null = null;
    let initialised = false;
    const outbox: unknown[] = [];
    const toHost = (frame: unknown) => {
        if (viewPort) viewPort.postMessage(frame);
        else if (outbox.length < options.violationLimit) outbox.push(frame);
    };

    // The view document's own CSP violations (G6): complete and unforgeable, since no guest code runs in this
    // document and the host labels whatever arrives on the view port as source 'view'. Capped like the
    // default bootstrap's (VIOLATION_EVENT_LIMIT).
    let violations = 0;
    addEventListener('securitypolicyviolation', (event: any) => {
        if (!event.isTrusted || violations >= options.violationLimit) return;
        violations++;
        toHost({
            type: 'VIOLATION',
            directive: event.effectiveDirective || event.violatedDirective,
            blockedURI: event.blockedURI,
            sourceFile: event.sourceFile,
            lineNumber: event.lineNumber,
            columnNumber: event.columnNumber,
        });
    }, true);

    // No navigation from rendered markup (G4, A5): the default of every click or auxclick on or inside a link
    // (HTML and SVG <a>, <area>, anything with an href) and of every submit is cancelled. Fragment links are
    // no exception: the view inherits the wrapper's about:blank base, so "#x" names about:blank#x, a navigation.
    const XLINK = 'http://www.w3.org/1999/xlink';
    const insideLink = (node: any) => {
        for (let n = node; n && n.nodeType === 1; n = n.parentNode) {
            if (n.localName === 'a' || n.localName === 'area' || n.hasAttribute('href') || n.hasAttributeNS(XLINK, 'href')) return true;
        }
        return false;
    };
    const cancelLink = (event: Event) => {
        if (insideLink(event.target)) event.preventDefault();
    };
    addEventListener('click', cancelLink, true);
    addEventListener('auxclick', cancelLink, true);
    addEventListener('submit', (event: Event) => event.preventDefault(), true);

    // Events for the worker's sandboxView.on() handlers: only the types it subscribed to (VIEW_LISTEN), only
    // trusted ones (no guest code runs here, but the rule is stated, not assumed), capture-delegated on the
    // window. The detail describes the target and its ancestors' ids, the key, the form's fields — never a
    // URL: no href, src or action is read. Every string is clamped. Link and submit defaults are cancelled
    // above whether or not anyone listens.
    let subscribed: string[] = [];
    const clamp = (value: unknown) => String(value).slice(0, options.events.maxString);
    const forward = (event: any) => {
        if (!event.isTrusted || !renderPort || subscribed.indexOf(event.type) < 0) return;
        let target = event.target;
        if (!target || target.nodeType !== 1) target = document.body;
        if (!target) return;
        const ids: string[] = [];
        for (let n = target; n && n.nodeType === 1 && ids.length < options.events.maxIds; n = n.parentNode) {
            if (n.id) ids.push(clamp(n.id));
        }
        const detail: any = {
            type: event.type,
            ids,
            target: {
                tag: String(target.localName),
                id: clamp(target.id || ''),
                name: clamp(target.getAttribute('name') || ''),
                value: typeof target.value === 'string' ? clamp(target.value) : '',
                checked: target.checked === true,
            },
        };
        if (event.type === 'keydown') detail.key = clamp(event.key || '');
        if (event.type === 'submit' && target.localName === 'form') {
            const fields: [string, string][] = [];
            let data: FormData;
            try {
                data = new FormData(target, event.submitter || undefined);
            } catch {
                data = new FormData(target);
            }
            data.forEach((value, name) => {
                if (typeof value === 'string' && fields.length < options.events.maxFields) fields.push([clamp(name), clamp(value)]);
            });
            detail.form = fields;
        }
        renderPort.postMessage({ type: 'VIEW_EVENT', detail });
    };
    for (let i = 0; i < options.events.types.length; i++) addEventListener(options.events.types[i]!, forward, true);

    let fileUrls = new Map<string, string>();
    let minted = new Set<string>();
    const fileUrl = (path: string) => fileUrls.get(path) || null;
    const isMinted = (url: string) => minted.has(url);

    // template.innerHTML parses into an inert fragment (no script runs, nothing loads); the renderer cleans
    // it; replaceChildren MOVES its nodes into the document (A2) — never a clone or an import.
    const apply = (html: string, into: string | null) => {
        const body = document.body;
        const target = into === null ? body : document.getElementById(into);
        if (!target || !body || (target !== body && !body.contains(target))) return;
        const template = document.createElement('template');
        template.innerHTML = html;
        sanitize(template.content, fileUrl, isMinted, options.render);
        target.replaceChildren(template.content);
    };

    // At most one render applied per animation frame (a timer stands in where frames are throttled), the
    // latest per target; one VIEW_ACK per flush releases the worker's next render (A4).
    let pending: [string | null, string][] = [];
    let scheduled = false;
    const flush = () => {
        const jobs = pending;
        pending = [];
        scheduled = false;
        for (let i = 0; i < jobs.length; i++) apply(jobs[i]![1], jobs[i]![0]);
        if (renderPort) renderPort.postMessage({ type: 'VIEW_ACK' });
    };
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        let ran = false;
        const run = () => {
            if (ran) return;
            ran = true;
            flush();
        };
        requestAnimationFrame(run);
        setTimeout(run, 100);
    };
    const onRender = (event: MessageEvent) => {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'VIEW_LISTEN') {
            subscribed = Array.isArray(data.types) ? data.types.filter((type: unknown) => options.events.types.indexOf(type as string) >= 0) : [];
            return;
        }
        if (data.type !== 'VIEW_RENDER') return;
        const into = data.into;
        const valid = typeof data.html === 'string' && data.html.length <= options.maxRender
            && (into === null || (typeof into === 'string' && into.length > 0 && into.length <= options.maxTarget));
        if (!valid) {
            renderPort!.postMessage({ type: 'VIEW_ACK' }); // refused, but never a stall
            return;
        }
        for (let i = 0; i < pending.length; i++) {
            if (pending[i]![0] === into) {
                pending[i]![1] = data.html;
                schedule();
                return;
            }
        }
        pending.push([into, data.html]);
        schedule();
    };

    // Content auto-sizing (B6), when the host asks for it: the view has the document, so it measures, exactly
    // as the default bootstrap does, and reports on the view port, which no guest code can reach.
    const startAutoResize = () => {
        if (typeof ResizeObserver !== 'function') return;
        let lastHeight = -1;
        const measure = () => {
            const root = document.documentElement;
            if (!root) return;
            const box = Math.ceil(root.getBoundingClientRect().height);
            const height = root.scrollHeight > root.clientHeight ? Math.max(box, root.scrollHeight) : box;
            if (height === lastHeight) return;
            lastHeight = height;
            toHost({ type: 'RESIZE', height });
        };
        const observer = new ResizeObserver(measure);
        observer.observe(document.documentElement);
        if (document.body) observer.observe(document.body);
    };

    addEventListener('message', (event: MessageEvent) => {
        if (initialised || event.source !== parent.parent) return;
        const data = event.data;
        if (!data || data.type !== 'INIT_VIEW' || typeof data.workerSource !== 'string' || event.ports.length !== 2) return;
        event.stopImmediatePropagation();
        initialised = true;
        const logicPort = event.ports[0]!;
        viewPort = event.ports[1]!;
        viewPort.onmessage = (message: MessageEvent) => {
            const m = message.data;
            if (m && m.type === 'VIEW_PING' && typeof m.n === 'number') viewPort!.postMessage({ type: 'VIEW_PONG', n: m.n });
        };
        for (let i = 0; i < outbox.length; i++) viewPort.postMessage(outbox[i]);
        outbox.length = 0;

        // The view's own blob: URLs for the registered files it may show (no JavaScript among them): the
        // only blob: URLs the renderer keeps (A8).
        const files = installFiles(Array.isArray(data.viewFiles) ? data.viewFiles : []);
        fileUrls = new Map();
        minted = new Set();
        const paths = files.list();
        for (let i = 0; i < paths.length; i++) {
            const url = files.url(paths[i]!);
            fileUrls.set(paths[i]!, url);
            minted.add(url);
        }

        const channel = new MessageChannel();
        renderPort = channel.port1;
        renderPort.onmessage = onRender;
        let worker: Worker;
        try {
            worker = new Worker(URL.createObjectURL(new Blob([data.workerSource], { type: 'text/javascript' })));
        } catch (error: any) {
            viewPort.postMessage({ type: 'GUEST_ERROR', message: String((error && error.message) || error) });
            return;
        }
        // Reaches here only for an error the worker did not cancel: one raised while the guest's entry ran
        // (a syntax error, or a throw at its top level). The worker's prelude cancels every later one.
        worker.onerror = (error: ErrorEvent) => {
            viewPort!.postMessage({ type: 'GUEST_ERROR', message: String(error.message || 'the worker failed') });
        };
        worker.postMessage({ type: 'INIT_WORKER' }, [logicPort, channel.port2]);

        if (typeof data.html === 'string' && data.html !== '') apply(data.html, null);
        if (data.autoResize === true) startAutoResize();
    }, true);
}

/**
 * The worker's prelude in strict mode, after the comms script and sandboxFiles, before the guest's entry.
 * Stringified; self-contained.
 *
 * Hardening before any guest code (A7): no Worker or SharedWorker (a nested worker would be admitted by
 * worker-src blob:, research 15 P3), no WebAssembly unless scriptUnsafe (WebKit compiles it without
 * 'unsafe-eval', P3), and no URL.createObjectURL — the files' URLs are minted before this runs, and a URL
 * guest code minted could otherwise name unregistered media to the view through CSS (A8). RTCPeerConnection
 * is never there in a worker, and the comms script deletes it anyway.
 *
 * The render port (A4): taken from the one trusted INIT_WORKER message by a capture listener registered
 * before guest code, which stops every trusted message on the global (there is no other: only the view
 * posts to this worker), so guest listeners never see it. Every operation on the port and on the message
 * goes through primitives captured here, called with a captured Reflect.apply, so patching
 * MessagePort.prototype, MessageEvent.prototype or Function.prototype cannot reach the port. Guest code
 * gets only `sandboxView.render`, which keeps the latest html per target and posts one render at a time,
 * the next only after the view's VIEW_ACK, and `sandboxView.on`, which registers handlers for the events
 * the view forwards (the port itself is never handed to a handler).
 */
export function inStrictWorker(comms: { attach(port: MessagePort): void }, options: { scriptUnsafe: boolean; maxRender: number; maxTarget: number; entryDoneName: string; eventTypes: readonly string[] }) {
    const g = globalThis as any;
    const apply = Reflect.apply;
    const addListener = EventTarget.prototype.addEventListener;
    const dataOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!.get!;
    const portsOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'ports')!.get!;
    const stopImmediate = Event.prototype.stopImmediatePropagation;
    const cancel = Event.prototype.preventDefault;
    const post = MessagePort.prototype.postMessage;
    const startPort = MessagePort.prototype.start;
    const sandboxConsole = console;
    const reportError = typeof g.reportError === 'function' ? g.reportError : null;

    const remove = (owner: any, name: string) => {
        if (owner && name in owner) Reflect.deleteProperty(owner, name);
    };
    remove(g, 'Worker');
    remove(g, 'SharedWorker');
    if (!options.scriptUnsafe) remove(g, 'WebAssembly');
    remove(g.URL, 'createObjectURL');
    remove(g.webkitURL, 'createObjectURL');

    // ---- render flow control ----
    let renderPort: MessagePort | null = null;
    let inFlight = false;
    const targets: (string | null)[] = [];
    const htmls: string[] = [];
    const sendNext = () => {
        if (!renderPort || inFlight || targets.length === 0) return;
        const into = targets[0];
        const html = htmls[0];
        for (let i = 1; i < targets.length; i++) {
            targets[i - 1] = targets[i]!;
            htmls[i - 1] = htmls[i]!;
        }
        targets.length = targets.length - 1;
        htmls.length = htmls.length - 1;
        inFlight = true;
        apply(post, renderPort, [{ type: 'VIEW_RENDER', html, into }]);
    };
    const render = (html: unknown, into?: unknown) => {
        if (typeof html !== 'string') throw new TypeError('sandboxView.render: html must be a string');
        if (html.length > options.maxRender) throw new RangeError('sandboxView.render: html is longer than ' + options.maxRender + ' characters');
        const target = into === undefined || into === null ? null : into;
        if (target !== null && (typeof target !== 'string' || target.length === 0 || target.length > options.maxTarget)) {
            throw new TypeError('sandboxView.render: into must be an element id or null');
        }
        for (let i = 0; i < targets.length; i++) {
            if (targets[i] === target) {
                htmls[i] = html;
                return;
            }
        }
        targets[targets.length] = target as string | null;
        htmls[htmls.length] = html;
        sendNext();
    };
    // ---- events: sandboxView.on(type, id | null, handler) → off ----
    // The view forwards only the types some handler listens to (VIEW_LISTEN, sent whenever that set changes).
    // A handler with an id runs for events on that element or inside it (the detail's ids); with null, for all.
    const isEventType = (type: unknown) => {
        for (let i = 0; i < options.eventTypes.length; i++) if (options.eventTypes[i] === type) return true;
        return false;
    };
    type Handler = { type: string; id: string | null; handler: (detail: unknown) => void; active: boolean };
    const handlers: Handler[] = [];
    let listened = '';
    const syncListen = () => {
        if (!renderPort) return;
        const types: string[] = [];
        let key = '';
        for (let t = 0; t < options.eventTypes.length; t++) {
            for (let h = 0; h < handlers.length; h++) {
                if (handlers[h]!.type === options.eventTypes[t]) {
                    types[types.length] = options.eventTypes[t]!;
                    key += options.eventTypes[t] + ',';
                    break;
                }
            }
        }
        if (key === listened) return;
        listened = key;
        apply(post, renderPort, [{ type: 'VIEW_LISTEN', types }]);
    };
    const on = (type: unknown, id: unknown, handler: unknown) => {
        if (!isEventType(type)) throw new TypeError('sandboxView.on: type must be one of ' + options.eventTypes.join(', '));
        const target = id === undefined || id === null ? null : id;
        if (target !== null && (typeof target !== 'string' || target.length === 0 || target.length > options.maxTarget)) {
            throw new TypeError('sandboxView.on: id must be an element id or null');
        }
        if (typeof handler !== 'function') throw new TypeError('sandboxView.on: handler must be a function');
        const entry: Handler = { type: type as string, id: target as string | null, handler: handler as (detail: unknown) => void, active: true };
        handlers[handlers.length] = entry;
        syncListen();
        return () => {
            if (!entry.active) return;
            entry.active = false;
            let kept = 0;
            for (let i = 0; i < handlers.length; i++) if (handlers[i] !== entry) handlers[kept++] = handlers[i]!;
            handlers.length = kept;
            syncListen();
        };
    };
    const dispatch = (detail: any) => {
        if (!detail || typeof detail !== 'object' || !isEventType(detail.type)) return;
        const ids = detail.ids;
        const current: Handler[] = [];
        for (let i = 0; i < handlers.length; i++) current[i] = handlers[i]!;
        for (let i = 0; i < current.length; i++) {
            const entry = current[i]!;
            if (!entry.active || entry.type !== detail.type) continue;
            if (entry.id !== null) {
                let found = false;
                for (let k = 0; ids && k < ids.length; k++) if (ids[k] === entry.id) found = true;
                if (!found) continue;
            }
            try {
                entry.handler(detail);
            } catch (error) {
                // reported like any uncaught error (logged by the listener below), without stopping the others
                if (reportError) apply(reportError, g, [error]);
                else sandboxConsole.error('Uncaught ' + String(error));
            }
        }
    };

    const onRenderMessage = (event: MessageEvent) => {
        const data = apply(dataOf, event, []);
        if (!data || typeof data !== 'object') return;
        if (data.type === 'VIEW_ACK') {
            inFlight = false;
            sendNext();
            return;
        }
        if (data.type === 'VIEW_EVENT') dispatch(data.detail);
    };
    g.sandboxView = Object.freeze({ render, on });

    // ---- the one INIT_WORKER ----
    let initialised = false;
    apply(addListener, g, ['message', (event: MessageEvent) => {
        if (!event.isTrusted) return; // isTrusted is an own, unforgeable property
        apply(stopImmediate, event, []);
        if (initialised) return;
        const data = apply(dataOf, event, []);
        if (!data || data.type !== 'INIT_WORKER') return;
        const ports = apply(portsOf, event, []);
        if (!ports || ports.length !== 2) return;
        initialised = true;
        renderPort = ports[1];
        apply(addListener, renderPort, ['message', onRenderMessage]);
        apply(startPort, renderPort, []);
        comms.attach(ports[0]);
        syncListen();
        sendNext();
    }, true]);

    // ---- entry failure ----
    // An uncaught error while the entry runs (before the line after it calls the marker) is left alone: it
    // reaches the Worker object in the view, which reports GUEST_ERROR, and the host ends the sandbox. Every
    // later uncaught error is cancelled here and logged, so it never ends the sandbox.
    let entryRan = false;
    apply(addListener, g, ['error', (event: ErrorEvent) => {
        if (!entryRan) return;
        apply(cancel, event, []);
        sandboxConsole.error('Uncaught ' + String(event.message));
    }, true]);
    Object.defineProperty(g, options.entryDoneName, { value: () => { entryRan = true; } });
}

// ---- host side ---------------------------------------------------------------------------------

/** The literal the view bootstrap is given (in its text). */
export const VIEW_OPTIONS: ViewOptions = {
    render: RENDER_RULES,
    maxRender: VIEW_RENDER_MAX_LENGTH,
    maxTarget: VIEW_TARGET_MAX_LENGTH,
    violationLimit: 100, // VIOLATION_EVENT_LIMIT (violation.ts); a test keeps them equal
    events: { types: VIEW_EVENT_TYPES, ...VIEW_EVENT_LIMITS },
};

let cachedText: string | null = null;
let cachedHash: string | null = null;

/**
 * The view bootstrap's text: constant for this page (it is the text of library functions), built once.
 * Throws if it could not be hashed as written (A3): a CR or NUL, or anything that ends a script element.
 */
export function viewBootstrapText(): string {
    if (cachedText !== null) return cachedText;
    const text = `(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${JSON.stringify(VIEW_OPTIONS).replaceAll('<', '\\u003c')});`;
    assertHashableScript(text);
    cachedText = text;
    return text;
}

/** The hash-source of the view bootstrap, computed once per page (script-hash.ts). */
export function viewBootstrapHash(): string {
    if (cachedHash === null) cachedHash = scriptHashSource(viewBootstrapText());
    return cachedHash;
}

/**
 * The view document: the policy, the inherited referrer policy restated, the bootstrap, and an empty
 * body. No guest byte is ever part of it: rendered markup arrives later, through the renderer.
 */
export function buildViewDocument(csp: string, bootstrap: string): string {
    return '<!DOCTYPE html><html><head>'
        + `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`
        + '<meta name="referrer" content="no-referrer">'
        + `<script>${bootstrap}</script>`
        + '</head><body></body></html>';
}
