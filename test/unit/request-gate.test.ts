import { describe, it, expect, beforeAll } from 'vitest';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { connectSources } from '@src/lib/csp/csp-generator';
import { parseOrigins } from '@src/lib/csp/origins';
import { GATE_SOURCE_FILE } from '@src/lib/violation';
import { SyntaxKind, tokenize, type Token } from '../../scripts/js-tokens';
import { createGateHarness } from './request-gate-harness';

/**
 * The request gate of the guest bootstrap (in-sandbox-script.ts; S74): the URL check as one table of cases, what a refused
 * request does and reports, the credentials it never sends, and that the platform's originals cannot be reached from the
 * realm afterwards, at run time (jsdom) and in the text (the scan below). The browsers decide what the gate's refusals
 * look like to a guest on each engine: test/e2e/request-gate.spec.ts.
 *
 * One bootstrap runs in this file's realm (the gate is not configurable on the global object), in worker mode's form,
 * where a listed `wss://` origin admits a WebSocket, over stand-ins installed as the platform's fetch, XMLHttpRequest and
 * WebSocket before it captures them. A copy of the stand-in fetch also sits on the global object's prototype, where a
 * worker's platform keeps it (BD1:ISO-2). Strict mode's gate, which refuses every WebSocket: request-gate-strict.test.ts.
 */
// What the policy of a build with these `origins.connect` and a registered file writes into connect-src: the gate's list.
const CONNECT = connectSources({
    origins: parseOrigins({ connect: ['https://api.example', 'https://api.example:8443', 'wss://api.example', 'http://localhost:5173'] }, 'worker', () => {}),
    fileKinds: new Set(['connect']),
    scriptUnsafe: false,
});

const gate = createGateHarness();
const { fetched, opened, sent, sockets, credentialsSet, platformFetch, PlatformXMLHttpRequest, PlatformWebSocket, PLATFORM_MEMBERS, prototypeOfGlobal, reports, clear } = gate;
const g = globalThis as any;

beforeAll(() => gate.install(CONNECT, { mode: 'worker' }));

describe('the list is the policy\'s: the connect-src sources, exactly', () => {
    it('the gate is given what the policy writes into connect-src', () => {
        expect(CONNECT).toEqual(['https://api.example', 'https://api.example:8443', 'wss://api.example', 'http://localhost:5173', 'blob:']);
    });
});

/**
 * The URL check, one table: each URL as fetch() and XMLHttpRequest send it (`request`), and as `new WebSocket()` takes
 * it, an http(s) URL as its ws(s) form (`socket`): admitted (true), refused (the blockedURI the gate reports), or a
 * SyntaxError for a scheme a WebSocket does not take.
 */
const CASES: readonly { url: string; request: true | string; socket: true | 'syntax' | string }[] = [
    { url: 'https://api.example/x', request: true, socket: true },
    { url: 'https://API.example/x?q#f', request: true, socket: true },
    { url: 'https://api.example:443/x', request: true, socket: true },
    { url: 'https://api.example:8443/x', request: true, socket: 'wss://api.example:8443/x' },
    { url: 'wss://api.example/x', request: true, socket: true },
    { url: 'https://api.example:8444/x', request: 'https://api.example:8444/x', socket: 'wss://api.example:8444/x' },
    { url: 'http://api.example/x', request: 'http://api.example/x', socket: 'ws://api.example/x' },
    { url: 'ws://api.example/x', request: 'ws://api.example/x', socket: 'ws://api.example/x' },
    { url: 'https://sub.api.example/x', request: 'https://sub.api.example/x', socket: 'wss://sub.api.example/x' },
    { url: 'https://api.example.evil/x', request: 'https://api.example.evil/x', socket: 'wss://api.example.evil/x' },
    { url: 'https://api.example./x', request: 'https://api.example./x', socket: 'wss://api.example./x' },
    { url: 'https://user:pw@evil.example/p?q=1#frag', request: 'https://evil.example/p?q=1', socket: 'wss://evil.example/p?q=1' },
    { url: 'http://localhost:5173/x', request: true, socket: 'ws://localhost:5173/x' },
    { url: 'https://localhost:5173/x', request: 'https://localhost:5173/x', socket: 'wss://localhost:5173/x' },
    { url: 'http://127.0.0.1:5173/x', request: 'http://127.0.0.1:5173/x', socket: 'ws://127.0.0.1:5173/x' },
    { url: 'http://localhost:5174/x', request: 'http://localhost:5174/x', socket: 'ws://localhost:5174/x' },
    { url: 'blob:https://api.example/0b3c', request: true, socket: 'syntax' },
    { url: 'data:text/plain,x', request: 'data', socket: 'syntax' },
    { url: 'about:blank', request: 'about', socket: 'syntax' },
];
const reportOf = (blockedURI: string) => [{ type: 'VIOLATION', directive: 'connect-src', blockedURI, sourceFile: GATE_SOURCE_FILE }];

