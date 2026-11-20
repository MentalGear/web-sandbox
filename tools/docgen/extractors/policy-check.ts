/**
 * The policy check's canaries (src/lib/policy-check.ts, POLICY_CANARIES), as the table of design 03's "What the policy
 * check provokes": one row per directive of the file's `<meta>`, with its admitted canary, its refused canary, why it
 * lacks one, and what the check does not see of it.
 */
import { CANARY_SCHEMES, canaryUrl, POLICY_CANARIES, POLICY_DIRECTIVES, POLICY_FINDINGS, type PolicyCanaryRow, type RefusedLoad } from '../../../src/lib/policy-check';
import { TERMINATION_REASONS } from '../../../src/lib/reasons';
import { signatureOf, type Item } from '../engine';
import { code, row, table, type Extractor } from './markdown';

const rows = (): [string, PolicyCanaryRow][] => Object.entries(POLICY_CANARIES) as [string, PolicyCanaryRow][];

const sourcesOf = (directive: string): string => {
    const sources = POLICY_DIRECTIVES[directive as keyof typeof POLICY_DIRECTIVES].sources as readonly unknown[];
    if (sources.length === 0) return code("'none'");
    return sources.map(source => (typeof source === 'string' ? code(source) : `the hash of the ${(source as { hash: string }).hash} text`)).join(', ');
};

const admittedOf = (canary: PolicyCanaryRow): string => {
    if (canary.admitted === null) return 'none';
    if (canary.admitted === 'bootstrap') return "the view's own bootstrap";
    return `${code(canary.admitted)}: from a \`blob:\` URL of the view's own`;
};

const refusedOf = (load: RefusedLoad | null): string => {
    if (load === null) return 'none';
    if (load === 'dataWorker') return `${code(load)}: a \`data:\` worker`;
    return `${code(load)}: ${CANARY_SCHEMES.map(scheme => code(canaryUrl(load, scheme))).join(' and ')}`;
};

const canariesTable = () => table(
    ['Directive', "The `<meta>`'s sources", 'Admitted canary', 'Refused canary', 'Why one is missing', 'What the check does not see, and what stands behind it'],
    rows().map(([directive, canary]) => row([
        code(directive),
        sourcesOf(directive),
        admittedOf(canary),
        refusedOf(canary.refused),
        canary.why ?? '',
        canary.unseen ?? '',
    ])),
);

const findingsTable = () => table(
    ['Finding', 'Violations of', 'Ends the build with'],
    (Object.entries(POLICY_FINDINGS) as [string, (typeof POLICY_FINDINGS)[keyof typeof POLICY_FINDINGS]][]).map(([name, finding]) => row([
        code(name),
        `another policy, disposition ${code(finding.disposition)} (a \`${finding.header}\` header)`,
        `${code(finding.reason)}: ${TERMINATION_REASONS[finding.reason].text}`,
    ])),
);

const items = (): Item[] => [
    { id: 'policy-canaries', signature: signatureOf([rows(), POLICY_DIRECTIVES]), render: canariesTable },
    { id: 'policy-findings', signature: signatureOf(Object.entries(POLICY_FINDINGS)), render: findingsTable },
];

export const policyCheck: Extractor = {
    items,
    regions: { 'policy-canaries': canariesTable, 'policy-findings': findingsTable },
};
