import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The check of the served file (design 03, "The check of the file") where `documentUrl` is on the host page's own origin
 * off http(s) (design 05, row 3.10): an app shell's standard scheme, as Electron's `app://bundle` (research 34). There
 * the host page's `fetch` of the file may be refused (a browser's `file:` page on Chromium and WebKit refuses it; an app
 * shell's scheme answers only where the shell registered it for `fetch`) or answered (Electron's `file:` and its
 * `app:` with `supportFetchAPI`, research 34). Where it is refused there is no check: the build frames the file, and the
 * view's own announcement and gates stand behind it; where it is answered, the check is the one of an http(s) URL.
 *
 * The page's origin is the app shell's: `self.origin` is set before the library is evaluated, as the page reads it there,
 * and the platform's `fetch` is a stand-in whose answers each test sets (test/unit/document-check.test.ts).
 */

const OWN_ORIGIN = 'app://bundle';

const server = vi.hoisted(() => {
    const state = {
        answer: null as null | ((url: string) => Promise<Response>),
        requests: [] as string[],
    };
    const stand = async (input: unknown) => {
        state.requests.push(String(input));
        if (!state.answer) throw new TypeError('Failed to fetch'); // as a browser refuses a request of a scheme it does not fetch
        return state.answer(String(input));
    };
    Object.defineProperty(globalThis, 'fetch', { value: stand, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'origin', { value: 'app://bundle', writable: true, configurable: true });
    return state;
});

const { defineWebSandbox } = await import('@src/host');
const { servedDocument } = await import('../../scripts/served-document');
const check = await import('@src/lib/document-check');
const { reasonText } = await import('@src/lib/reasons');
const { registeredDocumentUrl } = await import('@src/lib/document-url');

const FILE = servedDocument();
const serve = (body: string) => {
    server.answer = async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
};
const settled = () => new Promise(resolve => setTimeout(resolve, 0));
const until = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i++) await settled();
};

const APP = { html: '<p>one</p>', entry: 'app.js', files: { 'app.js': 'bridge.expose("ping", () => "pong");' } };

defineWebSandbox({ documentUrl: `${OWN_ORIGIN}/static/sealed-document.html` });
const URL_OF_FILE = registeredDocumentUrl()!;

beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
beforeEach(() => {
    server.requests.length = 0;
    document.body.replaceChildren();
});

function started(): { el: any; ended: string[] } {
    const el = document.createElement('web-sandbox') as any;
    const ended: string[] = [];
    el.addEventListener('terminated', (event: CustomEvent) => ended.push(event.detail.reason));
    document.body.appendChild(el);
    el.start(APP);
    return { el, ended };
}
const frameOf = (el: any): HTMLIFrameElement | null => el.shadowRoot.querySelector('iframe');

describe("the check of the file on the host page's own scheme", () => {
    // In order: each test reads and leaves the registration's kept answer as the module keeps it.
    it("the page's own origin admits a documentUrl on its scheme, and the check is asked of it", () => {
        expect(self.origin).toBe(OWN_ORIGIN);
        expect(URL_OF_FILE).toBe('app://bundle/static/sealed-document.html');
        expect(check.canCheckDocument()).toBe(true);
    });

    it('a refused request is no check: the build frames the file at once it is refused, and the next build asks again', async () => {
        server.answer = null;
        const { el, ended } = started();
        expect(frameOf(el)).toBeNull(); // nothing is framed before the check answered
        await until(() => frameOf(el) !== null);
        expect(frameOf(el)!.getAttribute('src')).toBe(URL_OF_FILE);
        expect(ended).toEqual([]);
        expect(check.keptDocumentCheck(URL_OF_FILE)).toBeUndefined();
        el.reset();
        await until(() => frameOf(el) !== null);
        expect(server.requests).toEqual([URL_OF_FILE, URL_OF_FILE]);
    });

    it("an answer is checked as an http(s) one: other bytes end the build with the reason before anything is framed, and the finding is kept", async () => {
        serve(FILE.text.replace('<head>', '<head><script src="/@vite/client"></script>'));
        const first = started();
        await until(() => first.ended.length > 0);
        expect(first.ended).toEqual([reasonText('documentChanged')]);
        expect(frameOf(first.el)).toBeNull();
        expect(check.keptDocumentCheck(URL_OF_FILE)).toEqual({ finding: reasonText('documentChanged') });
        serve(FILE.text); // the page has not loaded again: the finding stands
        const second = started();
        await settled();
        expect(second.ended).toEqual([reasonText('documentChanged')]);
        expect(server.requests).toEqual([URL_OF_FILE]);
    });
});
