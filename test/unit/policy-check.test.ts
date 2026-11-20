import { describe, expect, it } from 'vitest';
import {
    ADMITTED_LOADS, admittedLoads, CANARY_DOMAIN, CANARY_SCHEMES, canaryUrl, POLICY_ATTRIBUTE, POLICY_CANARIES, POLICY_DIRECTIVES, POLICY_FINDINGS,
    policyCheckOptions, REFUSED_LOADS, refusedLoads, type PolicyCanaryRow,
} from '@src/lib/policy-check';
import { sealedDocument, sealedDocumentPolicy } from '@src/lib/sealed-document';
import { inSandboxView, VIEW_OPTIONS } from '@src/lib/in-sandbox-view';
import { policyFinding } from '@src/lib/startup-verdicts';
import { reasonText, TERMINATION_REASONS } from '@src/lib/reasons';

/**
 * The policy check's registry (policy-check.ts; design 03, "What the policy check provokes"; design 05, row 3.6; I18):
 * POLICY_CANARIES is derived from POLICY_DIRECTIVES, a row per directive of the file's `<meta>`, and the view's canaries
 * and the host's reading are derived from it. test/e2e/policy-check.spec.ts runs the check in the browsers, under each
 * kind of header on the file.
 */

const ROWS = Object.entries(POLICY_CANARIES) as [string, PolicyCanaryRow][];

/** The directive names of a policy text, in order. */
const directivesOf = (policy: string) => policy.split(';').map(part => part.trim().split(/\s+/)[0]!).filter(Boolean);

/** The keys of the object literal `const <name> … = {` in `source`, at its top level. */
function literalKeys(source: string, name: string): string[] {
    const start = source.indexOf(`const ${name}`);
    expect(start, name).toBeGreaterThan(-1);
    const open = source.indexOf('{', source.indexOf('=', start));
    const keys: string[] = [];
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        const char = source[i]!;
        if (char === '{' || char === '(' || char === '[') depth++;
        if (char === '}' || char === ')' || char === ']') depth--;
        if (depth === 0) break;
        if (depth !== 1) continue;
        const key = /^[\s,{]*([A-Za-z]\w*)\s*:/.exec(source.slice(i, i + 64));
        if (key && (char === '{' || char === ',')) keys.push(key[1]!);
    }
    return keys;
}

describe("POLICY_CANARIES against the <meta>'s text: every directive is classified", () => {
    it("the <meta>'s directives are exactly the registry's rows, in order: a directive added to the policy has its row, or this fails", () => {
        expect(directivesOf(sealedDocumentPolicy())).toEqual(Object.keys(POLICY_DIRECTIVES));
        expect(Object.keys(POLICY_CANARIES)).toEqual(Object.keys(POLICY_DIRECTIVES));
    });

    it('every row has an admitted canary, a refused one, or the reason it has none; a missing one is said', () => {
        for (const [directive, row] of ROWS) {
            if (row.admitted === null || row.refused === null) expect(row.why, directive).toBeTruthy();
            if (row.admitted === null && row.refused === null) expect(row.why!.length, directive).toBeGreaterThan(40);
        }
    });

    it("a directive whose `<meta>` source admits something has an admitted canary, and one whose source is 'none' none but the bootstrap", () => {
        for (const [directive, row] of ROWS) {
            const sources = POLICY_DIRECTIVES[directive as keyof typeof POLICY_DIRECTIVES].sources as readonly unknown[];
            if (sources.includes('blob:')) expect(row.admitted, directive).not.toBeNull();
            if (sources.length === 0) expect(row.admitted, directive).toBeNull();
        }
    });

    it("the directives with no refused canary, and why: research 31's three (manifest-src, form-action, default-src), script-src-attr, and object-src, whose load starts only while it is rendered", () => {
        expect(ROWS.filter(([, row]) => row.refused === null).map(([directive]) => directive)).toEqual(['default-src', 'script-src-attr', 'object-src', 'form-action', 'manifest-src']);
        expect(POLICY_CANARIES['object-src'].why).toMatch(/being rendered/);
        expect(POLICY_CANARIES['form-action'].why).toMatch(/Chromium/);
        expect(POLICY_CANARIES['worker-src'].refused).toBe('dataWorker');
    });

    it("what the check does not see is said for the five directives the renderer's rules close, and for script-src-attr", () => {
        const unseen = ROWS.filter(([, row]) => row.unseen !== undefined).map(([directive]) => directive);
        expect(unseen.sort()).toEqual(['font-src', 'form-action', 'frame-src', 'media-src', 'object-src', 'script-src-attr']);
    });
});

