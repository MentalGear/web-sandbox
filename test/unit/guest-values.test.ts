import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDS, type Build } from '@src/lib/build-flag';
import { ELEMENT_EVENTS } from '@src/lib/element-events';
import { GUEST_VALUE_OWNERS, GUEST_VALUES, guestValueDeclarations, type GuestValue, type GuestValueDeclaration, type GuestValueRow } from '@src/lib/guest-values';

/**
 * The values the public API hands the embedder, against each build's API report (design 02): a value of the guest's
 * that the library does not check is `unknown` in the report, and no type parameter lets a caller assert a type nothing
 * checks ("`unknown` for guest values"); and every declaration, member, return value and event detail field of each
 * report has its row in GUEST_VALUES (src/lib/guest-values.ts; "One registry of guest values", I10), as
 * test/unit/app-surface.test.ts holds APP_SURFACE to the element's members.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORTS: Record<Build, string> = { default: 'etc/web-sandbox.api.md', network: 'etc/web-sandbox.network.api.md' };
const readReport = (build: Build) => readFileSync(path.join(ROOT, REPORTS[build]), 'utf8').replace(/\r\n/g, '\n');

describe('a guest value the library does not check is unknown in the API report, with no type parameter', () => {
    // [the report's line, as it must read]
    const UNKNOWN: readonly string[] = [
        '    call(method: string, ...args: unknown[]): Promise<unknown>;',
        '    callWithTimeout(timeoutMs: number, method: string, ...args: unknown[]): Promise<unknown>;',
        'export type HostMethod = (...args: unknown[]) => unknown;',
        '    args: readonly unknown[];',
    ];

    it.each(BUILDS)('the %s build', (build) => {
        const report = readReport(build);
        for (const line of UNKNOWN) expect(report.split('\n'), line).toContain(line);
        expect(report).not.toMatch(/\bcall(?:WithTimeout)?</);
    });
});

// ---- GUEST_VALUES (I10): every declaration of each report, and every member of what is handed over

/** A declaration of a report: its name, whether it is a block with members (an interface, a class, an object type), and those members. */
interface Declaration {
    readonly name: string;
    readonly block: boolean;
    readonly members: string[];
}

/** The member a line of a block declares: its indent, its name, and whether it is a property (`:`) or a method. */
const MEMBER = /^( {4}| {8})(?:readonly )?(?:get |set )?'?([\w-]+)'?\??([:(<])/;

/**
 * The members of the block that starts at `lines[start]`: a line at the block's first indent is a member, and a line one
 * indent further in, under a property (not a method, whose nested lines are its parameters' types), is that property's
 * field, named `property.field` (an event's detail).
 */
function membersAt(lines: readonly string[], start: number): string[] {
    const members: string[] = [];
    let property: string | null = null;
    // the block ends at its closing line; `} & ({` and `} | {` join the parts of one object type
    for (let j = start + 1; j < lines.length && !/^(?:\}\)?;?|export .*|\/\/.*)$/.test(lines[j]!); j++) {
        const member = MEMBER.exec(lines[j]!);
        if (!member) continue;
        const [, indent, key, after] = member;
        if (indent === '    ') {
            property = after === ':' ? key! : null;
            if (key !== 'constructor') members.push(key!);
            continue;
        }
        if (property !== null) members.push(`${property}.${key}`);
    }
    return members;
}

/** The declarations of a report, with their members (an interface and a class of one name are one declaration). */
function declarationsOf(report: string): Map<string, Declaration> {
    const found = new Map<string, Declaration>();
    const lines = report.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const head = /^export (const|function|type|interface|class) (\w+)/.exec(lines[i]!);
        if (!head) continue;
        const name = head[2]!;
        const block = head[1] !== 'const' && head[1] !== 'function' && lines[i]!.trimEnd().endsWith('{');
        const known = found.get(name);
        const members = [...(known?.members ?? []), ...(block ? membersAt(lines, i) : [])];
        found.set(name, { name, block: block || (known?.block ?? false), members: [...new Set(members)].sort() });
    }
    return found;
}

