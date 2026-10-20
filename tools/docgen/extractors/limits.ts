/** docs/API.md's Limits table, from LIMITS (src/lib/limits.ts). */
import { signatureOf, type Item } from '../engine';
import { LIMITS, type LimitName } from '../../../src/lib/limits';
import { code, row, table, type Extractor } from './markdown';

const MIB = 1048576;
const names = () => Object.keys(LIMITS) as LimitName[];

/** A limit's value as the table writes it: the number, with its size in MiB for a byte count that is whole MiB, and its note. */
function valueCell(name: LimitName): string {
    const limit = LIMITS[name];
    const size = limit.unit === 'bytes' && limit.value >= MIB && limit.value % MIB === 0 ? ` (${limit.value / MIB} MiB)` : '';
    const note = 'note' in limit ? ` (${limit.note})` : '';
    return `${limit.value}${size}${note}`;
}

const items = (): Item[] => [
    ...names().map(name => ({
        id: `limit:${name}`,
        signature: signatureOf({ value: LIMITS[name].value, unit: LIMITS[name].unit }),
        render: () => row([LIMITS[name].label ?? name, valueCell(name), LIMITS[name].exported ? code(name) : '—']),
    })),
    { id: 'limits', signature: signatureOf(names().map(name => [name, LIMITS[name].value, LIMITS[name].unit])), render: () => '' },
];

export const limits: Extractor = {
    items,
    regions: {
        // the rows with a label: the others are named by the Budgets table only
        limits: () => table(['Limit', 'Value', 'Exported constant'], items().filter(item => item.id.startsWith('limit:') && LIMITS[item.id.slice(6) as LimitName].label !== null).map(item => item.render())),
    },
};