describe('the URL check: one table, for fetch(), XMLHttpRequest and WebSocket', () => {
    it.each(CASES)('$url', async ({ url, request, socket }) => {
        // fetch(): a URL with credentials is the Request constructor's to refuse (a TypeError; nothing sent or reported)
        clear();
        const withCredentials = url.includes('@');
        const result = await fetch(url).then(() => 'reached', (error: Error) => `${error.name}: ${error.message}`);
        if (request === true) {
            expect(result).toBe('reached');
            expect(fetched.map(entry => entry.url)).toEqual([new Request(url).url]);
        } else {
            expect(result).toMatch(withCredentials ? /^TypeError: / : /^TypeError: fetch\(\) refused by the sandbox: the origin is not in its origins\.connect$/);
            expect(fetched).toEqual([]);
            expect(reports()).toEqual(withCredentials ? [] : reportOf(request));
        }

        clear();
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url);
        xhr.send();
        if (request === true) {
            expect(opened).toEqual([new URL(url).href]);
            expect(sent).toEqual([new URL(url).href]);
            expect(reports()).toEqual([]);
        } else {
            expect(opened).toEqual(['about:blank']); // a placeholder the platform is never asked to send
            expect(sent).toEqual([]);
            expect(reports()).toEqual(reportOf(request));
        }

        clear();
        let made: string;
        try {
            new WebSocket(url);
            made = 'made';
        } catch (error) {
            made = (error as Error).name;
        }
        if (socket === true) {
            expect(made).toBe('made');
            expect(sockets).toHaveLength(1);
        } else {
            expect(made).toBe(socket === 'syntax' ? 'SyntaxError' : 'SecurityError');
            expect(sockets).toEqual([]);
            expect(reports()).toEqual(socket === 'syntax' ? [] : reportOf(socket));
        }
    });
});

describe('a refused XMLHttpRequest fails as a network error does', () => {
    it('asynchronous: loadstart from send(), then readystatechange (4), error and loadend, status 0; a second send() is refused', async () => {
        clear();
        const xhr = new XMLHttpRequest();
        const seen: string[] = [];
        for (const type of ['readystatechange', 'loadstart', 'error', 'load', 'loadend']) xhr.addEventListener(type, () => seen.push(`${type}:${xhr.readyState}`));
        xhr.open('GET', 'https://evil.example/a');
        expect(xhr.readyState).toBe(1);
        xhr.send();
        expect(seen).toEqual(['loadstart:1']);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(seen).toEqual(['loadstart:1', 'readystatechange:4', 'error:4', 'loadend:4']);
        expect(() => xhr.send()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
        expect(sent).toEqual([]);
    });

    it('synchronous: send() throws a NetworkError, readyState 4; abort() then reads 0', () => {
        clear();
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'https://evil.example/s', false);
        expect(() => xhr.send()).toThrow(expect.objectContaining({ name: 'NetworkError' }));
        expect(xhr.readyState).toBe(4);
        xhr.abort();
        expect(xhr.readyState).toBe(0);
        expect(reports()).toHaveLength(1);
    });

    it('abort() of a refused request in flight: readystatechange, abort and loadend, then readyState 0, and no error later', async () => {
        clear();
        const xhr = new XMLHttpRequest();
        const seen: string[] = [];
        for (const type of ['readystatechange', 'error', 'abort', 'loadend']) xhr.addEventListener(type, () => seen.push(type));
        xhr.open('GET', 'https://evil.example/b');
        xhr.send();
        xhr.abort();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(seen).toEqual(['readystatechange', 'abort', 'loadend']);
        expect(xhr.readyState).toBe(0);
    });

    it('open() again with an admitted URL makes a request of the platform\'s', () => {
        clear();
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'https://evil.example/c');
        xhr.open('GET', 'https://api.example/c');
        xhr.send();
        expect(sent).toEqual(['https://api.example/c']);
    });
});

