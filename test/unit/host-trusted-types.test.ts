import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildRefused, executeRefused, trustedTypesStance, TRUSTED_TYPES_RULES, type TrustedTypesMode } from '@src/lib/csp/host-trusted-types';
import { TRUSTED_TYPES_POLICY } from '@src/lib/trusted-types';

/**
 * The host page's Trusted Types directives as the library reads them where the browser has none (src/lib/csp/host-trusted-types.ts):
 * the grammar as a table of rules (TRUSTED_TYPES_RULES), every example of every rule asserted, and a property per rule over
 * generated policies. The e2e twin (test/e2e/trusted-types-uniform.spec.ts) runs the same table in all three engines and
 * asserts that the browsers that have Trusted Types agree with it.
 */

const stance = (policy: string) => trustedTypesStance(policy, TRUSTED_TYPES_POLICY);
const ends = (policy: string, mode: TrustedTypesMode) => buildRefused(stance(policy), mode);

describe('TRUSTED_TYPES_RULES: every example of every rule', () => {
    for (const rule of TRUSTED_TYPES_RULES) {
        it.each(rule.examples.map(example => [...example]))(`${rule.source}: %s`, (policy, strictAndWorker, cooperative, execute) => {
            const text = policy as string;
            expect(ends(text, 'strict') ? 'ends' : 'ready', 'strict').toBe(strictAndWorker);
            expect(ends(text, 'worker') ? 'ends' : 'ready', 'worker').toBe(strictAndWorker);
            expect(ends(text, 'cooperative') ? 'ends' : 'ready', 'cooperative').toBe(cooperative);
            expect(executeRefused(stance(text)) ? 'refused' : 'runs', 'execute()').toBe(execute);
        });
    }

    it('every rule has examples, and the table has an example of each outcome', () => {
        const outcomes = new Set<string>();
        for (const rule of TRUSTED_TYPES_RULES) {
            expect(rule.examples.length, rule.source).toBeGreaterThan(0);
            for (const [, strict, cooperative, execute] of rule.examples) { outcomes.add(`strict ${strict}`); outcomes.add(`cooperative ${cooperative}`); outcomes.add(`execute ${execute}`); }
        }
        expect(outcomes).toEqual(new Set(['strict ends', 'strict ready', 'cooperative ends', 'cooperative ready', 'execute refused', 'execute runs']));
    });
});

// Where the engines differ the library follows the specification, so the rule has no row in TRUSTED_TYPES_RULES (the e2e twin
// asserts the browsers against that table): these are the library's own decisions, held here (BD3:TST-9).
describe('where the browsers differ the library follows the specification (BD3:TST-9)', () => {
    it("the keyword's case folds: 'SCRIPT' and 'Script' require Trusted Types for scripts, so execute() is refused", () => {
        for (const keyword of ["'SCRIPT'", "'Script'", "'script'"]) {
            expect(stance(`require-trusted-types-for ${keyword}`).requires, keyword).toBe(true);
            expect(executeRefused(stance(`require-trusted-types-for ${keyword}`)), keyword).toBe(true);
        }
        expect(stance("require-trusted-types-for 'style'").requires).toBe(false);
    });

    it('a directive named twice counts the first time: require-trusted-types-for and trusted-types', () => {
        expect(stance("require-trusted-types-for 'style'; require-trusted-types-for 'script'").requires).toBe(false);
        expect(stance("require-trusted-types-for 'script'; require-trusted-types-for 'style'").requires).toBe(true);
        expect(stance("require-trusted-types-for 'script'; trusted-types other; trusted-types web-sandbox").admitsName).toBe(false);
        expect(stance("require-trusted-types-for 'script'; trusted-types web-sandbox; trusted-types other").admitsName).toBe(true);
    });

    it("a list that allows any policy (*) names `default` too: the page may have made a default policy that takes the element's strings", () => {
        expect(stance("require-trusted-types-for 'script'; trusted-types *").namesDefault).toBe(true);
        expect(stance("require-trusted-types-for 'script'; trusted-types default").namesDefault).toBe(true);
        expect(stance("require-trusted-types-for 'script'; trusted-types other").namesDefault).toBe(false);
        // and so cooperative mode is not ended by a list that names neither the policy nor *, once it names default
        expect(ends("require-trusted-types-for 'script'; trusted-types default", 'cooperative')).toBe(false);
        expect(ends("require-trusted-types-for 'script'; trusted-types default", 'strict')).toBe(true);
    });
});

