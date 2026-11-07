import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABSENT_COMPILERS, CODE_FROM_STRING_SINKS } from '@src/lib/code-from-strings';
import { INHERITED_CONTEXT, type InheritedContextId, type InheritedContextRow } from '@src/lib/inherited-context';
import {
    CHOKEPOINTS, IMPORT_EXPRESSIONS, REACH_RELATIONS, REACH_SIDES, SEALED_REACH, SURFACES, reachCell, sealedReachNames, secureContextOnlyNames, sideOf, surfaceOf,
    type Cell, type ChokepointId, type Column, type SurfaceId,
} from '@src/lib/sealed-reach';
import { WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS } from '@src/lib/worker-globals';
import { HOST_PASSES, type HostPassId } from '@src/lib/host-passes';

/**
 * Class A is closed by enumeration (S74; docs/research/18_finding_classes): every name a sealed guest can reach (the worker's
 * allowlist, the library's names, the syntax that compiles, and every element, attribute and load kind the view's renderer
 * admits) is classified against every row of INHERITED_CONTEXT (SEALED_REACH, src/lib/sealed-reach.ts). This test fails on
 * a name with no surface, a row with no column, a cell that names a chokepoint the code does not have, and a `remains` cell
 * that names no residual of its row.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const names = sealedReachNames();
const nameList = names.map(entry => entry.name);
const rowIds = Object.keys(INHERITED_CONTEXT) as InheritedContextId[];
const surfaceIds = Object.keys(SURFACES) as SurfaceId[];
const row = (id: InheritedContextId): InheritedContextRow => INHERITED_CONTEXT[id];
const column = (id: InheritedContextId): Column => SEALED_REACH[id];
const cellsOf = (id: InheritedContextId): [string, Cell][] => Object.entries(column(id).cells);

describe('every name a sealed guest can reach has one surface', () => {
    it('each name of the allowlists, the library, the syntax and the renderer is in exactly one surface, and no surface lists a name of neither', () => {
        expect(new Set(nameList).size, 'a name appears in two lists of the domain').toBe(nameList.length);
        const listed = surfaceIds.flatMap(id => SURFACES[id].names as readonly string[]);
        expect(new Set(listed).size, 'a name is in two surfaces').toBe(listed.length);
        const unclassified = nameList.filter(name => !listed.includes(name));
        expect(unclassified, 'give each new name a surface in SEALED_REACH (src/lib/sealed-reach.ts): what it can do, which says what it is to every row').toEqual([]);
        expect(listed.filter(name => !nameList.includes(name)), 'a surface lists a name no list of the code has').toEqual([]);
    });

    it("a surface's names are all of its side, and every surface says what it can do", () => {
        for (const entry of names) expect(SURFACES[surfaceOf(entry.name)!].side, entry.name).toBe(sideOf(entry.domain));
        for (const id of surfaceIds) {
            expect(SURFACES[id].what.length, id).toBeGreaterThan(10);
            expect(SURFACES[id].names.length, id).toBeGreaterThan(0);
        }
    });

    it('the domain is the code\'s lists: every worker global and navigator member, every function kind, and every import expression', () => {
        for (const name of WORKER_GLOBALS) expect(nameList, name).toContain(name);
        for (const member of WORKER_NAVIGATOR_MEMBERS) expect(nameList, member).toContain(`navigator.${member}`);
        for (const [id, sink] of Object.entries(CODE_FROM_STRING_SINKS)) if (sink.kind === 'function-kind') expect(nameList, id).toContain(id);
        for (const name of IMPORT_EXPRESSIONS) expect(nameList, name).toContain(name); // import() and its phases (BD7:CHL-1)
    });
});

describe('every row has a column, and every cell is well formed', () => {
    it('the columns are the rows of INHERITED_CONTEXT, in its order', () => {
        expect(Object.keys(SEALED_REACH), 'a row of INHERITED_CONTEXT needs its column in SEALED_REACH').toEqual(rowIds);
    });

    it.each(rowIds.map(id => [id] as const))('%s: each cell is keyed by a name, a surface or a side, and says why', (id) => {
        expect(column(id).rest.length, 'the rest reason').toBeGreaterThan(10);
        for (const [key, cell] of cellsOf(id)) {
            const known = nameList.includes(key) || (surfaceIds as string[]).includes(key) || (REACH_SIDES as readonly string[]).includes(key);
            expect(known, `${id}: ${key} is no name, surface or side`).toBe(true);
            expect(REACH_RELATIONS, `${id}: ${key}`).toContain(cell.relation);
            expect(cell.why.length, `${id}: ${key}`).toBeGreaterThan(10);
        }
    });

    it('a neutralised cell names chokepoints, each a declaration or a statement the code has', () => {
        const used = new Set<ChokepointId>();
        for (const id of rowIds) {
            for (const [key, cell] of cellsOf(id)) {
                if (cell.relation !== 'neutralised') continue;
                expect(cell.by.length, `${id}: ${key}`).toBeGreaterThan(0);
                for (const chokepoint of cell.by) {
                    expect(Object.keys(CHOKEPOINTS), `${id}: ${key}`).toContain(chokepoint);
                    used.add(chokepoint);
                }
            }
        }
        for (const [id, chokepoint] of Object.entries(CHOKEPOINTS)) {
            const file = path.join(root, chokepoint.file);
            expect(existsSync(file), `${id}: ${chokepoint.file}`).toBe(true);
            expect(readFileSync(file, 'utf8').includes(chokepoint.token), `${id}: ${chokepoint.file} no longer has \`${chokepoint.token}\``).toBe(true);
            expect(used.has(id as ChokepointId), `${id} is named by no cell`).toBe(true);
        }
    });

    it("a remains cell names residuals of its own row, and every residual is named by a cell and pinned by a test that exists", () => {
        for (const id of rowIds) {
            const residuals = Object.keys(row(id).residuals ?? {});
            const named = new Set<string>();
            for (const [key, cell] of cellsOf(id)) {
                if (cell.relation !== 'remains') continue;
                expect(cell.residuals.length, `${id}: ${key}`).toBeGreaterThan(0);
                for (const residual of cell.residuals) {
                    expect(residuals, `${id}: ${key} names ${residual}, which is not a residual of the row (INHERITED_CONTEXT.${id}.residuals)`).toContain(residual);
                    named.add(residual);
                }
            }
            for (const residual of residuals) {
                expect(named.has(residual), `${id}.${residual} is named by no cell`).toBe(true);
                const { what, tests } = row(id).residuals![residual]!;
                expect(what.length, `${id}.${residual}`).toBeGreaterThan(20);
                expect(tests.length, `${id}.${residual}`).toBeGreaterThan(0);
                for (const file of tests) expect(existsSync(path.join(root, file)), `${id}.${residual}: ${file}`).toBe(true);
            }
        }
    });

    it("a row with something left in sealed mode says so: a remains cell only where the row's sealed standing is remains or reduced", () => {
        for (const id of rowIds) {
            const remaining = cellsOf(id).filter(([, cell]) => cell.relation === 'remains');
            if (remaining.length > 0) expect(['remains', 'reduced'], id).toContain(row(id).sealed.standing);
        }
    });
});

describe('the classification agrees with the chokepoints the code keeps', () => {
    const cell = (name: string, id: InheritedContextId) => reachCell(name, id)!;
    const neutralisedBy = (name: string, id: InheritedContextId, chokepoint: ChokepointId) => {
        const found = cell(name, id);
        expect(found.relation, `${name} × ${id}`).toBe('neutralised');
        expect((found as { by: readonly ChokepointId[] }).by, `${name} × ${id}`).toContain(chokepoint);
    };

    it('every code-from-string sink is neutralised by the refusal for the rows a compiled string reaches', () => {
        for (const name of Object.keys(CODE_FROM_STRING_SINKS)) {
            for (const rowId of ['cspScript', 'cspPolicyText', 'cspReporting', 'trustedTypesRequirement'] as const) neutralisedBy(name, rowId, 'codeFromStringRefusal');
        }
        for (const name of IMPORT_EXPRESSIONS) {
            for (const rowId of ['cspScript', 'cspPolicyText', 'cspReporting'] as const) neutralisedBy(name, rowId, 'entryImportRefusal');
        }
    });

    it('every compiler of ABSENT_COMPILERS that the allowlist names is neutralised by what removes it', () => {
        const onList = Object.keys(ABSENT_COMPILERS).filter(name => (WORKER_GLOBALS as readonly string[]).includes(name));
        expect(onList.sort()).toEqual(['WebAssembly', 'importScripts']);
        for (const rowId of ['cspScript', 'cspPolicyText', 'cspReporting'] as const) {
            neutralisedBy('importScripts', rowId, 'strictWorkerAllowlist');
            neutralisedBy('WebAssembly', rowId, 'webAssemblyRemoval');
        }
    });

    it('every request maker of the allowlist is neutralised by the request gate for every row a request reaches', () => {
        for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket']) {
            for (const rowId of ['cspFetch', 'cspPolicyText', 'cspReporting', 'referrer', 'cookies', 'serviceWorker'] as const) neutralisedBy(name, rowId, 'requestGate');
        }
    });

    it("every name only a secure context has, and isSecureContext, is neutralised by the strict worker's removal; nothing of the row remains", () => {
        for (const name of [...secureContextOnlyNames(), 'isSecureContext']) {
            expect(nameList, name).toContain(name);
            neutralisedBy(name, 'secureContext', 'secureContextRemoval');
        }
        expect(cellsOf('secureContext').filter(([, found]) => found.relation === 'remains')).toEqual([]);
    });

    it('every URL attribute of the renderer keeps no network URL, and what it loads is a residual of the fetch rows', () => {
        for (const name of SURFACES.urlAttribute.names) {
            for (const rowId of ['cookies', 'referrer', 'serviceWorker'] as const) neutralisedBy(name, rowId, 'rendererUrlDrop');
            expect(cell(name, 'cspFetch')).toMatchObject({ relation: 'remains', residuals: ['blobLoads'] });
        }
    });
});

// BD5:ISO-1, BD5:ISO-2 (class A, the host page's context; the allowlist is the chokepoint): a kept name that reads browser
// state keyed to an origin or to the profile can be answered from the host page's own record (WebKit's permissions were).
describe('permissionState: every name that reads origin- or profile-keyed state is classified on its own (BD5:ISO-1)', () => {
    it('every navigator member has a cell of its own: the navigator is where an engine answers from its per-origin or profile records', () => {
        for (const member of WORKER_NAVIGATOR_MEMBERS) expect(Object.keys(column('permissionState').cells), member).toContain(`navigator.${member}`);
    });

    it('every name with a cell of its own is a name of the allowlists, and says what it reads', () => {
        for (const [name, found] of cellsOf('permissionState')) {
            expect(nameList, name).toContain(name);
            expect(found.why.length, name).toBeGreaterThan(20);
        }
    });

    it("the permission API and the storage manager are not offered (WebKit answered permissions from the host origin's grants; Firefox's estimate() ended the task)", () => {
        for (const name of ['Permissions', 'PermissionStatus', 'StorageManager', 'navigator.permissions', 'navigator.storage']) expect(nameList, name).not.toContain(name);
    });
});

// BD7:LIM-1 (class A): the domain left out the third realm that handles guest content, the host page's own, where the
// element parses and loads nothing of the guest's by construction (HOST_PASSES): every pass a sealed build runs is a name.
describe("the host realm, the table's third side: every pass of the host realm a sealed build runs (HOST_PASSES)", () => {
    const sealedPasses = (Object.keys(HOST_PASSES) as HostPassId[]).filter(id => (HOST_PASSES[id].modes as readonly string[]).includes('sealed'));

    it('every row of HOST_PASSES whose modes include sealed is a name of the host side, and no other is', () => {
        expect(names.filter(entry => entry.domain === 'hostPass').map(entry => entry.name).sort()).toEqual(sealedPasses.map(id => `host:${id}`).sort());
        expect(sealedPasses).toContain('entryScan');
        expect(sealedPasses).not.toContain('cooperativeDocument');
    });

    it("every row a parse, a load or a sink of the host realm would have the browser consult is neutralised for every pass by the host pass rule; the cost on the thread is the row's residual", () => {
        const consulted: InheritedContextId[] = ['cspScript', 'cspStyle', 'cspBaseUri', 'cspFetch', 'cspPolicyText', 'cspReporting', 'trustedTypesRequirement', 'trustedTypesDefault', 'referrer', 'cookies', 'serviceWorker'];
        for (const id of sealedPasses) {
            for (const rowId of consulted) {
                const found = reachCell(`host:${id}`, rowId)!;
                expect(found.relation, `${id} × ${rowId}`).toBe('neutralised');
                expect((found as { by: readonly ChokepointId[] }).by, `${id} × ${rowId}`).toEqual(['hostPassRule']);
            }
            expect(reachCell(`host:${id}`, 'thread'), id).toMatchObject({ relation: 'remains', residuals: ['hostPasses'] });
        }
    });
});

describe('the table, materialised', () => {
    it('every name has a cell for every row, and the counts add up', () => {
        const counts: Record<string, number> = { none: 0, neutralised: 0, remains: 0 };
        for (const entry of names) {
            for (const id of rowIds) {
                const found = reachCell(entry.name, id);
                expect(found, `${entry.name} × ${id}`).toBeDefined();
                counts[found!.relation]!++;
            }
        }
        expect(counts.none! + counts.neutralised! + counts.remains!).toBe(names.length * rowIds.length);
        expect(counts.neutralised).toBeGreaterThan(0);
        expect(counts.remains).toBeGreaterThan(0);
    });
});
