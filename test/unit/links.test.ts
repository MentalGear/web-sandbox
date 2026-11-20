import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinkTabLimiter, LINK_ACTIVATION_POLL_MS, LINK_ACTIVATION_WAIT_MS, LINK_RULES, LINK_TABS_PER_SECOND, LINK_WINDOW_FEATURES, listedLink, MAX_LINK_LENGTH, MAX_LINKS, openWhenActivated, readLinks, type LinkRule } from '@src/lib/links';
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
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, 'userActivation');
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
        defineWebSandbox({ documentUrl: '/sealed-document.html' });
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

    // The host page's own bound (docs/design/REVIEW-3.md, finding 1): whatever the browser counts as an activation, one
    // element opens at most LINK_TABS_PER_SECOND tabs in any one-second window; a request past it opens nothing, later.
    it(`at most LINK_TABS_PER_SECOND (${LINK_TABS_PER_SECOND}) tabs in any one-second window, by a fake clock; one past it opens nothing and is not queued`, () => {
        let now = 10_000;
        const limiter = createLinkTabLimiter(() => now);
        const admitted: number[] = [];
        // 30 requests a second, a key repeat's rate, for two seconds
        for (let i = 0; i < 60; i++, now += 1000 / 30) if (limiter.admit()) admitted.push(Math.round(now - 10_000));
        expect(LINK_TABS_PER_SECOND).toBe(2);
        expect(admitted).toEqual([0, 33, 1000, 1033]);
        // any one-second window holds at most the bound (the sliding window of rate-limit.ts)
        for (const start of admitted) expect(admitted.filter(t => t >= start && t < start + 1000).length).toBeLessThanOrEqual(LINK_TABS_PER_SECOND);
        // a double click (two clicks 200 ms apart), a second after the last: both open
        now += 1000;
        expect([limiter.admit(), (now += 200, limiter.admit())]).toEqual([true, true]);
    });

    it('a held key\'s ten requests within a second open LINK_TABS_PER_SECOND tabs at the element, and nothing later; a request after the window opens again', async () => {
        let now = 50_000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { el, view, open } = await element([A, B]);
        for (let i = 0; i < 10; i++, now += 33) el._onViewMessage(view, { type: 'VIEW_LINK', index: i % 2 });
        expect(open.mock.calls).toEqual([[A, '_blank', 'noopener,noreferrer'], [B, '_blank', 'noopener,noreferrer']]);
        now += 1000;
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(open).toHaveBeenCalledTimes(2); // nothing was queued
        el._onViewMessage(view, { type: 'VIEW_LINK', index: 1 });
        expect(open).toHaveBeenCalledTimes(3);
        view.close();
    });

    it('the bound is the element\'s for its life: a reset opens no new window', async () => {
        let now = 70_000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { el, view: old, open } = await element([A]);
        el._onViewMessage(old, { type: 'VIEW_LINK', index: 0 });
        el._onViewMessage(old, { type: 'VIEW_LINK', index: 0 });
        el.reset();
        const current = new MessageChannel().port1;
        el._viewPort = current;
        el._onViewMessage(current, { type: 'VIEW_LINK', index: 0 });
        expect(open).toHaveBeenCalledTimes(2);
        now += 1000;
        el._onViewMessage(current, { type: 'VIEW_LINK', index: 0 });
        expect(open).toHaveBeenCalledTimes(3);
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

/**
 * The click is in the view, another process on Chromium, and the browser tells the host page of the activation on a
 * channel of its own: the view's request can arrive first, and a tab asked for then is blocked as one with no click
 * (test/e2e/links-popup-blocker.spec.ts saw `window.open` called and no tab). Where the page reads its activation as
 * not active, the request waits for it, at most LINK_ACTIVATION_WAIT_MS.
 */
describe("the tab is asked for once the page has the click's activation (openWhenActivated)", () => {
    it('at once where the page cannot read its activation, and where it reads it active: no timer is made', () => {
        vi.useFakeTimers();
        for (const activation of [undefined, { isActive: true }]) {
            const open = vi.fn();
            openWhenActivated(activation, open);
            expect(open).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    it('not active yet: nothing is asked in that task; the tab is asked for at the first reading that is active, once, and no reading follows', () => {
        vi.useFakeTimers();
        const activation = { isActive: false };
        const open = vi.fn();
        openWhenActivated(activation, open);
        expect(open).not.toHaveBeenCalled();
        vi.advanceTimersByTime(3 * LINK_ACTIVATION_POLL_MS);
        expect(open).not.toHaveBeenCalled();
        activation.isActive = true;
        vi.advanceTimersByTime(LINK_ACTIVATION_POLL_MS);
        expect(open).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(2 * LINK_ACTIVATION_WAIT_MS);
        expect(open).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it(`never active: the tab is asked for after LINK_ACTIVATION_WAIT_MS (${LINK_ACTIVATION_WAIT_MS} ms), once, and the browser decides`, () => {
        vi.useFakeTimers();
        const open = vi.fn();
        openWhenActivated({ isActive: false }, open);
        vi.advanceTimersByTime(LINK_ACTIVATION_WAIT_MS - LINK_ACTIVATION_POLL_MS);
        expect(open).not.toHaveBeenCalled();
        vi.advanceTimersByTime(LINK_ACTIVATION_POLL_MS);
        expect(open).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(LINK_ACTIVATION_WAIT_MS);
        expect(open).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    // the element, on a page whose activation the test sets
    async function waiting(links: readonly string[]) {
        const el = await mountApp({ links });
        const view = new MessageChannel().port1;
        el._viewPort = view;
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        const activation = { isActive: false };
        Object.defineProperty(navigator, 'userActivation', { configurable: true, value: activation });
        vi.useFakeTimers();
        return { el, view, open, activation };
    }

    it("the element's request on a page that reads no activation yet: no window.open in the task of the frame, and one for the listed URL once the page reads it", async () => {
        const { el, view, open, activation } = await waiting([A, B]);
        el._onViewMessage(view, { type: 'VIEW_LINK', index: 1 });
        expect(open).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2 * LINK_ACTIVATION_POLL_MS);
        expect(open).not.toHaveBeenCalled();
        activation.isActive = true;
        vi.advanceTimersByTime(LINK_ACTIVATION_POLL_MS);
        expect(open.mock.calls).toEqual([[B, '_blank', LINK_WINDOW_FEATURES]]);
        vi.advanceTimersByTime(2 * LINK_ACTIVATION_WAIT_MS);
        expect(open).toHaveBeenCalledTimes(1);
        view.close();
    });

    it('a request that is waiting when its environment ends opens nothing, then or later', async () => {
        const { el, view, open, activation } = await waiting([A]);
        el._onViewMessage(view, { type: 'VIEW_LINK', index: 0 });
        el.terminate();
        activation.isActive = true;
        vi.advanceTimersByTime(2 * LINK_ACTIVATION_WAIT_MS);
        expect(open).not.toHaveBeenCalled();
        view.close();
    });

    it('a request that waits is counted when it arrives: LINK_TABS_PER_SECOND of them wait, and one more in the same second is dropped', async () => {
        const { el, view, open, activation } = await waiting([A]);
        for (let i = 0; i < LINK_TABS_PER_SECOND + 1; i++) el._onViewMessage(view, { type: 'VIEW_LINK', index: 0 });
        activation.isActive = true;
        vi.advanceTimersByTime(LINK_ACTIVATION_POLL_MS);
        expect(open).toHaveBeenCalledTimes(LINK_TABS_PER_SECOND);
        view.close();
    });
});
