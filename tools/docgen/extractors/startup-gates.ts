/**
 * The start-up gates (src/lib/startup-gates.ts, STARTUP_GATES), as the table of design 03's "The start-up gates": one
 * row per gate, with where it runs, in which modes, what it provokes, a pass, a fail, the reason and its mutant.
 */
import { STARTUP_GATES, type GateRow } from '../../../src/lib/startup-gates';
import { TERMINATION_REASONS } from '../../../src/lib/reasons';
import { signatureOf, type Item } from '../engine';
import { code, row, table, type Extractor } from './markdown';

const rows = (): [string, GateRow][] => Object.entries(STARTUP_GATES) as [string, GateRow][];

const gatesTable = () => table(
    ['Gate', 'Runs in', 'Modes', 'Provokes', 'Passes', 'Fails', 'Ends the build with', 'Its mutant'],
    rows().map(([name, gate]) => row([
        code(name),
        gate.realms.join(', '),
        `${gate.modes.join(', ')}${gate.modesWhy ? ` (${gate.modesWhy})` : ''}`,
        gate.provokes,
        gate.pass,
        gate.fail,
        `${code(gate.reason)}: ${TERMINATION_REASONS[gate.reason].text}`,
        gate.mutant,
    ])),
);

const items = (): Item[] => [{ id: 'startup-gates', signature: signatureOf(rows()), render: gatesTable }];

export const startupGates: Extractor = {
    items,
    regions: { 'startup-gates': gatesTable },
};
