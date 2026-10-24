/**
 * Which cookies each engine sends with a request of the sandbox, as one table (S74, class A; `INHERITED_CONTEXT.cookies`).
 * The warning about an `origins` entry on the host page's site (config-schema.ts, `limitHostReach`), the sentence of the
 * README and the tables of docs/API.md and docs/THREAT-MODEL.md are rendered from it, so no engine is named anywhere else:
 * `test/unit/cookie-facts.test.ts` fails on a document that says what an engine sends outside a generated region.
 *
 * What a row says: the SameSite values of the cookies an engine attaches to a request of a sandbox document or its worker
 * that the library cannot strip (COOKIE_CARRIERS: a WebSocket handshake; in cooperative mode also a load of the guest's
 * markup or CSS, `sendBeacon()`, `EventSource`, `<a ping>` and the requests of a frame the guest creates) to a listed origin on the host page's site
 * (`sameSite`) or on another site (`crossSite`); COOKIE_CARRIERS lists those requests. The wrapper iframe is `credentialless` (frame-documents.ts), which only
 * Chromium honours. `fetch()` and `XMLHttpRequest` carry no cookie in any engine: the bootstrap's request gate sends
 * every fetch with `credentials: 'omit'` and keeps `withCredentials` false (in-sandbox-script.ts, S74). The fetch bridge
 * sends none either (`credentials: 'omit'`). Strict mode's view makes every load without credentials, on every engine:
 * every element that loads is given `crossorigin="anonymous"` before it is connected, and CSS and posters keep no network
 * URL (in-sandbox-view.ts, RENDER_CROSSORIGIN_ELEMENTS; S74), but to an origin the embedder lists in `origins.withoutCors`,
 * whose loads are made the engine's way, as a third-party request (its own cookies only: the host site is never listed).
 * None of these is in the table.
 *
 * Internal: not exported from the package.
 */

/** The SameSite values a cookie can have. */
export const SAME_SITE_VALUES = ['None', 'Lax', 'Strict'] as const;
export type SameSiteValue = (typeof SAME_SITE_VALUES)[number];

/** What an engine sends, by where the request goes. */
export interface CookieReach {
    /** To an origin on the host page's site. */
    readonly sameSite: readonly SameSiteValue[];
    /** To an origin on another site (its own cookies, as for any third-party request). */
    readonly crossSite: readonly SameSiteValue[];
}

export interface CookieEngineFacts {
    /** The engine, as the docs name it. */
    readonly name: string;
    /** Whether it honours the `credentialless` attribute of the wrapper iframe. */
    readonly credentialless: boolean;
    /** What it sends in its configuration without cookie protection (what the suite's engine does). */
    readonly sends: CookieReach;
    /** A configuration of the engine that sends less, whether the suite measured it, and what it sends there; null if none is known. */
    readonly protectedBy: { readonly configuration: string; readonly measured: boolean; readonly sends: CookieReach } | null;
    /** How the row was found. */
    readonly measured: string;
}

export const COOKIE_ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type CookieEngine = (typeof COOKIE_ENGINES)[number];

export const COOKIE_ENGINE_FACTS = {
    chromium: {
        name: 'Chromium',
        credentialless: true,
        sends: { sameSite: [], crossSite: [] },
        protectedBy: null,
        measured: 'test/e2e/cookies.spec.ts: a listener of the same site and one of another, fetch with credentials, a no-cors POST and an image, in every mode; the same requests from a frame without the attribute carry the cookie',
    },
    firefox: {
        name: 'Firefox',
        credentialless: false,
        sends: { sameSite: ['None'], crossSite: ['None'] },
        protectedBy: { configuration: "Total Cookie Protection, Firefox's default", measured: true, sends: { sameSite: [], crossSite: [] } },
        measured: "S74 board, 2026-10-21, Playwright's Firefox (cookieBehavior 4): a SameSite=None cookie in every mode, Lax and Strict none; with cookieBehavior 5 none. The WebSocket handshake to another site: test/e2e/request-gate.spec.ts, 2026-10-23",
    },
    webkit: {
        name: 'WebKit',
        credentialless: false,
        sends: { sameSite: ['None', 'Lax', 'Strict'], crossSite: ['None'] },
        protectedBy: { configuration: 'Safari, which blocks third-party cookies', measured: false, sends: { sameSite: ['None', 'Lax', 'Strict'], crossSite: [] } },
        measured: "S74 board, 2026-10-21, Playwright's WebKit: None, Lax and Strict to a same-site origin and None to another site, in every mode. The WebSocket handshake to another site: test/e2e/request-gate.spec.ts, 2026-10-23",
    },
} as const satisfies Record<CookieEngine, CookieEngineFacts>;

