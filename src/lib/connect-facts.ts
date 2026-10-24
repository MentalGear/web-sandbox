/**
 * What each engine does with a `connect-src` source, as one table: why the library applies the host page's policy and the
 * `wss://` twin rule itself (INHERITED_CONTEXT.cspFetch; ADR-007). The table of docs/API.md#your-connect-src and the
 * sentences of the README are rendered from it, so no engine is named anywhere else for these:
 * `test/unit/connect-facts.test.ts` fails on a document that says what an engine does with them outside a generated region.
 *
 * What a row says, for a request of a sandbox document (a sandboxed `srcdoc` frame with a policy of its own, which copies
 * the host page's policy list) to an origin its own policy lists:
 *  - `selfAdmitsOtherOrigins`: whether a `'self'` source of the page's policy admits an origin it does not name (the
 *    sandbox's frames reach origins a page of `connect-src 'self'` does not name). An explicit source narrows in every
 *    engine. The library treats `'self'` as admitting nothing in all of them;
 *  - `bareHostAdmitted`: whether a host source written without a scheme (`api.example`) admits the `https://` origin it
 *    names: `yes`, `no` (read against the frame's own scheme), or `yes, not with a port` (a port number written). The library treats
 *    such a source as admitting nothing in all of them;
 *  - `upgradedSchemeWithPort`: whether `http://h:P` admits `https://h:P` (CSP3 takes the upgrade). The library takes it
 *    only when no port is written, or `:*`;
 *  - `wssSourceAdmitsHttps`: whether a `wss://h` source also admits an `https://h` request (CSP3's scheme matching); the
 *    library lists a `wss://h` entry only beside `https://h`, so that both admit both in every engine.
 * These are also what a guest reaches where the library does not narrow: with `hostContentSecurityPolicy: false` the page's
 * policy, if it sends one, is applied by the browser alone.
 *
 * Internal: not exported from the package.
 */

export const CONNECT_ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type ConnectEngine = (typeof CONNECT_ENGINES)[number];

/** How an engine reads a host source written without a scheme. */
export const BARE_HOST_READINGS = ['yes', 'no', 'yes, not with a port'] as const;
export type BareHostReading = (typeof BARE_HOST_READINGS)[number];

export interface ConnectEngineFacts {
    /** The engine, as the docs name it. */
    readonly name: string;
    readonly selfAdmitsOtherOrigins: boolean;
    readonly bareHostAdmitted: BareHostReading;
    readonly upgradedSchemeWithPort: boolean;
    readonly wssSourceAdmitsHttps: boolean;
    /** How the row was found. */
    readonly measured: string;
}

const RESEARCH = '2026-10-23, Playwright 1.58.1';
const SPEC = 'test/e2e/connect-uniform.spec.ts';

export const CONNECT_ENGINE_FACTS = {
    chromium: {
        name: 'Chromium',
        selfAdmitsOtherOrigins: false,
        bareHostAdmitted: 'yes, not with a port',
        upgradedSchemeWithPort: false,
        wssSourceAdmitsHttps: false,
        measured: `${RESEARCH}, Chromium 145: ${SPEC} (every source of the grammar table against fetch and WebSocket requests of a guest, the page's policy left to the browser)`,
    },
    firefox: {
        name: 'Firefox',
        selfAdmitsOtherOrigins: false,
        bareHostAdmitted: 'yes',
        upgradedSchemeWithPort: true,
        wssSourceAdmitsHttps: false,
        measured: `${RESEARCH}, Firefox 146: as Chromium`,
    },
    webkit: {
        name: 'WebKit',
        selfAdmitsOtherOrigins: true,
        bareHostAdmitted: 'no',
        upgradedSchemeWithPort: true,
        wssSourceAdmitsHttps: true,
        measured: `${RESEARCH}, WebKit 26: as Chromium`,
    },
} as const satisfies Record<ConnectEngine, ConnectEngineFacts>;

type BooleanFact = { [K in keyof ConnectEngineFacts]: ConnectEngineFacts[K] extends boolean ? K : never }[keyof ConnectEngineFacts];

/** The engines for which `fact` holds, by name, in table order. */
export const enginesWhere = (fact: BooleanFact, holds = true): string[] =>
    CONNECT_ENGINES.filter(engine => CONNECT_ENGINE_FACTS[engine][fact] === holds).map(engine => CONNECT_ENGINE_FACTS[engine].name);

/** "Chromium and Firefox", "WebKit", "Chromium, Firefox and WebKit"; "no engine" for none. */
export function nameList(names: readonly string[]): string {
    if (names.length === 0) return 'no engine';
    return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The sentence the README states: what the engines would do without the library's own rules. */
export const connectSentence = (): string =>
    `Without the library's own rules the engines disagree: a \`'self'\` source of the host page's \`connect-src\` admits origins it does not name in ${nameList(enginesWhere('selfAdmitsOtherOrigins'))} only, a \`wss://host\` source also admits \`https://host\` requests in ${nameList(enginesWhere('wssSourceAdmitsHttps'))} only, and a host written without a scheme is read differently by each. The library applies the page's policy and these two rules itself, so \`origins.connect\` and \`fetchBridge.allow\` mean the same everywhere.`;
