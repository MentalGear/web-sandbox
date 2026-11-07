import { describe, expect, it } from 'vitest';
import { SyntaxKind, tokenize } from '../../scripts/js-tokens';
import { GUEST_ENTRIES, GUEST_STATE, HOST_PASSES, LIBRARY_SINKS, PASS_RULES, hostPassRows, type HostPassId } from '@src/lib/host-passes';
import { graphOf, member, unitOf } from './call-graph';
import { guestContentUnits, isCode } from './guest-content-scan';

/**
 * The host realm's passes over guest content (HOST_PASSES, src/lib/host-passes.ts; S74, class A's third realm, BD7:LIM-1;
 * class E-cpu, BD7:LIM-2). Every function of the host realm that receives guest content is a row's, found from where the
 * content enters (GUEST_ENTRIES) through the call graph of src/; no platform parser, loader, policy-checked API or markup
 * sink is reachable from a row that a strict or sealed build runs, nor from the view's frame builders, but the library's
 * own documents (LIBRARY_SINKS). Each pure row's cost is linear: test/unit/host-passes-scaling.test.ts.
 */

const ROWS = hostPassRows();
const unitsOf = (rule?: string) => ROWS.filter(row => rule === undefined || row.rule === rule).flatMap(row => [...row.units]);
const rowOf = (unit: string) => ROWS.find(row => (row.units as readonly string[]).includes(unit));

// The platform names that parse markup or CSS into the host realm, load or run something, or write a sink the host page's
// policy checks: called or constructed anywhere (CALLED), or assigned (ASSIGNED: `x.srcdoc = …`).
const CALLED = new Set([
    'DOMParser', 'parseFromString', 'insertAdjacentHTML', 'createContextualFragment', 'setHTMLUnsafe', 'setHTML', 'parseHTMLUnsafe', 'writeln',
    'CSSStyleSheet', 'replaceSync', 'insertRule', 'adoptedStyleSheets', 'Image', 'Audio', 'fetch', 'XMLHttpRequest', 'sendBeacon', 'EventSource', 'WebSocket',
    'Worker', 'SharedWorker', 'importScripts', 'createHTML', 'createScript', 'createScriptURL', 'eval', 'setAttribute', 'setAttributeNS', 'createElement', 'createElementNS',
]);
const ASSIGNED = new Set(['innerHTML', 'outerHTML', 'srcdoc', 'src', 'href', 'cssText', 'textContent', 'action', 'data']);

/** The platform names of `CALLED` and `ASSIGNED` a unit's code uses, `document.write`, and `import(`. */
function platformNames(node: string): string[] {
    const tokens = tokenize(unitOf(node) ?? '');
    const found = new Set<string>();
    tokens.forEach((token, i) => {
        if (token.kind === SyntaxKind.ImportKeyword && tokens[i + 1]?.kind === SyntaxKind.OpenParenToken) found.add('import(');
        if (token.kind !== SyntaxKind.Identifier) return;
        if (CALLED.has(token.text)) found.add(token.text);
        const assigned = tokens[i + 1]?.kind === SyntaxKind.EqualsToken && tokens[i - 1]?.kind === SyntaxKind.DotToken;
        if (assigned && ASSIGNED.has(token.text)) found.add(token.text);
        if (token.text === 'write' && tokens[i - 1]?.kind === SyntaxKind.DotToken && tokens[i - 2]?.text === 'document') found.add('document.write');
    });
    return [...found].sort();
}

/** The units a unit's code calls, as the call graph has them, without the text it stringifies into another realm. */
function calls(node: string): string[] {
    const file = node.split('#')[0]!;
    const { units, imports } = graphOf(file);
    const tokens = tokenize(unitOf(node) ?? '');
    const found = new Set<string>();
    tokens.forEach((token, i) => {
        if (token.kind !== SyntaxKind.Identifier) return;
        if (tokens[i + 1]?.kind === SyntaxKind.DotToken && tokens[i + 2]?.text === 'toString') return;
        const before = tokens[i - 1]?.kind;
        if (before === SyntaxKind.DotToken || before === SyntaxKind.QuestionDotToken) {
            if (tokens[i - 2]?.kind === SyntaxKind.ThisKeyword && units.has(`this.${token.text}`)) found.add(`${file}#this.${token.text}`);
            return;
        }
        const target = units.has(token.text) ? `${file}#${token.text}` : imports.get(token.text);
        if (target && isCode(unitOf(target))) found.add(target);
    });
    return [...found];
}

