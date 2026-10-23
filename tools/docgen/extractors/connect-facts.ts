/**
 * What each engine does with a `connect-src` source: CONNECT_ENGINE_FACTS (src/lib/connect-facts.ts) as the table of
 * docs/API.md#your-connect-src, the sentence of the README, and HOST_SOURCE_RULES (src/lib/csp/host-connect.ts) as the
 * table of the parser's grammar.
 */
import { CONNECT_ENGINES, CONNECT_ENGINE_FACTS, connectSentence } from '../../../src/lib/connect-facts';
import { HOST_SOURCE_RULES } from '../../../src/lib/csp/host-connect';
import { signatureOf } from '../engine';
import { row, table, type Extractor } from './markdown';

const yes = (value: boolean) => (value ? 'yes' : 'no');

const factsTable = () => table(
    [
        'Engine', "A `'self'` source of your `connect-src` admits an origin it does not name", 'A host written without a scheme admits the `https://` origin it names',
        'A `http://h:P` source admits `https://h:P`', 'A `wss://h` source also admits `https://h`', "The read's decoy logs a line though your policy admits it", 'Found by',
    ],
    CONNECT_ENGINES.map(engine => {
        const facts = CONNECT_ENGINE_FACTS[engine];
        return row([facts.name, yes(facts.selfAdmitsOtherOrigins), facts.bareHostAdmitted, yes(facts.upgradedSchemeWithPort), yes(facts.wssSourceAdmitsHttps), yes(facts.decoyLogsWhenAdmitted), facts.measured]);
    }),
);

const grammarTable = () => table(
    ['Source in your `connect-src`', 'Admits an `origins.connect` or `fetchBridge.allow` entry when', 'Example'],
    HOST_SOURCE_RULES.map(rule => {
        const [policy, origin, admitted] = rule.examples[0]!;
        return row([rule.source, rule.admits, `\`${policy}\` ${admitted ? 'admits' : 'drops'} \`${origin}\``]);
    }),
);

export const connectFacts: Extractor = {
    items: () => [
        { id: 'connect-facts', signature: signatureOf(CONNECT_ENGINES.map(engine => [engine, CONNECT_ENGINE_FACTS[engine]])), render: () => '' },
        { id: 'host-source-rules', signature: signatureOf(HOST_SOURCE_RULES.map(rule => [rule.kind, rule.source, rule.admits, rule.examples])), render: () => '' },
    ],
    regions: {
        'connect-facts': factsTable,
        'connect-sentence': connectSentence,
        'host-source-rules': grammarTable,
    },
};
