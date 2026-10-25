/**
 * Which cookies each engine sends with a request of the sandbox, as one table (S74, class A; `INHERITED_CONTEXT.cookies`).
 * The warning about an `origins` entry on the host page's site (config-schema.ts, `limitHostReach`), the sentence of the
 * README and the tables of docs/API.md and docs/THREAT-MODEL.md are rendered from it, so no engine is named anywhere else:
 * `test/unit/cookie-facts.test.ts` fails on a document that says what an engine sends outside a generated region.
 *
 * What a row says: the SameSite values of the cookies an engine attaches to a request of a sandbox document or its worker
 * that the library cannot strip (COOKIE_CARRIERS: in cooperative and worker mode a WebSocket handshake; in cooperative
 * mode also a load of the guest's markup or CSS, `sendBeacon()`, `EventSource`, `<a ping>` and the requests of a frame the
 * guest creates) to a listed origin on the host page's site (`sameSite`) or on another site (`crossSite`); COOKIE_CARRIERS
 * lists those requests. The wrapper iframe is `credentialless` (frame-documents.ts), which only Chromium honours.
 * `fetch()` and `XMLHttpRequest` carry no cookie in any engine: the bootstrap's request gate sends every fetch with
 * `credentials: 'omit'` and keeps `withCredentials` false (in-sandbox-script.ts, S74). The fetch bridge sends none either
 * (`credentials: 'omit'`). Strict mode has no carrier at all, on any engine (STRICT_COOKIE_CARRIERS): its view makes
 * every load without credentials (every element that loads is given `crossorigin="anonymous"` before it is connected,
 * and CSS and posters keep no network URL: in-sandbox-view.ts, RENDER_CROSSORIGIN_ELEMENTS), and its worker opens no
 * WebSocket (the request gate refuses every one, and `origins` keeps no `wss://` entry: origins.ts). None of these is in
 * the table.
 *
 * Internal: not exported from the package.
 */

import type { SandboxMode } from './config-schema';

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
 * The requests of a sandbox that carry the browser's cookies, because the library cannot strip them (BD3:DOC-1, class A),
 * and the modes in which the guest can make each: the class's chokepoint. The request gate sends the guest's `fetch()` and
 * `XMLHttpRequest` without credentials and refuses what it does not admit, and it covers those two and `WebSocket`;
 * every other maker is the browser's. A row's `modes` cannot name strict mode (its type, CookieCarrierMode): strict mode
 * has no cookie carrier, on any engine (STRICT_COOKIE_CARRIERS). The README's sentence and the tables of docs/API.md and
 * docs/THREAT-MODEL.md are rendered from this list, and `test/e2e/cookies.spec.ts` makes one request for each row of
 * cooperative mode on every engine, so a carrier that is not here is not listed anywhere. In `request`, `short` and `why`
 * a backticked span is code.
 */
export const COOKIE_CARRIERS = {
    websocket: {
        request: 'A WebSocket handshake', short: 'a WebSocket handshake', modes: ['cooperative', 'worker'], unsentBy: [],
        why: "The browser makes the handshake and attaches the cookies by site; the gate can refuse it, not strip it, so a server behind a listed `wss://` origin must check `Origin`. Strict mode opens none: its gate refuses every `WebSocket`, and its `origins.connect` keeps no `wss://` entry",
        test: 'test/e2e/request-gate.spec.ts',
    },
    markup: {
        request: "A load of the guest's markup or CSS (an image, a stylesheet, a font, media)", short: "a load of the guest's markup or CSS", modes: ['cooperative'], unsentBy: [],
        why: "The engine makes the load for the document that holds it. Strict mode's view makes each of its loads without credentials (`crossorigin=\"anonymous\"`; no network URL in CSS or a poster)",
        test: 'test/e2e/cookies.spec.ts',
    },
    beacon: {
        request: 'A `navigator.sendBeacon(url, data)` call', short: '`navigator.sendBeacon()`', modes: ['cooperative'], unsentBy: [],
        why: 'A credentialed POST. The gate covers `fetch()`, `XMLHttpRequest` and `WebSocket`; this maker is not among them, and the strict and worker-mode worker has none',
        test: 'test/e2e/cookies.spec.ts',
    },
    eventsource: {
        request: 'An `EventSource` made with `{ withCredentials: true }`', short: '`EventSource` with `withCredentials`', modes: ['cooperative'], unsentBy: [],
        why: 'The guest chooses `withCredentials`; the gate does not cover `EventSource`, and the strict and worker-mode worker has none',
        test: 'test/e2e/cookies.spec.ts',
    },
    ping: {
        request: 'An `<a ping>` click', short: 'an `<a ping>` click', modes: ['cooperative'], unsentBy: ['firefox'],
        why: 'A POST made by the browser when the link is followed; Firefox sends no ping by default',
        test: 'test/e2e/cookies.spec.ts',
    },
    frames: {
        request: "A request of a frame or worker the guest creates (its own `fetch()` with `credentials: 'include'`)", short: 'the requests of a frame the guest creates', modes: ['cooperative'], unsentBy: [],
        why: 'A realm of its own with the platform\'s `fetch`: a limit of cooperative mode (S44)',
        test: 'test/e2e/cookies.spec.ts',
    },
} as const satisfies Record<string, CookieCarrier>;