/** Every unit of code reachable from `roots`, with the path that reached each; `step` hands the reducer an input and ends a path. */
function reachFrom(roots: readonly string[]): Map<string, string[]> {
    const paths = new Map<string, string[]>();
    const queue: [string, string[]][] = roots.map(root => [root, [root]]);
    while (queue.length > 0) {
        const [node, trail] = queue.shift()!;
        if (paths.has(node)) continue;
        paths.set(node, trail);
        if (node === 'src/host.ts#step') continue;
        for (const next of calls(node)) {
            if (node === DISPATCH.from && next === DISPATCH.to) continue; // the build's dispatch: see DISPATCH
            if (!paths.has(next)) queue.push([next, [...trail, next]]);
        }
    }
    return paths;
}

/** The platform names reachable from `roots` that no library sink admits, with the path to each. */
function platformReached(roots: readonly string[]): string[] {
    const out: string[] = [];
    for (const [node, trail] of reachFrom(roots)) {
        const admitted = (LIBRARY_SINKS as Record<string, { names: readonly string[] }>)[node]?.names ?? [];
        for (const name of platformNames(node)) if (!admitted.includes(name)) out.push(`${name} in ${trail.join(' → ')}`);
    }
    return out;
}

const VIEW_BUILDERS = ['src/host.ts#this._prepareViewFrame', 'src/host.ts#this._prepareSealedFrame'];

/**
 * The one edge from a row a strict or sealed build runs into cooperative mode's documented reading: the build's dispatch,
 * which returns the sealed and the strict frame before it, so a strict or sealed build never takes it (held below).
 */
const DISPATCH = { from: 'src/host.ts#this._prepareBuild', to: 'src/host.ts#this._prepareDocumentFrame' } as const;

describe('the registry is well formed', () => {
    it('every row says what it does, its modes, its cost and its rule; a documented row says why; every unit is code of the graph, in one row', () => {
        const seen = new Set<string>();
        for (const row of ROWS) {
            expect(row.does.length, row.id).toBeGreaterThan(20);
            expect(row.cost.length, row.id).toBeGreaterThan(5);
            expect(row.modes.length, row.id).toBeGreaterThan(0);
            expect(row.takes.length, row.id).toBeGreaterThan(0);
            expect(PASS_RULES, row.id).toContain(row.rule);
            if (row.rule === 'documented') expect(row.why?.length ?? 0, row.id).toBeGreaterThan(20);
            for (const unit of row.units) {
                expect(isCode(unitOf(unit)), `${row.id}: ${unit} is no function of the call graph`).toBe(true);
                expect(seen.has(unit), `${unit} is in two rows`).toBe(false);
                seen.add(unit);
            }
        }
        for (const unit of Object.keys(LIBRARY_SINKS)) expect(isCode(unitOf(unit)), unit).toBe(true);
    });
});

describe('every function of the host realm that receives guest content is a row of HOST_PASSES', () => {
    it("every member of the element that reads its guest state (GUEST_STATE) is an entry (GUEST_ENTRIES), and every entry is a member", () => {
        const { units } = graphOf('src/host.ts');
        const entries = GUEST_ENTRIES.map(entry => entry.member);
        const readers: string[] = [];
        for (const [name, text] of units) {
            if (!name.startsWith('this.')) continue;
            const chains = new Set<string>();
            const tokens = tokenize(text);
            tokens.forEach((token, i) => {
                if (token.kind !== SyntaxKind.ThisKeyword) return;
                let chain = 'this';
                for (let j = i + 1; j + 1 < tokens.length && (tokens[j]!.kind === SyntaxKind.DotToken || tokens[j]!.kind === SyntaxKind.QuestionDotToken); j += 2) {
                    chain += `.${tokens[j + 1]!.text}`;
                    chains.add(chain);
                }
            });
            if (GUEST_STATE.some(state => chains.has(state))) readers.push(name.slice('this.'.length));
        }
        expect(readers.filter(name => !entries.includes(name)).sort(), 'a member reads guest state: add it to GUEST_ENTRIES (host-passes.ts) with the names that hold it').toEqual([]);
        for (const entry of entries) expect(units.has(`this.${entry}`), entry).toBe(true);
    });

    it('every unit guest content reaches from the entries is a row\'s, and every row\'s unit is reached', () => {
        const reached = guestContentUnits(GUEST_ENTRIES);
        const listed = new Set(unitsOf());
        const unlisted = [...reached.values()].filter(({ unit }) => !listed.has(unit)).map(({ unit, trail }) => `${unit} (${trail.join(' → ')})`);
        expect(unlisted, 'a function receives guest content: give it a row of HOST_PASSES (host-passes.ts), or add it to the row of the pass it is part of').toEqual([]);
        expect([...listed].filter(unit => !reached.has(unit)), 'a row names a unit no guest content reaches').toEqual([]);
    });
});

