/** docs/API.md's Budgets table: CHANNEL_BUDGETS (src/lib/egress.ts) rendered with the limits registry's values. */
import { budgetsTable, CHANNEL_BUDGETS } from '../../../src/lib/egress';
import { limitValues } from '../../../src/lib/limits';
import { signatureOf } from '../engine';
import type { Extractor } from './markdown';

export const budgets: Extractor = {
    items: () => [
        { id: 'budgets', signature: signatureOf(budgetsTable(limitValues())), render: () => '' },
        // the channels, the surfaces they cross and their network in sealed mode, without the bounds' values
        { id: 'budgets:channels', signature: signatureOf(CHANNEL_BUDGETS.map(row => [row.channel, row.surfaces, row.sealed])), render: () => '' },
    ],
    regions: { budgets: () => budgetsTable(limitValues()) },
};
