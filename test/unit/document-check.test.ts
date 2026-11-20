import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The check of the served file (design 03, "The check of the file"; design 05, row 3.3; src/lib/document-check.ts), in
 * the default build: before sealed mode's first frame of a registration the element requests `documentUrl` itself, and
 * each finding ends the build with its own reason before anything is framed; where the answer cannot be read the build
 * goes on; an answer is kept for the registration, a request that was not answered is not.
 *
 * The unit environment has no `fetch` (test/unit/jsdom-environment.ts), so this file installs one before the library's
 * modules are evaluated (the check takes the platform's `fetch` once, then): a stand-in whose answers each test sets.
 */

interface Served {
    readonly status?: number;
    readonly type?: string | null;
    readonly headers?: Record<string, string>;
    readonly body?: string;
}

const server = vi.hoisted(() => {
    const state = {
        answer: null as null | ((url: string) => Promise<Response>),
        requests: [] as { url: string; init: RequestInit | undefined }[],
    };
    const stand = async (input: unknown, init?: RequestInit) => {
        state.requests.push({ url: String(input), init });
        if (!state.answer) throw new TypeError('Failed to fetch');
        return state.answer(String(input));
    };
    Object.defineProperty(globalThis, 'fetch', { value: stand, writable: true, configurable: true });
    return state;
});

const { defineWebSandbox } = await import('@src/host');
const { servedDocument } = await import('../../scripts/served-document');
const check = await import('@src/lib/document-check');
const { sealedDocumentDigest, documentDigest } = await import('@src/lib/document-digest');
const { reasonText } = await import('@src/lib/reasons');
const { registeredDocumentUrl } = await import('@src/lib/document-url');

const FILE = servedDocument();
const respond = ({ status = 200, type = 'text/html; charset=utf-8', headers = {}, body = FILE.text }: Served = {}) => {
    const all = new Headers(headers);
    if (type !== null) all.set('content-type', type);
    return new Response(status === 204 ? null : body, { status, headers: all });
};
const serve = (served: Served = {}) => {
    server.answer = async () => respond(served);
};
// The answer of a check that has not come yet: the test lets it go with the returned function.
const held = (served: Served = {}) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    server.answer = async () => {
        await gate;
        return respond(served);
    };
    return release;
};
const settled = () => new Promise(resolve => setTimeout(resolve, 0));
const until = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i++) await settled();
};

const APP = { html: '<p>one</p>', entry: 'app.js', files: { 'app.js': 'bridge.expose("ping", () => "pong");' } };

defineWebSandbox({ documentUrl: '/sealed-document.html' });
const URL_OF_FILE = registeredDocumentUrl()!;

beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
beforeEach(() => {
    server.requests.length = 0;
});
afterEach(() => {
    document.body.replaceChildren();
});

/** A new element, inserted and started; its terminations recorded. */
function started(): { el: any; ended: string[] } {
    const el = document.createElement('web-sandbox') as any;
    const ended: string[] = [];
    el.addEventListener('terminated', (event: CustomEvent) => ended.push(event.detail.reason));
    document.body.appendChild(el);
    el.start(APP);
    return { el, ended };
}
const frameOf = (el: any): HTMLIFrameElement | null => el.shadowRoot.querySelector('iframe');

describe('the digest: one generation for every loader', () => {
    it("the digest vitest's loader gave the library is the one of the file the build writes (scripts/served-document.ts)", () => {
        expect(sealedDocumentDigest()).toBe(FILE.digest);
        expect(documentDigest(new TextEncoder().encode(FILE.text))).toBe(FILE.digest);
    });

    it('the bundle carries the digest and none of the file: no module of the default build imports the generator', () => {
        const source = readFileSync(path.resolve(import.meta.dirname, '../../src/lib/document-digest.ts'), 'utf8');
        expect(source).toContain('declare const __WEB_SANDBOX_DOCUMENT_DIGEST__');
        expect(source).not.toMatch(/from '\.\/sealed-document'/);
        expect(readFileSync(path.resolve(import.meta.dirname, '../../src/lib/document-check.ts'), 'utf8')).not.toMatch(/from '\.\/sealed-document'/);
    });
});