/** Every classified value: a declaration's own, and each of its members and inherited members. */
function classified(): [string, GuestValue][] {
    const values: [string, GuestValue][] = [];
    for (const [name, row] of Object.entries(GUEST_VALUES) as [string, GuestValueRow][]) {
        if ('owner' in row) values.push([name, row]);
        if (!('members' in row)) continue;
        const members: Record<string, GuestValue> = { ...row.members, ...(row.inherited ?? {}) };
        for (const [member, value] of Object.entries(members)) values.push([`${name}.${member}`, value]);
    }
    return values;
}

describe('GUEST_VALUES: every value the API hands the embedder is classified, in each build (I10)', () => {
    it.each(BUILDS)("the %s build's report has exactly the declarations GUEST_VALUES gives that build", (build) => {
        expect([...declarationsOf(readReport(build)).keys()].sort()).toEqual(guestValueDeclarations(build).sort());
    });

    it.each(BUILDS)("in the %s build, a declaration whose values are handed over has a row per member, a method's return value and an event's detail field included", (build) => {
        for (const declaration of declarationsOf(readReport(build)).values()) {
            const row = GUEST_VALUES[declaration.name as GuestValueDeclaration] as GuestValueRow;
            if ('handed' in row) continue;
            if (!declaration.block || declaration.members.length === 0) {
                expect('owner' in row, `${declaration.name}: one value, one owner`).toBe(true);
                continue;
            }
            expect('members' in row, `${declaration.name}: its members, one by one`).toBe(true);
            if ('members' in row) expect(Object.keys(row.members).sort(), declaration.name).toEqual(declaration.members);
        }
    });

    it('every owner is one of the three, every row says why, and text the docs name is the guest\'s', () => {
        const values = classified();
        expect(values.length).toBeGreaterThan(60);
        for (const [at, value] of values) {
            expect(Object.keys(GUEST_VALUE_OWNERS), at).toContain(value.owner);
            expect(value.why.length, at).toBeGreaterThan(5);
            if (value.text) expect(value.owner, at).toBe('guest');
        }
    });

    it('an event carries guest data exactly when ELEMENT_EVENTS says so', () => {
        const events: Record<string, GuestValue> = { ...GUEST_VALUES.WebSandboxEventMap.members, ...GUEST_VALUES.NetworkModeEvents.members };
        for (const [type, row] of Object.entries(ELEMENT_EVENTS)) expect(events[type]!.owner === 'guest', type).toBe(row.guestData);
    });

    it("the values the first test pins as unknown are the guest's in the registry", () => {
        expect(GUEST_VALUES.WebSandbox.members.call.owner).toBe('guest');
        expect(GUEST_VALUES.WebSandbox.members.callWithTimeout.owner).toBe('guest');
        expect(GUEST_VALUES.HostMethod.owner).toBe('guest');
        expect(GUEST_VALUES.SandboxLog.members.args.owner).toBe('guest');
    });

    it('the scans see what they guard: a new member of the element, a new field of an event detail and a new export each want a row', () => {
        const report = readReport('default');
        const withMember = report.replace('    reset(): void;\n', '    reset(): void;\n    links(): readonly string[];\n');
        expect(declarationsOf(withMember).get('WebSandbox')!.members).toContain('links');
        const withField = report.replace('    fileswritten: CustomEvent<{\n        readonly paths: readonly string[];\n', '    fileswritten: CustomEvent<{\n        readonly paths: readonly string[];\n        readonly origin: string;\n');
        expect(declarationsOf(withField).get('WebSandboxEventMap')!.members).toContain('fileswritten.origin');
        const withExport = report.replace('// @public\nexport const VIEW_INPUT_IN_FLIGHT', '// @public\nexport const GUEST_IMAGE_TYPES: readonly string[];\n\n// @public\nexport const VIEW_INPUT_IN_FLIGHT');
        expect([...declarationsOf(withExport).keys()]).toContain('GUEST_IMAGE_TYPES');
        // and a method's parameter types are not members: commitGuestWrites's options
        expect(declarationsOf(report).get('WebSandbox')!.members).not.toContain('commitGuestWrites.code');
    });
});