describe('the refused canaries: fixed URLs on a reserved name, one host per load and scheme, in both schemes', () => {
    it('each network URL is under .invalid, in http: and https:, and names its load and scheme in its host', () => {
        const hosts = new Set<string>();
        for (const load of REFUSED_LOADS) {
            if (load === 'dataWorker') continue;
            for (const scheme of CANARY_SCHEMES) {
                const url = new URL(canaryUrl(load, scheme));
                expect(url.protocol).toBe(`${scheme}:`);
                expect(url.hostname.endsWith(`.${CANARY_DOMAIN}`)).toBe(true);
                expect(url.hostname).toBe(`${load}-${scheme}.${CANARY_DOMAIN}`);
                hosts.add(url.hostname);
            }
        }
        expect(hosts.size).toBe((REFUSED_LOADS.length - 1) * CANARY_SCHEMES.length);
        expect(CANARY_DOMAIN.endsWith('.invalid')).toBe(true);
    });

    it("the registry's loads are the lists, and the view is given them with their URLs and hosts, the data: worker with none", () => {
        expect(refusedLoads().sort()).toEqual([...REFUSED_LOADS].sort());
        expect(admittedLoads().sort()).toEqual([...ADMITTED_LOADS].sort());
        const options = policyCheckOptions();
        expect(VIEW_OPTIONS.policy).toEqual(options);
        for (const canary of options.refused) {
            expect(canary.urls.map(entry => entry.host), canary.load).toEqual(canary.load === 'dataWorker' ? [] : CANARY_SCHEMES.map(scheme => `${canary.load}-${scheme}.${CANARY_DOMAIN}`));
        }
        expect(options.values.dataWorker.startsWith('data:')).toBe(true);
    });
});

describe("the view's canaries are the registry's: one table each, keyed by its loads", () => {
    it('the admitted and the refused tables of the check (inSandboxView, runPolicyCheck) have exactly the lists', () => {
        const source = inSandboxView.toString();
        expect(literalKeys(source, 'admittedCanaries').sort()).toEqual([...ADMITTED_LOADS].sort());
        expect(literalKeys(source, 'refusedCanaries').sort()).toEqual([...REFUSED_LOADS].sort());
    });

    it("the file states the <meta>'s text on its view's root element, the same text as F's policy", () => {
        const file = sealedDocument();
        const srcdoc = /srcdoc="([^"]*)"/.exec(file)![1]!.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
        const stated = new RegExp(`${POLICY_ATTRIBUTE}="([^"]*)"`).exec(srcdoc)![1];
        expect(stated).toBe(sealedDocumentPolicy());
    });
});

describe('the host reads the findings by its own registry (startup-verdicts.ts, policyFinding)', () => {
    it('each finding has its own reason, decided by the element, by the kind of header', () => {
        const rows = Object.values(POLICY_FINDINGS);
        expect(new Set(rows.map(row => row.reason)).size).toBe(rows.length);
        expect(rows.map(row => row.disposition)).toEqual(['enforce', 'report']);
        for (const row of rows) expect(TERMINATION_REASONS[row.reason].decidedBy).toBe('host');
        expect(TERMINATION_REASONS.viewCspReportOnly.text).toMatch(/Report-Only/);
    });

    it('all true: no finding; a missing, false or non-boolean one: the first such, in the registry\'s order; a verdict on the prototype is not read', () => {
        expect(policyFinding({ csp: true, cspReportOnly: true })).toBeNull();
        expect(policyFinding({ csp: true, cspReportOnly: false })).toBe(reasonText('viewCspReportOnly'));
        expect(policyFinding({ csp: 'true', cspReportOnly: false })).toBe(reasonText('viewCsp'));
        expect(policyFinding(null)).toBe(reasonText('viewCsp'));
        expect(policyFinding(Object.create({ csp: true, cspReportOnly: true }))).toBe(reasonText('viewCsp'));
    });
});
