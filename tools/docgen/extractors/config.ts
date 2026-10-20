/**
 * docs/API.md's Configuration table. The option, its default and its modes come from CONFIG_SCHEMA; the type and the
 * prose from config-docs.ts, which cannot name an option the schema lacks or leave one out. The capability lists are
 * src/csp-directives.ts's.
 */
import { SAFE_CAPABILITIES, UNSAFE_CAPABILITIES } from '../../../src/csp-directives';
import { CONFIG_SCHEMA, SANDBOX_MODES, type OptionName, type OptionRule } from '../../../src/lib/config-schema';
import { signatureOf, type Item } from '../engine';
import { OPTION_WORDS } from './config-docs';
import { codeList, code, row, table, type Extractor } from './markdown';

const rules = CONFIG_SCHEMA as Record<OptionName, OptionRule>;
const documented = () => Object.keys(OPTION_WORDS) as (keyof typeof OPTION_WORDS)[];

/** The Modes cell: `all`, or the modes that read the option, in the order of SANDBOX_MODES. */
function modesCell(name: keyof typeof OPTION_WORDS): string {
    const words = OPTION_WORDS[name];
    const modes = rules[name].modes ?? [];
    const listed = modes.length === SANDBOX_MODES.length ? 'all' : SANDBOX_MODES.filter(mode => modes.includes(mode)).join(', ');
    return words.modes ?? `${listed}${words.modesNote ?? ''}`;
}

const expand = (text: string) => text.replace('{safeCapabilities}', codeList(SAFE_CAPABILITIES)).replace('{unsafeCapabilities}', codeList(UNSAFE_CAPABILITIES));

const items = (): Item[] => [
    ...documented().map(name => ({
        id: `option:${name}`,
        signature: signatureOf({ default: rules[name].documented, modes: rules[name].modes }),
        render: () => row([code(name), OPTION_WORDS[name].type, rules[name].documented ?? '', modesCell(name), expand(OPTION_WORDS[name].what)]),
    })),
    { id: 'options', signature: signatureOf(documented().map(name => [name, rules[name].documented, rules[name].modes])), render: () => '' },
    { id: 'capabilities', signature: signatureOf({ safe: SAFE_CAPABILITIES, unsafe: UNSAFE_CAPABILITIES }), render: () => '' },
];

export const config: Extractor = {
    items,
    regions: {
        configuration: () => table(['Option', 'Type', 'Default', 'Modes', 'What it does'], items().filter(item => item.id.startsWith('option:')).map(item => item.render())),
    },
};
