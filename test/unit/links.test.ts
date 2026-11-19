import { afterEach, describe, expect, it, vi } from 'vitest';
import { LINK_RULES, LINK_WINDOW_FEATURES, listedLink, MAX_LINK_LENGTH, MAX_LINKS, readLinks, type LinkRule } from '@src/lib/links';
import { CONFIG_SCHEMA, normaliseConfig, NO_HOST_PAGE } from '@src/lib/config-schema';
import { fixedDetail, reasonText, TERMINATION_REASONS } from '@src/lib/reasons';
import { FRAMES } from '@src/lib/frames';
import { mountApp } from './start-app';

/**
 * `links` (design 02, "links: the user's click on a listed link opens it"; I6), the host page's half: the list's rules,
 * read once by start() (every refusal, each with its reason, and nothing of a refused list kept), and the view's request
 * as the host takes it (an integer index within the element's own list, from the current view's port only, opening that
 * list's string with no opener and no referrer). The view's half is test/unit/view-links.test.ts; the browsers', with
 * their popup blockers on, test/e2e/links.spec.ts and test/e2e/links-popup-blocker.spec.ts.
 */

const A = 'https://docs.example.com/guide';
const B = 'https://help.example.org/a?b=c#d';

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('the list (readLinks): every rule, in order', () => {
    // [rule, a list that breaks it and no rule before it]
    const BROKEN: readonly [LinkRule, unknown][] = [
        ['list', 'https://docs.example.com/guide'],
        ['list', { 0: A, length: 1 }],
        ['list', null],
        ['count', Array.from({ length: MAX_LINKS + 1 }, (_, i) => `https://example.com/${i}`)],
        ['string', [A, 5]],
        ['string', [null]],
        ['string', [new String(A)]],
        // eslint-disable-next-line no-sparse-arrays
        ['string', [A, , B]],
        ['length', [`https://example.com/${'a'.repeat(MAX_LINK_LENGTH)}`]],
        ['parses', ['docs.example.com/guide']],
        ['parses', ['https://exa mple.com/']],
        ['https', ['http://docs.example.com/guide']],
        ['https', ['javascript:alert(1)']],
        ['https', ['data:text/html,x']],
        ['https', ['wss://docs.example.com/']],
        ['https', ['blob:https://docs.example.com/uuid']],
        ['credentials', ['https://user@docs.example.com/']],
        ['credentials', ['https://user:pass@docs.example.com/']],
        ['credentials', ['https://:pass@docs.example.com/']],
        ['serialised', ['https://docs.example.com']],
        ['serialised', ['https://Docs.Example.com/guide']],
        ['serialised', ['HTTPS://docs.example.com/guide']],
        ['serialised', ['https://docs.example.com:443/guide']],
        ['serialised', ['https://docs.example.com/a b']],
        ['serialised', [' https://docs.example.com/guide']],
        ['serialised', ['https://docs.example.com/./guide']],
        ['distinct', [A, B, A]],
    ];

    it.each(BROKEN.map(([rule, given], i) => [`${rule} #${i}`, rule, given] as const))('%s: refused with that rule, and nothing kept', (_name, rule, given) => {
        expect(readLinks(given)).toEqual({ refused: rule });
    });

    it('every rule has a refusal here, and each says what it checks in the library\'s words', () => {
        expect(new Set(BROKEN.map(([rule]) => rule))).toEqual(new Set(Object.keys(LINK_RULES)));
        for (const words of Object.values(LINK_RULES)) expect(words.length).toBeGreaterThan(10);
    });

    it(`a list of ${MAX_LINKS} URLs, each ${MAX_LINK_LENGTH} characters at most and its own serialisation, is kept, frozen, in its order; none is no list`, () => {
        const longest = `https://example.com/${'a'.repeat(MAX_LINK_LENGTH - 'https://example.com/'.length)}`;
        expect(longest.length).toBe(MAX_LINK_LENGTH);
        const list = [longest, ...Array.from({ length: MAX_LINKS - 1 }, (_, i) => `https://example.com/${i}`)];
        const read = readLinks(list);
        expect(read).toEqual({ links: list });
        expect(Object.isFrozen((read as { links: readonly string[] }).links)).toBe(true);
        expect((read as { links: readonly string[] }).links).not.toBe(list);
        expect(readLinks([B, A])).toEqual({ links: [B, A] });
        expect(readLinks(undefined)).toEqual({ links: [] });
        expect(readLinks([])).toEqual({ links: [] });
        expect(MAX_LINKS).toBe(32);
    });
});

