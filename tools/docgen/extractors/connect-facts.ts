/**
 * What each engine does with a `connect-src` source: CONNECT_ENGINE_FACTS (src/lib/connect-facts.ts) as the table of
 * docs/API.md#your-connect-src, the sentence of the README, and HOST_SOURCE_RULES (src/lib/csp/host-connect.ts) as the
 * table of the parser's grammar, and TRUSTED_TYPES_RULES (src/lib/csp/host-trusted-types.ts) as the table of the Trusted
 * Types directives a browser without Trusted Types applies from `hostContentSecurityPolicy`.
 */
import { CONNECT_ENGINES, CONNECT_ENGINE_FACTS, connectSentence } from '../../../src/lib/connect-facts';
import { HOST_SOURCE_RULES } from '../../../src/lib/csp/host-connect';
import { TRUSTED_TYPES_RULES } from '../../../src/lib/csp/host-trusted-types';
import { signatureOf } from '../engine';
import { row, table, type Extractor } from './markdown';

const yes = (value: boolean) => (value ? 'yes' : 'no');

const factsTable = () => table(
    [
        'Engine', "A `'self'` source of your `connect-src` admits an origin it does not name", 'A host written without a scheme admits the `https://` origin it names',
        'A `http://h:P` source admits `https://h:P`', 'A `wss://h` source also admits `https://h`', 'Found by',
    ],
    CONNECT_ENGINES.map(engine => {
        const facts = CONNECT_ENGINE_FACTS[engine];
        return row([facts.name, yes(facts.selfAdmitsOtherOrigins), facts.bareHostAdmitted, yes(facts.upgradedSchemeWithPort), yes(facts.wssSourceAdmitsHttps), facts.measured]);
    }),
);

const grammarTable = () => table(
    ['Source in your `connect-src`', 'Admits an `origins.connect` or `fetchBridge.allow` entry when', 'Example'],
    HOST_SOURCE_RULES.map(rule => {
        const [policy, origin, admitted] = rule.examples[0]!;
        return row([rule.source, rule.admits, `\`${policy}\` ${admitted ? 'admits' : 'drops'} \`${origin}\``]);
    }),
);

const outcome = (value: 'ends' | 'ready') => (value === 'ends' ? 'ends the build' : 'builds');

const trustedTypesTable = () => table(
    ['In your policy', 'Rule', 'Example', 'Strict and worker mode', 'Cooperative mode', '`execute()`'],
    TRUSTED_TYPES_RULES.flatMap(rule => rule.examples.map(([policy, strictAndWorker, cooperative, execute], index) => row([
        index === 0 ? rule.source : '', index === 0 ? rule.says : '', `\`${policy}\``, outcome(strictAndWorker), outcome(cooperative), execute === 'refused' ? 'refused' : 'runs',
    ]))),
);

export const connectFacts: Extractor = {
    items: () => [
        { id: 'connect-facts', signature: signatureOf(CONNECT_ENGINES.map(engine => [engine, CONNECT_ENGINE_FACTS[engine]])), render: () => '' },
        { id: 'host-source-rules', signature: signatureOf(HOST_SOURCE_RULES.map(rule => [rule.kind, rule.source, rule.admits, rule.examples])), render: () => '' },
        { id: 'trusted-types-rules', signature: signatureOf(TRUSTED_TYPES_RULES.map(rule => [rule.source, rule.says, rule.examples])), render: () => '' },
    ],
    regions: {
        'connect-facts': factsTable,
        'connect-sentence': connectSentence,
        'host-source-rules': grammarTable,
        'trusted-types-rules': trustedTypesTable,
    },
};
