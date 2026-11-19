/**
 * The network modes' part of the config schema (research 24, D9; ADR-009): the rules of the two options that open the
 * network, `origins` and `fetchBridge` (config-schema.ts, NETWORK_OPTIONS), what a listed origin may reach of the host
 * page's site and the user's network (limitHostReach), and the fetch bridge's cross-field invariants. The schema declares
 * both options (their defaults, their modes); a build runs their rules only through the seam (network-modes.ts), so the
 * default build holds none of this.
 *
 * Host-side only, never stringified into the guest.
 */
import { carriedTo, COOKIE_CARRIER_IDS, COOKIE_CARRIERS, cookieCarriersIn, sameSiteCookieClause, withCode, type CookieCarrierId } from './cookie-facts';
import { BELOW_LARGEST_CALL, CONFIG_INVARIANTS, heaviestCall, isSandboxMode, type CallBudget, type ConfigInvariant, type NormaliseContext, type OptionInput } from './config-schema';
import { ORIGIN_KINDS, parseOrigins, refusalDetail, type OriginPolicy } from './csp/origins';
import { isPrivateHost, isPrivateOrigin, PRIVATE_NETWORK_REASON, toFetchPolicy, type FetchPolicy } from './fetch-bridge';
import { hostPageOrigin, hostSiteOrigins, hostSiteUndecided, onHostSite } from './host-site';
import type { Origin } from './origin';
import { RPC_MAX_BYTES } from './rpc';

/**
 * The one pass over a parsed `origins` that decides what a listed origin reaches beyond the internet at large, in every
 * list (ORIGIN_KINDS: every kind, so a new kind is covered), with one warning per list and reason.
 * Its inputs about the host page are `context.hostSites` (host-site.ts, `hostSiteOrigins`) and `context.hostOrigin`:
 *  - An origin on the host page's site (onHostSite, host-site.ts: on the site of the page's origin, of its top-level
 *    URL or of a page that frames it; the site of a host is the host, or every host that shares its last two labels;
 *    for an address, `localhost` or a single-label host, that host only) may receive the host site's cookies with a
 *    guest request (INHERITED_CONTEXT.cookies; the engines differ, and only Chromium's wrapper frame, credentialless,
 *    sends none), so it is dropped from the policy in every mode. The rule needs no probe of the page, and it can only
 *    refuse more than the browser's public-suffix list would (two sites under a suffix of several labels, such as
 *    `github.io`), which the warning says (SITE_RULE).
 *  - When the host page's site is undecided (hostSiteUndecided: an opaque origin, or one that cannot be read, among
 *    them; BD4:ISO-1, BD4:ISO-3), the rule cannot say which hosts an engine counts as the host page's site, so every
 *    entry that a request carrying cookies can reach in the mode is dropped too (COOKIE_CARRIERS, its `modes` and
 *    `reaches`, cookie-facts.ts: `wss://` entries in worker mode; in cooperative mode every list; none in strict
 *    mode, which has no carrier), with a warning that says why (UNDECIDED_SITE_RULE).
 *  - A loopback, private or link-local host (isPrivateHost) is a machine or network of the user's, which the guest then
 *    reaches, and engines differ on whether a page of the public web may do that: kept, with a warning, only when the
 *    host page is itself on one (`hostOrigin`); dropped, with a warning, otherwise (PRIVATE_NETWORK_REASON).
 * fetchBridge.allow says the same for its entries (toFetchPolicy); the fetch bridge sends no credentials, so it is what
 * the warnings point to. Returns `policy` itself when nothing is dropped.
 */
export function limitHostReach(policy: OriginPolicy, context: NormaliseContext, warn: (message: string) => void, mode: unknown): OriginPolicy {
    const { hostOrigin, hostSites } = context;
    const hostIsPrivate = isPrivateOrigin(hostOrigin);
    const undecided = hostSiteUndecided(hostSites);
    // a mode that is not one refuses every build; until then it counts as every mode
    const carriers = undecided === null ? [] : isSandboxMode(mode) ? cookieCarriersIn(mode) : COOKIE_CARRIER_IDS;
    const kept: Record<string, readonly Origin[]> = {};
    let dropped = false;
    for (const kind of ORIGIN_KINDS) {
        const keep: Origin[] = [];
        const siteRefused: string[] = [];
        const undecidedRefused: string[] = [];
        const localRefused: string[] = [];
        const listed: string[] = [];
        for (const origin of policy[kind]) {
            // one entry per origin, with every reason it is listed for
            const reasons: string[] = [];
            const onSite = onHostSite(origin, hostSites);
            const carried = !onSite && carriedTo(carriers, kind, origin);
            const onLocal = isPrivateHost(new URL(origin).hostname);
            if (onSite) reasons.push(origin === hostOrigin ? "the host page's own origin" : "on the host page's site");
            if (carried) reasons.push("the host page's site is undecided");
            if (onLocal) reasons.push('a loopback, private or link-local host');
            const entry = `${origin} (${reasons.join(', ')})`;
            if (onSite) { siteRefused.push(entry); continue; }
            if (carried) { undecidedRefused.push(entry); continue; }
            if (onLocal && !hostIsPrivate) { localRefused.push(entry); continue; }
            keep.push(origin);
            if (onLocal) listed.push(entry);
        }
        kept[kind] = Object.freeze(keep);
        if (siteRefused.length > 0) {
            dropped = true;
            warn(`[Sandbox] origins.${kind} dropped ${siteRefused.join(', ')}: ${SITE_COOKIES}; the library admits no origin on the host page's site, in any mode. ${SITE_RULE}`);
        }
        if (undecidedRefused.length > 0) {
            dropped = true;
            warn(`[Sandbox] origins.${kind} dropped ${undecidedRefused.join(', ')}: ${undecided}, so no entry is admitted that ${carrierNames(carriers)} can reach, as it could be on that site: ${SITE_COOKIES}. ${UNDECIDED_SITE_RULE}`);
        }
        if (localRefused.length > 0) {
            dropped = true;
            warn(`[Sandbox] origins.${kind} dropped ${localRefused.join(', ')}: ${PRIVATE_NETWORK_REASON}.`);
        }
        if (listed.length > 0) warn(`[Sandbox] origins.${kind} lists ${listed.join(', ')}: a loopback, private or link-local host is the user's own machine or network, which the guest then reaches. Prefer the fetch bridge (fetchBridge.allow), whose requests carry no credentials.`);
    }
    return dropped ? (Object.freeze(kept) as OriginPolicy) : policy;
}