/** A mode in which a request can carry a cookie: never strict mode (STRICT_COOKIE_CARRIERS), never sealed mode (no network). */
export type CookieCarrierMode = Exclude<SandboxMode, 'strict' | 'sealed'>;

export interface CookieCarrier {
    /** The request, as the table of the docs names it. */
    readonly request: string;
    /** The request, as a sentence names it. */
    readonly short: string;
    /** The modes in which the guest can make it: never strict mode, which has no cookie carrier. */
    readonly modes: readonly CookieCarrierMode[];
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
 * `XMLHttpRequest` and the fetch bridge send none (`credentials: 'omit'`); a WebSocket handshake (not in strict mode)
 * and, in cooperative mode, a load of the guest's markup or CSS cannot be stripped. A listed origin must not rely on them for the user's identity.
 */
export const AMBIENT_CREDENTIALS = ['cached HTTP authentication (Basic, Digest, integrated Windows or Kerberos)', 'a TLS client certificate'] as const;

/** The sentence that says so: the README's, and the paragraphs of docs/API.md and docs/THREAT-MODEL.md under the carriers' table. */
export const ambientCredentialsSentence = (): string =>
    `The browser may attach credentials that are not cookies to the same requests when it holds them for the origin: ${AMBIENT_CREDENTIALS.join(' and ')}; the tables do not state what each engine sends (not measured), so do not list an origin for a guest that it recognises the user by.`;

export type CookieCarrierId = keyof typeof COOKIE_CARRIERS;
export const COOKIE_CARRIER_IDS = Object.keys(COOKIE_CARRIERS) as CookieCarrierId[];

/** The carriers the guest can make in `mode`, in table order. */
export const cookieCarriersIn = (mode: SandboxMode): CookieCarrierId[] =>
    COOKIE_CARRIER_IDS.filter(id => (COOKIE_CARRIERS[id].modes as readonly SandboxMode[]).includes(mode));

/**
 * Strict mode's cookie carriers: none, on any engine (S74, class A). No request of strict mode carries a cookie: the
 * worker's `fetch()` and `XMLHttpRequest` send none and it opens no WebSocket, and the view makes every load without
 * credentials. `test/unit/cookie-facts.test.ts` pins it, with the strict config after normalisation (no `ws:` or `wss:`
 * entry) and the renderer (every element of RENDER_CROSSORIGIN_ELEMENTS gets `crossorigin="anonymous"`, whatever
 * `origins` lists).
 */
export const STRICT_COOKIE_CARRIERS: readonly CookieCarrierId[] = Object.freeze(cookieCarriersIn('strict'));

/** `text` with each backticked span through `code`. */
export const withCode = (text: string, code: (text: string) => string): string => text.replace(/`([^`]+)`/g, (_, span: string) => code(span));

/** Where a carrier can be made, as the docs say it: "cooperative and worker mode", "cooperative mode only". */
export const carrierModes = (carrier: CookieCarrier): string =>
    carrier.modes.length === 1 ? `${carrier.modes[0]} mode only` : `${carrier.modes.slice(0, -1).join(', ')} and ${carrier.modes[carrier.modes.length - 1]} mode`;

/**
 * The carriers a sentence names: those of cooperative and worker mode, then, after "in cooperative mode also", those of
 * cooperative mode alone.
 */
export function carrierClause(code: (text: string) => string = text => text): string {
    const named = (only: boolean) => COOKIE_CARRIER_IDS.filter(id => (COOKIE_CARRIERS[id].modes.length === 1) === only).map(id => withCode(COOKIE_CARRIERS[id].short, code));
    const cooperative = named(true);
    return `${named(false).join(', or ')} in cooperative and worker mode; in cooperative mode also ${cooperative.slice(0, -1).join(', ')} and ${cooperative[cooperative.length - 1]}`;
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
    `a guest's WebSocket handshake in cooperative or worker mode, or in cooperative mode a load of its markup or CSS, to the host page's site can carry the host site's cookies (${engineClauses('sameSite', code)}; fetch(), XMLHttpRequest and every request of strict mode carry none)`;

/** The sentence the README states: both kinds of origin, every engine. */
export const cookieSentence = (code: (text: string) => string): string =>
    `${code('fetch()')} and ${code('XMLHttpRequest')} of the sandbox carry no cookie in any engine: the library sends them without credentials. No request of strict mode carries a cookie, on any engine: its view's elements load as CORS requests without credentials (${code('crossorigin="anonymous"')}), its CSS and posters keep no network URL, and its worker opens no WebSocket. A request the library cannot strip in the other modes (${carrierClause(code)}) to an origin on the host page's site carries these cookies: ${engineClauses('sameSite', code)}. To an origin on another site it carries that site's own cookies: ${engineClauses('crossSite', code, false)}. The fetch bridge sends none in any engine. ${ambientCredentialsSentence()}`;