describe('start() reads it (CONFIG_SCHEMA.links)', () => {
    it("a list that breaks a rule is start()'s TypeError with the reason linksRefused and the rule's words, never the URL; the element stays as new", async () => {
        expect(TERMINATION_REASONS.linksRefused.decidedBy).toBe('start');
        const hostile = 'javascript:alert("<img src=x onerror=1>")';
        let caught: unknown;
        const { defineWebSandbox } = await import('@src/host');
        defineWebSandbox();
        const fresh = document.createElement('web-sandbox') as any;
        document.body.appendChild(fresh);
        try {
            fresh.start({}, { links: [A, hostile] });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TypeError);
        expect((caught as Error).message).toBe(`[Sandbox] start(): ${reasonText('linksRefused', fixedDetail(LINK_RULES.https))}.`);
        expect((caught as Error).message).not.toContain('javascript');
        expect([fresh.started, fresh.state]).toEqual([false, 'idle']);
        fresh.start({}, { links: [A] }); // a corrected list starts the same element
        expect(fresh.started).toBe(true);
    });

    it('the stored list is a copy of what was given: a later change of the embedder\'s array changes nothing', async () => {
        const given = [A];
        const el = await mountApp({ links: given });
        given.push(B);
        given[0] = 'https://elsewhere.example/';
        expect(el._config.links).toEqual([A]);
        expect(el._strictInit.links).toEqual([A]);
    });

    it('sealed mode reads it, and INIT_VIEW gives the view the list; left out, the view gets none', async () => {
        expect(CONFIG_SCHEMA.links.modes).toEqual(['strict', 'sealed']);
        expect((await mountApp({ links: [A, B] }))._strictInit.links).toEqual([A, B]);
        expect((await mountApp({}))._strictInit.links).toEqual([]);
        expect(Object.keys(FRAMES.INIT_VIEW.fields)).toContain('links');
    });

    it('the lenient reading refuses a broken list too (a throw of a rule refuses the config)', () => {
        const { value, refusal } = normaliseConfig({ links: ['http://x.example/'] }, NO_HOST_PAGE);
        expect(value).toBeNull();
        expect((refusal as Error).message).toBe(reasonText('linksRefused', fixedDetail(LINK_RULES.https)));
    });
});

describe("the view's request at the host (VIEW_LINK, listedLink)", () => {
    it('opens the list\'s own string only for an integer index within it', () => {
        const links = Object.freeze([A, B]);
        expect([listedLink(links, 0), listedLink(links, 1), listedLink(links, -0)]).toEqual([A, B, A]);
        for (const index of [2, -1, 1.5, Number.NaN, Infinity, -Infinity, '0', '1', null, undefined, true, [0], { valueOf: () => 0 }, 0n, 2 ** 53]) {
            expect(listedLink(links, index), String(index)).toBeNull();
        }
        expect(listedLink([], 0)).toBeNull();
        expect(FRAMES.VIEW_LINK.fields).toEqual({ index: expect.objectContaining({ bound: 'not a string' }) });
        expect(LINK_WINDOW_FEATURES).toBe('noopener,noreferrer');
    });

    // The element, started with links, its view port standing in for the view's; window.open spied on.
    async function element(links: readonly string[]) {
        const el = await mountApp({ links });
        const view = new MessageChannel().port1;
        el._viewPort = view;
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        return { el, view, open };
    }

    it('a VIEW_LINK of the current view opens links[index] in a new tab, with no opener and no referrer, in the task of the frame', async () => {
        const { el, view, open } = await element([A, B]);
        el._onViewMessage(view, { type: 'VIEW_LINK', index: 1 });
        expect(open.mock.calls).toEqual([[B, '_blank', 'noopener,noreferrer']]);
        el._onViewMessage(view, { type: 'VIEW_LINK', index: 0 });
        expect(open.mock.calls[1]).toEqual([A, '_blank', 'noopener,noreferrer']);
        view.close();
    });

    it('nothing opens for a non-integer or out-of-range index, or for a frame that carries a URL in place of one', async () => {
        const { el, view, open } = await element([A]);
        for (const index of [1, -1, 0.5, '0', null, undefined, NaN, A, { toString: () => '0' }]) el._onViewMessage(view, { type: 'VIEW_LINK', index });
        el._onViewMessage(view, { type: 'VIEW_LINK', url: 'https://attacker.example/' });
        el._onViewMessage(view, { type: 'VIEW_LINK', index: 0, url: 'https://attacker.example/' });
        expect(open.mock.calls).toEqual([[A, '_blank', 'noopener,noreferrer']]); // the last one: its index, never its url
        view.close();
    });

    it('a VIEW_LINK forged on the logic port (the guest worker\'s only port) opens nothing', async () => {
        const { el, view, open } = await element([A]);
        const logic = new MessageChannel().port1;
        el._port = logic;
        const reply = vi.fn();
        el._onGuestMessage(logic, reply, { type: 'VIEW_LINK', index: 0 }, 'logic');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(open).not.toHaveBeenCalled();
        // positive control: the same frame on the view port opens it
        el._onViewMessage(view, { type: 'VIEW_LINK', index: 0 });
        expect(open).toHaveBeenCalledTimes(1);
        logic.close();
        view.close();
    });

    it('a VIEW_LINK from the view port of an earlier environment opens nothing', async () => {
        const { el, view: old, open } = await element([A]);
        el.reset(); // the environment that port belonged to is gone
        const current = new MessageChannel().port1;
        el._viewPort = current;
        el._onViewMessage(old, { type: 'VIEW_LINK', index: 0 });
        expect(open).not.toHaveBeenCalled();
        el._onViewMessage(current, { type: 'VIEW_LINK', index: 0 });
        expect(open).toHaveBeenCalledTimes(1);
        old.close();
        current.close();
    });

    it('an element with no links opens nothing for any index', async () => {
        const { el, view, open } = await element([]);
        for (const index of [0, 1, 31]) el._onViewMessage(view, { type: 'VIEW_LINK', index });
        expect(open).not.toHaveBeenCalled();
        view.close();
    });
});