describe('the properties of the rules', () => {
    const names = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/).filter(name => name !== TRUSTED_TYPES_POLICY && name !== 'default');
    const lists = fc.array(names, { maxLength: 4 });

    it('a page that does not require Trusted Types for scripts ends nothing and refuses nothing, whatever its trusted-types list says', () => {
        fc.assert(fc.property(lists, fc.boolean(), (list, withDefault) => {
            const policy = `trusted-types ${[...list, ...(withDefault ? ['default'] : [])].join(' ')}`;
            for (const mode of ['strict', 'cooperative', 'worker'] as const) expect(ends(policy, mode)).toBe(false);
            expect(executeRefused(stance(policy))).toBe(false);
        }));
    });

    it('with the requirement, a list that names the policy or * never ends the build, wherever the name stands and whatever else is listed', () => {
        fc.assert(fc.property(lists, lists, fc.constantFrom(TRUSTED_TYPES_POLICY, '*'), (before, after, token) => {
            const policy = `require-trusted-types-for 'script'; trusted-types ${[...before, token, ...after].join(' ')}`;
            for (const mode of ['strict', 'cooperative', 'worker'] as const) expect(ends(policy, mode)).toBe(false);
        }));
    });

    it('with the requirement, a list that names neither always ends strict and worker mode, and ends cooperative mode unless it names default', () => {
        fc.assert(fc.property(lists, fc.boolean(), (list, withDefault) => {
            const policy = `require-trusted-types-for 'script'; trusted-types ${[...list, ...(withDefault ? ['default'] : [])].join(' ')}`;
            expect(ends(policy, 'strict')).toBe(true);
            expect(ends(policy, 'worker')).toBe(true);
            expect(ends(policy, 'cooperative')).toBe(!withDefault);
        }));
    });

    it('a policy list ends the build when any of its policies does: adding a policy never admits what the others refuse', () => {
        fc.assert(fc.property(lists, lists, (first, second) => {
            const one = `require-trusted-types-for 'script'; trusted-types ${first.join(' ')}`;
            const two = `trusted-types ${second.join(' ')}`;
            for (const mode of ['strict', 'cooperative', 'worker'] as const) {
                if (ends(one, mode)) expect(ends(`${one}, ${two}`, mode), mode).toBe(true);
            }
            expect(executeRefused(stance(`${one}, ${two}`))).toBe(true);
        }));
    });

    it('text it does not understand changes nothing: no requirement is read from it, and a list of an unknown kind refuses the name', () => {
        for (const policy of ['', ';;;', 'garbage', "require-trusted-types-for script", 'require-trusted-types-for', 'trusted-types']) {
            expect(executeRefused(stance(policy)), policy).toBe(false);
            for (const mode of ['strict', 'cooperative', 'worker'] as const) expect(ends(policy, mode), `${policy} ${mode}`).toBe(false);
        }
        expect(trustedTypesStance([], TRUSTED_TYPES_POLICY)).toEqual({ requires: false, admitsName: true, namesDefault: true });
    });

    it('policies as a list of texts (what a violation reports) read the same as one string with commas', () => {
        const texts = ["require-trusted-types-for 'script'", 'trusted-types other'];
        expect(trustedTypesStance(texts, TRUSTED_TYPES_POLICY)).toEqual(trustedTypesStance(texts.join(', '), TRUSTED_TYPES_POLICY));
    });
});