/** The carriers a warning names, as a sentence names each (COOKIE_CARRIERS `short`). */
const carrierNames = (carriers: readonly CookieCarrierId[]): string => {
    const names = carriers.map(id => withCode(COOKIE_CARRIERS[id].short, text => text));
    return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
};

/**
 * What the warning of an undecided host site says of its rule (host-site.ts, hostSiteUndecided): what leaves the site
 * undecided, and the way to reach such an origin.
 */
export const UNDECIDED_SITE_RULE = "The host page's site is that of its own origin, of its top-level URL and of every page that frames it; an opaque origin among them (a sandboxed document), or one the browser does not give (a page of another origin above the host page, where the browser has no location.ancestorOrigins), leaves it undecided. Use the fetch bridge (fetchBridge.allow), whose requests carry no credentials, to reach such an origin.";

/**
 * What the same-site drop warning says of its rule (host-site.ts, onHostSite): where it can refuse more than the
 * browser's public-suffix list would, and the way to reach such an origin.
 */
export const SITE_RULE = "An origin counts as on the site when its host is the page's host or shares the page's last two labels (for an address, localhost or a single-label host, that host only), so under a public suffix of several labels (two github.io or two co.uk sites) another site's origin may be refused too. Use the fetch bridge (fetchBridge.allow), whose requests carry no credentials, to reach such an origin.";

// What the warnings say of the host site's cookies: one sentence, rendered from the engine facts (cookie-facts.ts).
const SITE_COOKIES = sameSiteCookieClause();

/**
 * The rules of the options that open the network, as the schema runs them in a build that has the network modes
 * (config-schema.ts, readOf): never in sealed mode, whose config names neither option (readIn).
 */
export const NETWORK_RULES = {
    // parsed for the mode the build will have, so strict mode drops `scripts`; a value that cannot be read refuses
    // the config (origins.ts)
    origins: ({ given, mode, warn, host }: OptionInput) => limitHostReach(parseOrigins(given, mode, warn), host(), warn, mode),
    fetchBridge: ({ given, warn, host }: OptionInput) => toFetchPolicy(given, warn, host().hostOrigin),
} as const;

/**
 * The host page as those rules read it (config-schema.ts, NormaliseContext), read only when one asks: sealed mode runs
 * neither (readIn), so a sealed config reads nothing of it.
 */
export const readHostPage = (): NormaliseContext => ({ hostOrigin: hostPageOrigin(), hostSites: hostSiteOrigins() });

/** What the reason of a refused config says after the error's name: which `origins` list could not be read (origins.ts). */
export { refusalDetail };

// How much a call measures besides the bytes it carries, at most, for the two calls whose payload `fetchBridge` bounds: a
// sandboxFetch() request (its URL, at most MAX_URL characters measured two bytes each, and its method and a few header
// names) and a sandboxFetch() result (the URL, the status text and the response's headers, which the browser bounds:
// Chromium at 256 KiB, measured twice that).
const FETCH_REQUEST_OVERHEAD = 64 * 1024;
const FETCH_RESULT_OVERHEAD = 1024 * 1024;

// An invariant of the fetch bridge's policy, which holds for a config with the bridge off.
const bridge = (holds: (policy: FetchPolicy, callBudget: Readonly<CallBudget>, warnings: readonly string[]) => boolean): ConfigInvariant['holds'] =>
    ({ fetchPolicy, callBudget }, warnings) => fetchPolicy === null || holds(fetchPolicy as FetchPolicy, callBudget, warnings);

/** The cross-field invariants of `fetchBridge`, over the normalised result, as CONFIG_INVARIANTS states the others. */
export const FETCH_BRIDGE_INVARIANTS: readonly ConfigInvariant[] = [
    {
        name: 'fetchBridge: every budget admits a request (maxBytes, timeoutMs, maxConcurrent are whole numbers >= 1)',
        holds: bridge(policy => [policy.maxBytes, policy.timeoutMs, policy.maxConcurrent].every(value => Number.isInteger(value) && value >= 1)),
    },
    {
        name: 'fetchBridge: a response of maxBytes fits one call result (RPC_MAX_BYTES), so a response the bridge admits is never refused as a result',
        holds: bridge(policy => policy.maxBytes + FETCH_RESULT_OVERHEAD <= RPC_MAX_BYTES),
    },
    {
        name: 'fetchBridge × callLimits: a request body of maxBytes (bytes) fits one call the budget carries, or the byte budget said which calls it refuses',
        holds: bridge((policy, callBudget, warnings) => policy.maxBytes + FETCH_REQUEST_OVERHEAD <= heaviestCall(callBudget) || warnings.some(message => message.includes(BELOW_LARGEST_CALL))),
    },
];

/** Every cross-field invariant of a configuration in a build with the network modes: the schema's, and the fetch bridge's. */
export const NETWORK_CONFIG_INVARIANTS: readonly ConfigInvariant[] = [...CONFIG_INVARIANTS, ...FETCH_BRIDGE_INVARIANTS];
