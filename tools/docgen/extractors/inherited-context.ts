/**
 * docs/THREAT-MODEL.md's table of the host page's context a sandbox document inherits: INHERITED_CONTEXT
 * (src/lib/inherited-context.ts), one row per channel.
 */
import { ENVIRONMENT_CHECKS } from '../../../src/lib/environment-check';
import { CONTEXT_ENGINES, inheritedContextRows } from '../../../src/lib/inherited-context';
import { signatureOf } from '../engine';
import { code, table, row, type Extractor } from './markdown';

const ENGINE_NAMES: Record<(typeof CONTEXT_ENGINES)[number], string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };

const engines = (list: readonly (typeof CONTEXT_ENGINES)[number][]) => (list.length === CONTEXT_ENGINES.length ? 'all' : list.map(engine => ENGINE_NAMES[engine]).join(', '));

/** A test file as a link from docs/ (the page this table is in). */
const link = (file: string) => `[${file.replace(/^(test\/(unit|e2e)\/|src\/lib\/)/, '')}](../${file})`;

const rows = () => inheritedContextRows().map(entry => {
    const checks = (entry as { environmentChecks?: readonly (keyof typeof ENVIRONMENT_CHECKS)[] }).environmentChecks ?? [];
    return row([
        entry.channel,
        entry.inheritedBy,
        `${entry.how}${checks.length ? ` (the environment check's ${checks.map(code).join(' and ')} ${checks.length === 1 ? 'row' : 'rows'})` : ''}`,
        engines(entry.engines),
        entry.tests.map(link).join(', '),
    ]);
});

export const inheritedContext: Extractor = {
    items: () => [
        // the channels, how each is neutralised and where it matters: a section that describes the inventory follows these
        { id: 'inherited-context', signature: signatureOf(inheritedContextRows().map(entry => [entry.id, entry.by, entry.engines])), render: () => '' },
    ],
    regions: {
        'inherited-context': () => table(['Channel', 'Inherited by', 'How the library neutralises it', 'Engines', 'Covered by'], rows()),
    },
};