describe('what the check finds in an answer (documentFinding)', () => {
    const finding = (served: Served) => {
        const response = respond(served);
        return check.documentFinding({ status: response.status, header: name => response.headers.get(name), bytes: async () => new Uint8Array(await response.arrayBuffer()) }, FILE.digest);
    };
    const changed = reasonText('documentChanged');

    it('the library\'s file, as text/html with any parameter, and with the headers it may carry: no finding', async () => {
        expect(await finding({})).toBeNull();
        expect(await finding({ type: 'TEXT/HTML' })).toBeNull();
        // under a host page's Cross-Origin-Embedder-Policy: require-corp, Firefox and WebKit need one of these on the file
        expect(await finding({ headers: { 'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'permissions-policy': 'camera=()' } })).toBeNull();
    });

    it('no file: a status that is not 2xx, or a type that is not HTML (none included)', async () => {
        const status = reasonText('documentMissing');
        const type = reasonText('documentNotHtml');
        expect(await finding({ status: 404 })).toBe(status);
        expect(await finding({ status: 500, body: 'oops' })).toBe(status);
        expect(await finding({ type: 'text/plain' })).toBe(type);
        expect(await finding({ type: 'application/octet-stream' })).toBe(type);
        expect(await finding({ type: null })).toBe(type);
    });

    it("other bytes: a dev server's client ahead of the policy, a minified copy, no guard, a view without its sandbox, another page, another version", async () => {
        const text = FILE.text;
        const variants = {
            devClient: text.replace('<head>', '<head><script type="module" src="/@vite/client"></script>'),
            minified: text.replaceAll('; ', ';'),
            noGuard: text.replace(/<script>[^<]*<\/script>/, ''),
            noSandbox: text.replace(/<iframe sandbox="[^"]*"/, '<iframe'),
            otherPage: '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
            otherVersion: text.replace('</html>', '</html><!-- 0.9 -->'),
            oneByte: text.slice(0, -1),
        };
        for (const [name, body] of Object.entries(variants)) {
            expect(body, name).not.toBe(text);
            expect(await finding({ body }), name).toBe(changed);
        }
    });

    it('each refused header, by its name; frame-ancestors in either policy header first', async () => {
        expect(await finding({ headers: { 'x-frame-options': 'SAMEORIGIN' } })).toBe(reasonText('documentFrameOptions'));
        expect(await finding({ headers: { 'content-security-policy': "default-src 'self'" } })).toBe(reasonText('documentCsp'));
        expect(await finding({ headers: { 'content-security-policy-report-only': "default-src 'self'; report-uri /r" } })).toBe(reasonText('documentCspReportOnly'));
        expect(await finding({ headers: { 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" } })).toBe(reasonText('documentFrameAncestors'));
        expect(await finding({ headers: { 'content-security-policy-report-only': "script-src 'none', FRAME-ANCESTORS 'none'" } })).toBe(reasonText('documentFrameAncestors'));
        // a directive's value that names frame-ancestors is not the directive
        expect(await finding({ headers: { 'content-security-policy': "report-uri /frame-ancestors" } })).toBe(reasonText('documentCsp'));
    });

    it('the order: the file missing, then its bytes, then its headers (a fallback page with the site\'s policy is another page)', async () => {
        expect(await finding({ status: 404, headers: { 'content-security-policy': "default-src 'self'" } })).toBe(reasonText('documentMissing'));
        expect(await finding({ body: '<p>app</p>', headers: { 'content-security-policy': "default-src 'self'" } })).toBe(changed);
    });

    it('REFUSED_DOCUMENT_HEADERS: each row has its own reason, and a test above names it', () => {
        const reasons = Object.values(check.REFUSED_DOCUMENT_HEADERS).map(row => row.reason);
        expect(new Set(reasons).size).toBe(reasons.length);
        expect(Object.keys(check.REFUSED_DOCUMENT_HEADERS).sort()).toEqual(['content-security-policy', 'content-security-policy-report-only', 'x-frame-options']);
    });
});

describe('the element: the check before the first frame, its answer kept for the registration', () => {
    // In order: each test reads and leaves the registration's kept answer as the module keeps it.
    it('a request that is not answered (a network failure) is no check: the build frames the file; the next build asks again', async () => {
        server.answer = null;
        const { el, ended } = started();
        expect(frameOf(el)).toBeNull(); // nothing is framed before the check answered
        expect(el.state).toBe('loading');
        await until(() => frameOf(el) !== null);
        expect(frameOf(el)!.getAttribute('src')).toBe(URL_OF_FILE);
        expect(ended).toEqual([]);
        expect(check.keptDocumentCheck(URL_OF_FILE)).toBeUndefined();
        el.reset();
        expect(frameOf(el)).toBeNull();
        await until(() => frameOf(el) !== null);
        expect(server.requests).toHaveLength(2);
    });

    it('the request: documentUrl, without credentials, referrer or a header of the page\'s, with the platform\'s fetch as it was when the library loaded', async () => {
        const wrapped = globalThis.fetch;
        const wrapper = vi.fn(() => Promise.reject(new TypeError('a wrapper of the page')));
        (globalThis as any).fetch = wrapper; // installed after the library: never on the check's path
        try {
            server.answer = null;
            const { el } = started();
            await until(() => frameOf(el) !== null);
            expect(wrapper).not.toHaveBeenCalled();
        } finally {
            (globalThis as any).fetch = wrapped;
        }
        const request = server.requests[0]!;
        expect(request.url).toBe(URL_OF_FILE);
        expect(request.init).toEqual({ method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', cache: 'default', headers: { accept: 'text/html' } });
    });

    it('terminate(), reset() and removal during the wait: the late answer reaches no build, and is kept for the registration', async () => {
        const release = held({ body: '<p>not the file</p>' });
        const { el, ended } = started();
        el.terminate('stop');
        expect(el.state).toBe('terminated');
        expect(ended).toEqual(['stop']);
        const other = started();
        expect(frameOf(other.el)).toBeNull();
        other.el.remove(); // removal during the wait: idle, nothing dispatched
        expect(other.el.state).toBe('idle');
        const third = started();
        third.el.reset(); // reset during the wait: a new build, which waits for the same request
        expect(server.requests).toHaveLength(1); // one request for every build that waits at once
        release();
        await until(() => third.el.state === 'terminated');
        expect(third.ended).toEqual([reasonText('documentChanged')]);
        expect(ended).toEqual(['stop']); // the terminated build heard nothing more
        expect(other.ended).toEqual([]);
        expect(other.el.state).toBe('idle');
        expect(frameOf(third.el)).toBeNull(); // nothing was framed
        expect(check.keptDocumentCheck(URL_OF_FILE)).toEqual({ finding: reasonText('documentChanged') });
    });

    it('a finding is kept for the registration: every later build is refused with it at once, with no request', async () => {
        serve(); // the server is fixed now; the page has not loaded again
        const { el, ended } = started();
        expect(el.state).toBe('terminated');
        expect(frameOf(el)).toBeNull();
        await settled(); // a refused build's 'terminated' comes in a task (R1:R3-2)
        expect(ended).toEqual([reasonText('documentChanged')]);
        expect(server.requests).toHaveLength(0);
    });
});