/**
 * The URL checked is the URL sent (BD3:TST-1, class G with E-net: one read of a guest value). A guest hands the makers an
 * object that answers differently each time it is read; the maker must read it once, check that, and give the platform
 * that, never the object again. fetch() builds one Request from the input and sends a Request built from it; open() gives
 * the platform the resolved URL; the WebSocket constructor gives it the resolved URL too.
 */
describe('the URL checked is the URL sent: a guest value is read once', () => {
    const flipping = (first: string, second: string) => { let reads = 0; return { toString: () => (reads++ === 0 ? first : second), reads: () => reads }; };

    it('XMLHttpRequest.open: an object that answers an admitted URL, then a blocked one, sends the admitted one, read once', () => {
        clear();
        const url = flipping('https://api.example/ok', 'https://evil.example/leak');
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url as unknown as string);
        xhr.send();
        expect(opened).toEqual(['https://api.example/ok']);
        expect(sent).toEqual(['https://api.example/ok']);
        expect(url.reads()).toBe(1);
        expect(reports()).toEqual([]);
    });

    it('XMLHttpRequest.open: the first answer blocked, the second admitted, is refused on the first and reported as it', () => {
        clear();
        const xhr = new XMLHttpRequest();
        xhr.open('GET', flipping('https://evil.example/leak', 'https://api.example/ok') as unknown as string);
        xhr.send();
        expect(sent).toEqual([]);
        expect(reports()).toEqual(reportOf('https://evil.example/leak'));
    });

    it('WebSocket: an object that answers an admitted URL, then a blocked one, connects to the admitted one, read once', () => {
        clear();
        const url = flipping('wss://api.example/ok', 'wss://evil.example/leak');
        new WebSocket(url as unknown as string);
        expect(sockets).toEqual(['wss://api.example/ok']);
        expect(url.reads()).toBe(1);
        expect(reports()).toEqual([]);
    });

    it('fetch: an input that answers an admitted URL, then a blocked one, sends the admitted one only, with an init and without', async () => {
        clear();
        const withInit = flipping('https://api.example/ok', 'https://evil.example/leak');
        await fetch(withInit as unknown as string, { method: 'POST', body: 'x' });
        const bare = flipping('https://api.example/bare', 'https://evil.example/leak');
        await fetch(bare as unknown as string);
        expect(fetched.map(entry => entry.url)).toEqual(['https://api.example/ok', 'https://api.example/bare']);
        expect(withInit.reads() + bare.reads()).toBe(2);
        expect(reports()).toEqual([]);
    });

    it('fetch: a URL object changed after the call does not change the request (the positive control: what is sent was made at the call)', async () => {
        clear();
        const url = new URL('https://api.example/ok');
        const pending = fetch(url);
        url.href = 'https://evil.example/leak';
        await pending;
        expect(fetched.map(entry => entry.url)).toEqual(['https://api.example/ok']);
    });
});