export type Reach = keyof CookieReach;

/**
 * The requests of a sandbox that carry the browser's cookies, because the library cannot strip them (BD3:DOC-1, class A):
 * the request gate sends the guest's `fetch()` and `XMLHttpRequest` without credentials and refuses what it does not admit,
 * and it covers those two and `WebSocket`; every other maker is the browser's. The README's sentence and the tables of
 * docs/API.md and docs/THREAT-MODEL.md are rendered from this list, and `test/e2e/cookies.spec.ts` makes one request for
 * each row of cooperative mode on every engine, so a carrier that is not here is not listed anywhere. In `request`, `short`
 * and `why` a backticked span is code.
 */
export const COOKIE_CARRIERS = {
    websocket: {
        request: 'A WebSocket handshake', short: 'a WebSocket handshake', modes: 'every mode', unsentBy: [],
        why: "The browser makes the handshake and attaches the cookies by site; the gate can refuse it, not strip it, so a server behind a listed `wss://` origin must check `Origin`",
        test: 'test/e2e/request-gate.spec.ts',
    },
    markup: {
        request: "A load of the guest's markup or CSS (an image, a stylesheet, a font, media)", short: "a load of the guest's markup or CSS", modes: 'cooperative mode', unsentBy: [],
        why: "The engine makes the load for the document that holds it. Strict mode's view makes each of its loads without credentials (`crossorigin=\"anonymous\"`; no network URL in CSS or a poster), but one to an origin of `origins.withoutCors`, which carries that origin's own cookies (never the host site's)",
        test: 'test/e2e/cookies.spec.ts',
    },
    beacon: {
        request: 'A `navigator.sendBeacon(url, data)` call', short: '`navigator.sendBeacon()`', modes: 'cooperative mode', unsentBy: [],
        why: 'A credentialed POST. The gate covers `fetch()`, `XMLHttpRequest` and `WebSocket`; this maker is not among them, and the strict and worker-mode worker has none',
        test: 'test/e2e/cookies.spec.ts',
    },
    eventsource: {
        request: 'An `EventSource` made with `{ withCredentials: true }`', short: '`EventSource` with `withCredentials`', modes: 'cooperative mode', unsentBy: [],
        why: 'The guest chooses `withCredentials`; the gate does not cover `EventSource`, and the strict and worker-mode worker has none',
        test: 'test/e2e/cookies.spec.ts',
    },
    ping: {
        request: 'An `<a ping>` click', short: 'an `<a ping>` click', modes: 'cooperative mode', unsentBy: ['firefox'],
        why: 'A POST made by the browser when the link is followed; Firefox sends no ping by default',
        test: 'test/e2e/cookies.spec.ts',
    },
    frames: {
        request: "A request of a frame or worker the guest creates (its own `fetch()` with `credentials: 'include'`)", short: 'the requests of a frame the guest creates', modes: 'cooperative mode', unsentBy: [],
        why: 'A realm of its own with the platform\'s `fetch`: a limit of cooperative mode (S44)',
        test: 'test/e2e/cookies.spec.ts',
    },
} as const satisfies Record<string, CookieCarrier>;

export interface CookieCarrier {
    /** The request, as the table of the docs names it. */
    readonly request: string;
    /** The request, as a sentence names it. */
    readonly short: string;
    /** Where the guest can make it. */
    readonly modes: 'every mode' | 'cooperative mode';
    /** The engines that send no such request at all. */
    readonly unsentBy: readonly CookieEngine[];
    /** Why the library cannot strip its credentials. */
    readonly why: string;
    /** The spec that makes it on every engine. */
    readonly test: string;
}

/**
 * The credentials besides cookies that the browser may attach to the same requests (BD3:ISO-4): they belong to the user
 * and the origin, not to the page, and the suite has not measured what each engine sends. The gate's `fetch()` and
 * `XMLHttpRequest` and the fetch bridge send none (`credentials: 'omit'`); a WebSocket handshake and, in cooperative
 * mode, a load of the guest's markup or CSS cannot be stripped. A listed origin must not rely on them for the user's identity.
 */
export const AMBIENT_CREDENTIALS = ['cached HTTP authentication (Basic, Digest, integrated Windows or Kerberos)', 'a TLS client certificate'] as const;

