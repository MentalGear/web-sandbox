/** docs/API.md's two guest policies, as the generator makes them with no origins and no files. */
import { cooperativePolicy, strictViewPolicy } from '../../../src/lib/csp/csp-generator';
import { NO_ORIGINS } from '../../../src/lib/csp/origins';
import { signatureOf, type Item } from '../engine';
import type { Extractor } from './markdown';

const WIDTH = 114;
const input = { origins: NO_ORIGINS, fileKinds: new Set<never>(), scriptUnsafe: false };
const HASH = `'sha256-${'A'.repeat(43)}='`;

/** The policy of each mode: the strict one names the bootstrap's hash by a placeholder. */
const policies = () => ({
    cooperative: cooperativePolicy(input),
    strict: strictViewPolicy({ ...input, bootstrapHash: HASH }).replace(HASH, "'sha256-<bootstrap>'"),
});

/** A policy as a fenced block: its directives filled into lines of at most WIDTH characters. */
function block(policy: string): string {
    const lines: string[] = [];
    const directives = policy.split('; ');
    for (const [index, directive] of directives.entries()) {
        const text = index < directives.length - 1 ? `${directive};` : directive;
        const last = lines.length - 1;
        if (last >= 0 && lines[last]!.length + 1 + text.length <= WIDTH) lines[last] += ` ${text}`;
        else lines.push(text);
    }
    return ['```', ...lines, '```'].join('\n');
}

const items = (): Item[] => [
    { id: 'csp:cooperative', signature: signatureOf(policies().cooperative), render: () => block(policies().cooperative) },
    { id: 'csp:strict', signature: signatureOf(policies().strict), render: () => block(policies().strict) },
];

export const csp: Extractor = {
    items,
    regions: {
        'csp-cooperative': () => items()[0]!.render(),
        'csp-strict': () => items()[1]!.render(),
    },
};