describe('a relative URL resolves against the realm\'s base, as the platform resolves it (BD3:TST-3)', () => {
    // the harness's form is a worker's: it has no document, so the base is its location (a document's is its baseURI,
    // read the same way). A relative URL that did not resolve would throw a SyntaxError from open() and the constructor
    // instead of being checked, refused and reported as the URL it names.
    it('XMLHttpRequest and WebSocket refuse a relative URL as the absolute URL it resolves to, and report that', () => {
        clear();
        const base = (globalThis as any).location.href as string;
        const xhr = new XMLHttpRequest();
        expect(() => xhr.open('GET', '/rel?q#f')).not.toThrow();
        xhr.send();
        expect(sent).toEqual([]);
        expect(reports()).toEqual(reportOf(new URL('/rel?q', base).href));
        expect(() => new WebSocket('/socket')).toThrow(expect.objectContaining({ name: 'SecurityError' }));
        expect(reports()[1]).toEqual(reportOf(new URL('/socket', base).href.replace(/^http/, 'ws'))[0]);
    });
});

describe('no credentials on fetch() or XMLHttpRequest', () => {
    it("fetch() sends every request with credentials 'omit', whatever the init or the Request says", async () => {
        clear();
        await fetch('https://api.example/1', { credentials: 'include' });
        await fetch(new Request('https://api.example/2', { credentials: 'include' }));
        await fetch('https://api.example/3');
        expect(fetched.map(entry => entry.credentials)).toEqual(['omit', 'omit', 'omit']);
    });

    it('withCredentials reads false after it is set, and the platform\'s setter is never called', () => {
        clear();
        const xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        expect(xhr.withCredentials).toBe(false);
        expect(credentialsSet).toEqual([]);
    });
});

describe('the originals cannot be reached from the realm (BD1:ISO-2)', () => {
    it('no object on the global object\'s prototype chain holds the platform\'s fetch, XMLHttpRequest or WebSocket', () => {
        const originals = new Set<unknown>([platformFetch, PlatformXMLHttpRequest, PlatformWebSocket]);
        for (let owner: object | null = globalThis; owner; owner = Object.getPrototypeOf(owner)) {
            for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket']) {
                const found = Object.getOwnPropertyDescriptor(owner, name);
                if (found) expect(originals.has(found.value), name).toBe(false);
            }
        }
        expect(Object.getOwnPropertyDescriptor(prototypeOfGlobal, 'fetch')).toBeUndefined();
        expect(Object.getOwnPropertyDescriptor(globalThis, 'fetch')!.configurable).toBe(false);
    });

    it('each prototype names the gated constructor; an instance leads to no original; instanceof still holds', () => {
        expect(XMLHttpRequest).not.toBe(PlatformXMLHttpRequest);
        expect(XMLHttpRequest.prototype.constructor).toBe(XMLHttpRequest);
        expect(WebSocket.prototype.constructor).toBe(WebSocket);
        const xhr = new XMLHttpRequest();
        expect(Object.getPrototypeOf(xhr).constructor).toBe(XMLHttpRequest);
        expect(xhr).toBeInstanceOf(XMLHttpRequest);
        expect((XMLHttpRequest as any).DONE).toBe(4);
        expect((WebSocket as any).OPEN).toBe(1);
        expect(() => (XMLHttpRequest as any)()).toThrow(TypeError);
        // the platform's own members are replaced on its prototype, which is the gated constructor's
        expect(XMLHttpRequest.prototype).toBe(PlatformXMLHttpRequest.prototype);
        for (const name of ['open', 'send', 'abort'] as const) expect(XMLHttpRequest.prototype[name], name).not.toBe(PLATFORM_MEMBERS[name]);
        expect(new Function('return fetch')()).toBe(fetch);
    });
});

/**
 * The structural part: in the bootstrap's text, each original the gate captures is only ever called (the callee of
 * `apply(`/`construct(`), tested (`typeof`, a condition), aliased to a name that obeys the same rule, or handed to the
 * gate's own installers (`replaceGlobal`, `adopt`) as the original they remove or adopt. Never returned, stored, posted or
 * passed to anything else. And the platform's request makers are read from the global object only in the captured list.
 */
