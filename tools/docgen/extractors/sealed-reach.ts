/**
 * docs/THREAT-MODEL.md's classification of everything a sealed guest can reach against every row of the host page's
 * context (SEALED_REACH, src/lib/sealed-reach.ts): per row, how many names are `none`, which are neutralised and by which
 * chokepoints, and what remains, with the row's residuals; and the chokepoints, each with where the code has it.
 */
import { INHERITED_CONTEXT, type InheritedContextId } from '../../../src/lib/inherited-context';
import { CHOKEPOINTS, reachCell, sealedReachNames, SURFACES, surfaceOf, type ChokepointId } from '../../../src/lib/sealed-reach';
import { signatureOf } from '../engine';
import { code, codeList, row, table, type Extractor } from './markdown';

const rowIds = () => Object.keys(INHERITED_CONTEXT) as InheritedContextId[];

interface RowSummary {
    none: number;
    neutralised: Map<ChokepointId, number>;
    neutralisedCount: number;
    remains: Map<string, Set<string>>;
    remainsCount: number;
}

/** One row's cells over every name: the counts, the chokepoints named and the surfaces each residual is reached from. */
function summary(id: InheritedContextId): RowSummary {
    const result: RowSummary = { none: 0, neutralised: new Map(), neutralisedCount: 0, remains: new Map(), remainsCount: 0 };
    for (const { name } of sealedReachNames()) {
        const cell = reachCell(name, id)!;
        if (cell.relation === 'none') {
            result.none++;
            continue;
        }
        if (cell.relation === 'neutralised') {
            result.neutralisedCount++;
            for (const chokepoint of cell.by) result.neutralised.set(chokepoint, (result.neutralised.get(chokepoint) ?? 0) + 1);
            continue;
        }
        result.remainsCount++;
        for (const residual of cell.residuals) {
            const surfaces = result.remains.get(residual) ?? new Set<string>();
            surfaces.add(surfaceOf(name)!);
            result.remains.set(residual, surfaces);
        }
    }
    return result;
}

const neutralisedCell = (entry: RowSummary): string => {
    if (entry.neutralisedCount === 0) return '0';
    const chokepoints = [...entry.neutralised.keys()].sort();
    return `${entry.neutralisedCount}: ${codeList(chokepoints)}`;
};

const remainsCell = (id: InheritedContextId, entry: RowSummary): string => {
    if (entry.remainsCount === 0) return '0';
    const residuals = (INHERITED_CONTEXT[id] as { residuals?: Readonly<Record<string, { what: string }>> }).residuals ?? {};
    const parts: string[] = [];
    for (const [residual, surfaces] of entry.remains) parts.push(`${code(residual)} (from ${[...surfaces].sort().map(code).join(', ')}): ${residuals[residual]!.what}`);
    return `${entry.remainsCount}: ${parts.join('; ')}`;
};

const rows = () => rowIds().map(id => {
    const entry = summary(id);
    return row([code(id), String(entry.none), neutralisedCell(entry), remainsCell(id, entry)]);
});

const chokepointRows = () => (Object.keys(CHOKEPOINTS) as ChokepointId[]).map(id => row([code(id), CHOKEPOINTS[id].what, code(CHOKEPOINTS[id].file)]));

/** The classification's meaning: each name's surface and each row's cell for it. */
const classification = () => {
    const names = sealedReachNames().map(({ name }) => name);
    const cells = rowIds().map(id => [id, names.map(name => {
        const cell = reachCell(name, id)!;
        return cell.relation === 'none' ? 0 : cell.relation === 'neutralised' ? [...cell.by].sort().join('+') : [...cell.residuals].sort().join('+');
    })]);
    return [names.map(name => [name, surfaceOf(name)]), Object.keys(SURFACES), cells, Object.keys(CHOKEPOINTS)];
};

export const sealedReach: Extractor = {
    items: () => [
        // every name's surface and every cell of every row: a section that describes the classification follows them
        { id: 'sealed-reach', signature: signatureOf(classification()), render: () => '' },
    ],
    regions: {
        'sealed-reach': () => {
            const names = sealedReachNames().length;
            const header = `${names} names × ${rowIds().length} rows = ${names * rowIds().length} cells.`;
            return `${header}\n\n${table(['Row', 'None', 'Neutralised (by)', 'Remains (the residual, the surfaces that reach it)'], rows())}`;
        },
        'sealed-reach-chokepoints': () => table(['Chokepoint', 'What it does', 'Where'], chokepointRows()),
    },
};
