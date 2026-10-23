/**
 * Which cookies each engine sends with a request of the sandbox, as one table (S74, class A; `INHERITED_CONTEXT.cookies`).
 * The warning about an `origins` entry on the host page's site (config-schema.ts, `limitHostReach`), the sentence of the
 * README and the tables of docs/API.md and docs/THREAT-MODEL.md are rendered from it, so no engine is named anywhere else:
 * `test/unit/cookie-facts.test.ts` fails on a document that says what an engine sends outside a generated region.
 *
 * What a row says: the SameSite values of the cookies an engine attaches to a request of a sandbox document or its worker
 * that the library cannot strip (a WebSocket handshake; a load of the guest's markup or CSS: an image, a stylesheet, a
 * font, media; in cooperative mode also `EventSource` and `sendBeacon()`) to a listed origin on the host page's site
 * (`sameSite`) or on another site (`crossSite`). The wrapper iframe is `credentialless` (frame-documents.ts), which only
 * Chromium honours. `fetch()` and `XMLHttpRequest` carry no cookie in any engine: the bootstrap's request gate sends
 * every fetch with `credentials: 'omit'` and keeps `withCredentials` false (in-sandbox-script.ts, S74). The fetch bridge
 * sends none either (`credentials: 'omit'`). Neither is in the table.
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
    `a guest's WebSocket handshake, or a load of its markup or CSS, to the host page's site can carry the host site's cookies (${engineClauses('sameSite', code)}; fetch() and XMLHttpRequest carry none)`;

/** The sentence the README states: both kinds of origin, every engine. */
export const cookieSentence = (code: (text: string) => string): string =>
    `${code('fetch()')} and ${code('XMLHttpRequest')} of the sandbox carry no cookie in any engine: the library sends them without credentials. A request it cannot strip (a WebSocket handshake, or a load of the guest's markup or CSS) to an origin on the host page's site carries these cookies: ${engineClauses('sameSite', code)}. To an origin on another site it carries that site's own cookies: ${engineClauses('crossSite', code, false)}. The fetch bridge sends none in any engine.`;