const ORIGINALS = ['nativeFetch', 'NativeXMLHttpRequest', 'xhrOpen', 'xhrSend', 'xhrAbort', 'xhrReadyState', 'xhrWithCredentials', 'NativeWebSocket', 'keepaliveOf', 'requestUrlOf'];
const BOOLEAN_BEFORE = new Set([SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.OpenParenToken, SyntaxKind.ExclamationToken, SyntaxKind.QuestionToken]);
const BOOLEAN_AFTER = new Set([SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.CloseParenToken, SyntaxKind.QuestionToken]);

function originalUses(text: string): string[] {
    const tokens = tokenize(text);
    const capture = tokens.findIndex((token, i) => token.text === 'CAPTURE_POINT' && tokens[i - 1]?.kind === SyntaxKind.ConstKeyword);
    if (capture < 0) return ['no CAPTURE_POINT'];
    const found: string[] = [];
    const watched = new Set(ORIGINALS);
    const show = (i: number) => text.slice(tokens[Math.max(0, i - 4)]!.start, tokens[Math.min(tokens.length - 1, i + 4)]!.end).replace(/\s+/g, ' ');
    const textAt = (i: number) => tokens[i]?.text ?? '';
    for (let i = capture; i < tokens.length; i++) {
        const token: Token = tokens[i]!;
        if (token.kind !== SyntaxKind.Identifier || !watched.has(token.text) || tokens[i - 1]?.kind === SyntaxKind.DotToken) continue;
        const before = tokens[i - 1]?.kind;
        const after = tokens[i + 1]?.kind;
        const called = (textAt(i - 2) === 'apply' || textAt(i - 2) === 'construct') && before === SyntaxKind.OpenParenToken;
        const typed = before === SyntaxKind.TypeOfKeyword;
        const tested = before !== undefined && BOOLEAN_BEFORE.has(before) && after !== undefined && (BOOLEAN_AFTER.has(after) || (after === SyntaxKind.ExclamationToken && BOOLEAN_AFTER.has(tokens[i + 2]?.kind as SyntaxKind)));
        const installed = (textAt(i - 4) === 'replaceGlobal' && textAt(i - 3) === '(') || (textAt(i - 4) === 'adopt' && textAt(i - 3) === '(');
        if (before === SyntaxKind.EqualsToken && tokens[i - 3]?.kind === SyntaxKind.ConstKeyword) {
            watched.add(textAt(i - 2)); // an alias: held to the same rule
            continue;
        }
        if (!called && !typed && !tested && !installed) found.push(show(i));
    }
    return found;
}

describe('the originals in the bootstrap\'s text', () => {
    const text = inSandboxScript.toString();

    it('each original is only called, tested, aliased under the same rule, or handed to the gate\'s installers', () => {
        expect(originalUses(text)).toEqual([]);
    });

    it('fetch, XMLHttpRequest and WebSocket are read from the global object once each, in the captured list, and each is replaced (or removed) by the installer', () => {
        const capture = text.indexOf('const CAPTURE_POINT');
        for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket']) {
            const reads = [...text.matchAll(new RegExp(`\\bg\\.${name}\\b`, 'g'))].map(match => match.index!);
            expect(reads, name).toHaveLength(1);
            expect(reads[0]!, name).toBeLessThan(capture);
            expect(text.match(new RegExp(`replaceGlobal\\(["']${name}["']`, 'g')), name).toHaveLength(2); // the gate, or nothing
        }
    });

    it('the scan finds what it looks for (positive control)', () => {
        const sample = `function f() {
            const nativeFetch = g.fetch;
            const CAPTURE_POINT = 'x';
            if (typeof nativeFetch === 'function' && nativeFetch) apply(nativeFetch, g, []);
            const alias = nativeFetch;
            apply(alias, g, []);
            replaceGlobal('fetch', nativeFetch, gated, true);
            publish('leak', nativeFetch);
            return alias;
        }`;
        expect(originalUses(sample)).toHaveLength(2);
    });
});

