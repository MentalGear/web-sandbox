import { describe, expect, it } from 'vitest';
import { ID_CITATION } from '../../docs/ids';
import { indexItems } from '../../tools/docgen/engine';
import { plugin } from '../../tools/docgen/docs';
import { METHOD_ORDER, methods, prose } from '../../tools/docgen/extractors/api';
import { ELEMENT_EVENTS } from '../../src/lib/element-events';

/**
 * The reference parts of docs/API.md that are rendered from the TSDoc of the public API (tools/docgen/extractors/api.ts):
 * how a doc's text becomes the page's, and that the page's order, events and items follow the code.
 */

describe('a TSDoc text as the page says it', () => {
    it('leaves out a citation in parentheses by itself, links an ADR, and turns {@link} into code', () => {
        expect(prose('Ends the sandbox (R1:R3-6), as the watchdog does (FR:F2, BL:B5).', 'x')).toBe('Ends the sandbox, as the watchdog does.');
        expect(prose('See ADR-006 and ADR-005#decision.', 'x')).toBe('See [ADR-006](ADR-006-fetch-bridge.md) and [ADR-005#decision](ADR-005-strict-mode.md#decision).');
        expect(prose('Like {@link WebSandbox.call}, or {@link SandboxState | the state}.', 'x')).toBe('Like `WebSandbox.call`, or the state.');
        expect(prose('See docs/API.md#host-page-policy.', 'x')).toBe('See [Host page policy](#host-page-policy).');
        expect(prose('Keeps (a note), and `call(x, y)`.', 'x')).toBe('Keeps (a note), and `call(x, y)`.');
    });

    it('fails on an ID cited any other way: a finding is not part of what holds now', () => {
        expect(() => prose('Fixed by R5:M-2 earlier.', 'WebSandbox.call')).toThrow(/WebSandbox\.call.*R5:M-2/);
        expect(() => prose('The cap holds (see S76).', 'x')).toThrow(/S76/); // a parenthesis with words in it is not a bare citation
        expect(() => prose('Because of LM-1 the record is final.', 'x')).toThrow(/LM-1/);
    });
});

describe('the rendered reference follows the code', () => {
    it('presents every public method of the element, in the page\'s order, and the order names no other', () => {
        expect(methods().map(method => method.name)).toEqual(METHOD_ORDER);
    });

    it('describes every exported name of the API model, and each member of a container, as an item a marker can name', () => {
        const items = indexItems(plugin);
        for (const id of ['api:WebSandbox', 'api:WebSandbox.setConfig', 'api:SandboxConfig', 'api:FetchRecord', 'api:SandboxLog.source', 'api:defineWebSandbox', 'api:viewScriptHash']) expect(items.has(id), id).toBe(true);
    });

    it('the events table has one row per event of the element, in the table of element-events.ts, with its bubbling from there', () => {
        const render = plugin.regions!['api-events']!();
        const rows = [...render.matchAll(/^\| `([\w-]+)` \| .*? \| (yes|no) \|/gm)].map(match => [match[1], match[2]]);
        expect(rows).toEqual(Object.entries(ELEMENT_EVENTS).map(([name, { bubbles }]) => [name, bubbles ? 'yes' : 'no']));
    });

    it('the inert types of a commit are rendered from the value that decides them', () => {
        const render = plugin.regions!['api-methods']!();
        expect(render).toContain('The inert types, exactly: `application/json`');
    });

    it('no generated region cites a finding or an item of the backlog: only an ADR, as a link', () => {
        for (const [name, render] of Object.entries(plugin.regions!).filter(([name]) => name.startsWith('api-'))) {
            const cited = (render().replace(/\[ADR-\d{3}[^\]]*\]\([^)]*\)/g, '').match(ID_CITATION) ?? []);
            expect(cited, name).toEqual([]);
        }
    });
});
