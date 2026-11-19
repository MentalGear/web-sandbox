/**
 * docs/API.md's `terminated` reasons, the messages of start()'s and defineWebSandbox()'s refusals and the element's own log
 * lines, from src/lib/reasons.ts.
 */
import { signatureOf, type Item } from '../engine';
import { HOST_LINE_OCCASIONS, HOST_LINES, reasonCauses, TERMINATION_REASONS, type HostLineId, type ReasonId } from '../../../src/lib/reasons';
import { code, row, table, type Extractor } from './markdown';

const reasonIds = () => Object.keys(TERMINATION_REASONS) as ReasonId[];
const lineIds = () => Object.keys(HOST_LINES) as HostLineId[];
// the reasons one place decides, as a table of the text and its cause
const decidedIn = (where: readonly string[]) => {
    const rows: string[] = [];
    for (const id of reasonIds()) if (where.includes(TERMINATION_REASONS[id].decidedBy)) rows.push(row([code(TERMINATION_REASONS[id].text), reasonCauses()[id]]));
    return rows;
};

const items = (): Item[] => [
    ...reasonIds().map(id => ({
        id: `reason:${id}`,
        signature: signatureOf(TERMINATION_REASONS[id]),
        render: () => row([code(TERMINATION_REASONS[id].text), reasonCauses()[id]]),
    })),
    ...lineIds().map(id => ({
        id: `host-line:${id}`,
        signature: signatureOf(HOST_LINES[id]),
        render: () => row([code(HOST_LINES[id].text), HOST_LINES[id].level, HOST_LINES[id].source, HOST_LINE_OCCASIONS[id]]),
    })),
    { id: 'reasons', signature: signatureOf(reasonIds().map(id => TERMINATION_REASONS[id])), render: () => '' },
    { id: 'host-lines', signature: signatureOf(lineIds().map(id => HOST_LINES[id])), render: () => '' },
];

export const reasons: Extractor = {
    items,
    regions: {
        'termination-reasons': () => table(['Reason', 'Cause'], decidedIn(['host', 'lifecycle'])),
        'start-refusals': () => table(['Message', 'Cause'], decidedIn(['start'])),
        'define-refusals': () => table(['Message', 'Cause'], decidedIn(['define'])),
        'host-lines': () => table(['Line', 'Level', 'Source', 'When'], items().filter(item => item.id.startsWith('host-line:')).map(item => item.render())),
    },
};