describe("no platform parser, loader or markup sink is reachable from the host realm's passes, but the library's own documents", () => {
    it("positive control: the scan sees the documented parse of cooperative mode, and the base's warning, which read `html` with DOMParser", () => {
        expect(platformNames('src/lib/trusted-types.ts#parseInert')).toEqual(expect.arrayContaining(['DOMParser', 'parseFromString']));
        expect(platformReached(['src/host.ts#this._warnAboutNoScripts']).some(found => found.startsWith('DOMParser in '))).toBe(true);
        expect(platformReached(['src/lib/markup-references.ts#rewriteGuestMarkup']).some(found => found.startsWith('DOMParser in '))).toBe(true);
    });

    it("the view's frame builders (_prepareViewFrame, _prepareSealedFrame) reach none (BD7:LIM-1)", () => {
        expect(platformReached(VIEW_BUILDERS)).toEqual([]);
        const documented = new Set(unitsOf('documented'));
        expect([...reachFrom(VIEW_BUILDERS).keys()].filter(unit => documented.has(unit)), 'a strict or sealed build reaches cooperative mode\'s documented parse').toEqual([]);
    });

    it.each(ROWS.filter(row => row.rule !== 'documented').map(row => [row.id, row] as const))('%s reaches none', (_, row) => {
        expect(platformReached(row.units)).toEqual([]);
        const documented = new Set(unitsOf('documented'));
        expect([...reachFrom(row.units).keys()].filter(unit => documented.has(unit))).toEqual([]);
    });

    it("the library's own documents: the view's wrapper is built from the policy and the bootstrap alone, and the guest's markup, entry and files go to the view in INIT_VIEW", () => {
        const body = member('_prepareViewFrame');
        expect(body).toMatch(/const view = buildViewDocument\(policy, viewBootstrapText\(\)\);/);
        expect(body).toMatch(/setLibrarySrcdoc\(iframe, buildWrapperDocument\(view, sandboxFlags, \[\]\)\);/);
        expect(body.match(/setLibrarySrcdoc\(/g)).toHaveLength(1);
        // `html` and the worker's source are fields of the view's init, and nothing else names them
        expect([...body.matchAll(/\bhtml\b/g)].length).toBe(3); // its declaration, its default, and the init's `html,`
        expect(body).toMatch(/\n\s+html,\n/);
        const policies = [member('_prepareSealedFrame'), member('_prepareStrictFrame')].map(text => /this\._prepareViewFrame\(built, files, (this\._\w+)\(files(?:, [\w.]+)?\), /.exec(text)?.[1]);
        expect(policies).toEqual(['this._sealedPolicy', 'this._guestPolicy']);
        // the build's dispatch: the sealed frame, then the strict frame, are returned before the document frame (DISPATCH)
        expect(member('_prepareBuild')).toMatch(/if \(this\._config\.mode === 'sealed'\) \{\s*this\._refuseByTrustedTypes\(\);\s*return this\._prepareSealedFrame\(built, files\);\s*\}[\s\S]*if \(this\._config\.mode === 'strict'\) return this\._prepareStrictFrame\(built, files, reach\);\s*return this\._prepareDocumentFrame\(built, files, reach\);\s*$/);
        expect(member('_prepareBuild').match(/_prepareDocumentFrame\(/g)).toHaveLength(1);
        const policyRow: HostPassId = 'policyFromKinds';
        for (const unit of ['src/host.ts#this._sealedPolicy', 'src/host.ts#this._guestPolicy']) expect(rowOf(unit)?.id, unit).toBe(policyRow);
    });
});
