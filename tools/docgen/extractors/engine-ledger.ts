/**
 * docs/THREAT-MODEL.md's table of the differences between engines that still stand: ENGINE_DIFFERENCES
 * (src/lib/engine-ledger.ts), one row per difference with what each engine does, why it stays and the specs that pin it.
 */
import { ENGINE_DIFFERENCES, ENGINE_DIFFERENCE_IDS } from '../../../src/lib/engine-ledger';
import { signatureOf } from '../engine';
import { code, row, table, type Extractor } from './markdown';

/** A spec as a link from docs/ (the page this table is in). */
const link = (file: string) => `[${file.replace(/^test\/e2e\//, '')}](../${file})`;

const rows = () => ENGINE_DIFFERENCE_IDS.map(id => {
    const entry = ENGINE_DIFFERENCES[id];
    return row([`<a id="engine-${id}"></a>${code(id)}`, entry.what, entry.chromium, entry.firefox, entry.webkit, entry.why, entry.tests.map(link).join(', ')]);
});

export const engineLedger: Extractor = {
    items: () => [
        // the ids and what each engine does: a section that describes the ledger follows these
        { id: 'engine-ledger', signature: signatureOf(ENGINE_DIFFERENCE_IDS.map(id => [id, ENGINE_DIFFERENCES[id]])), render: () => '' },
    ],
    regions: {
        'engine-ledger': () => table(['Row', 'What differs', 'Chromium', 'Firefox', 'WebKit', 'Why it stays', 'Specs'], rows()),
    },
};
