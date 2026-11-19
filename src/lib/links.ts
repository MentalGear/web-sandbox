/**
 * `links`, the embedder's list of URLs a click opens (design 02, "links: the user's click on a listed link opens it";
 * I6): the list's rules, read once by start() before anything is stored, and the host page's one way to turn the view's
 * request, an index, into a URL of that list.
 *
 * The guest never names a URL. The view marks an HTML `a` whose `href` is a listed URL character for character
 * (in-sandbox-view.ts, the renderer), the user's trusted click on a marked link is the request, and the view sends the
 * link's index in the list (VIEW_LINK). The host page checks that the index is an integer within this element's list
 * and opens its own copy of that URL (`listedLink`), so nothing of the guest's is part of the URL it opens.
 *
 * Host-side only, never stringified into a realm. The config schema turns a broken rule into start()'s refusal.
 */
import { createRateLimiter } from './rate-limit';

/** The most URLs `links` may list (design 02): an index of the list carries at most log₂(32) = 5 bits a user action. */
export const MAX_LINKS = 32;

/** The most characters of one URL of `links`, checked before it is parsed. */
export const MAX_LINK_LENGTH = 2048;

/**
 * The rules of `links`, in the order start() applies them, each with the words its refusal says (the reason
 * `linksRefused`, reasons.ts): the list's own, then each entry's, then the list's again over its entries. A list that
 * breaks one is refused whole, and nothing of it is stored.
 */
export const LINK_RULES = {
    list: 'it is not a list',
    count: `it lists more than ${MAX_LINKS} URLs`,
    string: 'an entry is not a string',
    length: `an entry is longer than ${MAX_LINK_LENGTH} characters`,
    parses: 'an entry does not parse as a URL',
    https: "an entry's scheme is not https:",
    credentials: 'an entry has a user name or a password',
    serialised: 'an entry is not equal to its own serialisation (new URL(entry).href)',
    distinct: 'two entries are equal',
} as const;
export type LinkRule = keyof typeof LINK_RULES;

/** No list: the default. */
export const NO_LINKS: readonly string[] = Object.freeze([]);

/** What reading `links` gives: the list, or the first rule it breaks. */
export type LinksRead = { readonly links: readonly string[] } | { readonly refused: LinkRule };

const parsed = (text: string): URL | null => {
    try {
        return new URL(text);
    } catch {
        return null;
    }
};

/** The rule one entry breaks, or null when it is a URL the list may hold. */
function entryRefusal(entry: unknown): LinkRule | null {
    if (typeof entry !== 'string') return 'string';
    if (entry.length > MAX_LINK_LENGTH) return 'length';
    const url = parsed(entry);
    if (url === null) return 'parses';
    if (url.protocol !== 'https:') return 'https';
    if (url.username !== '' || url.password !== '') return 'credentials';
    if (url.href !== entry) return 'serialised';
    return null;
}

/**
 * `links` as start() reads it (its copy, a structured clone): a frozen list of the URLs, in the embedder's order, or the
 * first rule of LINK_RULES it breaks. Left out, no list: no link opens. Every entry is checked before the list is
 * returned, so nothing of a list that fails is kept.
 */
export function readLinks(given: unknown): LinksRead {
    if (given === undefined) return { links: NO_LINKS };
    if (!Array.isArray(given)) return { refused: 'list' };
    if (given.length > MAX_LINKS) return { refused: 'count' };
    const links: string[] = [];
    for (let i = 0; i < given.length; i++) {
        const rule = entryRefusal(given[i]);
        if (rule !== null) return { refused: rule };
        links.push(given[i] as string);
    }
    if (new Set(links).size !== links.length) return { refused: 'distinct' };
    return { links: Object.freeze(links) };
}

/**
 * The URL the view's request names (VIEW_LINK's `index`), from this element's list: the list's own string when the
 * index is an integer within it, else null, and nothing opens. The index is the only thing of the view's it reads.
 */
export function listedLink(links: readonly string[], index: unknown): string | null {
    if (typeof index !== 'number' || !Number.isInteger(index)) return null;
    if (index < 0 || index >= links.length) return null;
    return links[index]!;
}

/**
 * The most tabs one element opens for its listed links in any one-second window, whatever the browser counts as a user
 * activation. A request past it opens nothing and is not queued.
 *
 * @remarks
 * The host page's own bound on `links`, beside the view's one request a user action: an engine may allow a tab for each
 * auto-repeated keydown of a held key (Firefox does, about 30 a second; docs/design/REVIEW-3.md, finding 1). Two, so that
 * what a user does on purpose still opens: a double click on a link (two clicks), or two links clicked one after the
 * other. Counted per element, for its life.
 */
export const LINK_TABS_PER_SECOND = 2;

/**
 * `admit()` says whether the element may open one more tab now: at most LINK_TABS_PER_SECOND in any one-second window,
 * a sliding window (rate-limit.ts). One per element, for its life: a reset or a new environment opens no new window.
 */
export function createLinkTabLimiter(now: () => number = () => performance.now()) {
    const limiter = createRateLimiter(LINK_TABS_PER_SECOND);
    return {
        admit: (): boolean => limiter.admit(now()),
    };
}

/** The features of the host page's `window.open` for a listed link: a new tab with no opener and no referrer. */
export const LINK_WINDOW_FEATURES = 'noopener,noreferrer';