/** The sentence that says so: the README's, and the paragraphs of docs/API.md and docs/THREAT-MODEL.md under the carriers' table. */
export const ambientCredentialsSentence = (): string =>
    `The browser may attach credentials that are not cookies to the same requests when it holds them for the origin: ${AMBIENT_CREDENTIALS.join(' and ')}; the tables do not state what each engine sends (not measured), so do not list an origin for a guest that it recognises the user by.`;

export type CookieCarrierId = keyof typeof COOKIE_CARRIERS;
export const COOKIE_CARRIER_IDS = Object.keys(COOKIE_CARRIERS) as CookieCarrierId[];

/** `text` with each backticked span through `code`. */
export const withCode = (text: string, code: (text: string) => string): string => text.replace(/`([^`]+)`/g, (_, span: string) => code(span));

/** The carriers a sentence names: every mode's, and, after "in cooperative mode also", the cooperative mode's. */
export function carrierClause(code: (text: string) => string = text => text): string {
    const named = (modes: CookieCarrier['modes']) => COOKIE_CARRIER_IDS.filter(id => COOKIE_CARRIERS[id].modes === modes).map(id => withCode(COOKIE_CARRIERS[id].short, code));
    const cooperative = named('cooperative mode');
    return `${named('every mode').join(', or ')}; in cooperative mode also ${cooperative.slice(0, -1).join(', ')} and ${cooperative[cooperative.length - 1]}`;
}

/** `SameSite=None`, `SameSite=None and Lax`, `SameSite=None, Lax and Strict`; "none" for no value. `code` wraps a literal. */
export function sameSiteValues(values: readonly SameSiteValue[], code: (text: string) => string = text => text): string {
    if (values.length === 0) return 'none';
    const list = values.length === 1 ? values[0]! : `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
    return code(`SameSite=${list}`);
}

/**
 * One engine's clause for `reach`: what it sends, and what leaves it narrower (the attribute, or a configuration of the
 * engine). `credentialless` adds the note about the attribute, which the sentence of a table says once.
 */
export function engineClause(engine: CookieEngine, reach: Reach, code: (text: string) => string = text => text, credentialless = true): string {
    const facts: CookieEngineFacts = COOKIE_ENGINE_FACTS[engine];
    const sent = facts.sends[reach];
    let clause = `${facts.name}: ${sameSiteValues(sent, code)}`;
    if (facts.credentialless && credentialless) clause += " (the sandbox's frame is credentialless)";
    const narrower = facts.protectedBy;
    if (narrower && narrower.sends[reach].length < sent.length) clause += ` (${sameSiteValues(narrower.sends[reach], code)} with ${narrower.configuration}${narrower.measured ? '' : '; not measured'})`;
    return clause;
}

/** The clauses of every engine for `reach`, in table order, joined for a sentence. */
export const engineClauses = (reach: Reach, code?: (text: string) => string, credentialless = true): string => COOKIE_ENGINES.map(engine => engineClause(engine, reach, code, credentialless)).join('; ');

/** What the warning says of the host site's cookies on a request to an origin on the host page's site. */
export const sameSiteCookieClause = (code?: (text: string) => string): string =>
    `a guest's WebSocket handshake, or in cooperative mode a load of its markup or CSS, to the host page's site can carry the host site's cookies (${engineClauses('sameSite', code)}; fetch(), XMLHttpRequest and the loads of strict mode's view carry none, but those to an origin of origins.withoutCors)`;

/** What `origins.withoutCors` costs, by engine: its loads are the engine's third-party requests to that origin. */
export const withoutCorsCookieSentence = (code: (text: string) => string): string =>
    `**A load of the view to an origin of ${code('withoutCors')} carries that origin's own cookies where the engine attaches them to a third-party request:** ${engineClauses('crossSite', code, false)}.`;

/** The sentence the README states: both kinds of origin, every engine. */
export const cookieSentence = (code: (text: string) => string): string =>
    `${code('fetch()')} and ${code('XMLHttpRequest')} of the sandbox carry no cookie in any engine: the library sends them without credentials. Neither does any load of strict mode's view: its elements load as CORS requests without credentials (${code('crossorigin="anonymous"')}), and its CSS and posters keep no network URL, except for the origins the embedder lists in ${code('origins.withoutCors')}, whose own cookies those loads carry where the engine sends them. A request it cannot strip (${carrierClause(code)}) to an origin on the host page's site carries these cookies: ${engineClauses('sameSite', code)}. To an origin on another site it carries that site's own cookies: ${engineClauses('crossSite', code, false)}. The fetch bridge sends none in any engine. ${ambientCredentialsSentence()}`;
