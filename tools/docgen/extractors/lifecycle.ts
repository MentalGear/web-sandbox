/**
 * The lifecycle reducer's states, inputs, effects and transitions: ARCHITECTURE.md's tables and its state diagram, from
 * src/lib/lifecycle.ts (LC_STATES, LC_INPUTS, LC_EFFECTS) and src/lib/lifecycle-transitions.ts.
 */
import { LC_EFFECTS, LC_INPUTS, LC_STATES, type EffectKindName, type LcInputKind } from '../../../src/lib/lifecycle';
import { lifecycleTransitions } from '../../../src/lib/lifecycle-transitions';
import { signatureOf, type Item } from '../engine';
import { code, row, table, type Extractor } from './markdown';

interface FieldLike { readonly type: string; readonly optional: boolean }
const fieldList = (fields: Readonly<Record<string, FieldLike>> | undefined) =>
    fields && Object.keys(fields).length ? Object.entries(fields).map(([name, field]) => code(`${name}${field.optional ? '?' : ''}: ${field.type}`)).join(', ') : '—';
const fieldSignature = (fields: Readonly<Record<string, FieldLike>> | undefined) => Object.entries(fields ?? {}).map(([name, field]) => [name, field.type, field.optional]);

const inputKinds = () => Object.keys(LC_INPUTS) as LcInputKind[];
const effectKinds = () => Object.keys(LC_EFFECTS) as EffectKindName[];

const GENERATION = { always: 'always', optional: 'when armed in an environment', never: '—' } as const;

/** The declared shape of an effect kind: its fields, or the fields of each variant. */
interface EffectShape { readonly summary: string; readonly fields?: Record<string, FieldLike>; readonly variants?: readonly Record<string, FieldLike>[] }
const effectOf = (kind: EffectKindName): EffectShape => LC_EFFECTS[kind];
const effectShape = (kind: EffectKindName) => {
    const declared = effectOf(kind);
    return declared.variants ? declared.variants.map(fieldSignature) : fieldSignature(declared.fields);
};

/** The transitions as a Mermaid state diagram: one edge for each (from, to) pair, labelled with the inputs that make it. */
function diagram(): string {
    const edges = new Map<string, string[]>();
    for (const { from, input, to } of lifecycleTransitions()) {
        const key = `${from} --> ${to}`;
        edges.set(key, [...(edges.get(key) ?? []), input]);
    }
    const lines = ['```mermaid', 'stateDiagram-v2', `    [*] --> ${LC_STATES[0]}`];
    for (const [edge, inputs] of edges) lines.push(`    ${edge}: ${inputs.join(', ')}`);
    return [...lines, '```'].join('\n');
}

const transitionSignature = () => lifecycleTransitions().map(({ from, input, to }) => [from, input, to]);

const items = (): Item[] => [
    ...inputKinds().map(kind => ({
        id: `lifecycle:input:${kind}`,
        signature: signatureOf({ stamped: LC_INPUTS[kind].stamped, states: LC_INPUTS[kind].states, modes: 'modes' in LC_INPUTS[kind] ? LC_INPUTS[kind].modes : null, fields: fieldSignature(LC_INPUTS[kind].fields) }),
        render: () => {
            const input = LC_INPUTS[kind];
            return row([
                code(kind), input.from, GENERATION[input.stamped],
                input.states.length === LC_STATES.length ? 'any' : input.states.map(code).join(', '),
                'modes' in input && input.modes ? input.modes.map(code).join(', ') : 'any',
                fieldList(input.fields),
            ]);
        },
    })),
    ...effectKinds().map(kind => ({
        id: `lifecycle:effect:${kind}`,
        signature: signatureOf(effectShape(kind)),
        render: () => {
            const declared = effectOf(kind);
            const shape = declared.variants ? declared.variants.map(fieldList).join('<br>') : fieldList(declared.fields);
            return row([code(kind), declared.summary, shape]);
        },
    })),
    { id: 'lifecycle:states', signature: signatureOf(LC_STATES), render: () => '' },
    { id: 'lifecycle:inputs', signature: signatureOf(inputKinds().map(kind => [kind, LC_INPUTS[kind].stamped, LC_INPUTS[kind].states, 'modes' in LC_INPUTS[kind] ? LC_INPUTS[kind].modes : null, fieldSignature(LC_INPUTS[kind].fields)])), render: () => '' },
    { id: 'lifecycle:effects', signature: signatureOf(effectKinds().map(kind => [kind, effectShape(kind)])), render: () => '' },
    { id: 'lifecycle:transitions', signature: signatureOf(transitionSignature()), render: () => '' },
];

export const lifecycle: Extractor = {
    items,
    regions: {
        'lifecycle-inputs': () => table(['Input', 'From', 'Generation it carries', 'States it can arrive in', 'Modes', 'Fields'], items().filter(item => item.id.startsWith('lifecycle:input:')).map(item => item.render())),
        'lifecycle-effects': () => table(['Effect', 'What it does', 'Fields'], items().filter(item => item.id.startsWith('lifecycle:effect:')).map(item => item.render())),
        'lifecycle-states': () => table(['State', 'Inputs that can arrive in it'], LC_STATES.map(state => row([code(state), inputKinds().filter(kind => (LC_INPUTS[kind].states as readonly string[]).includes(state)).map(code).join(', ')]))),
        'lifecycle-diagram': diagram,
    },
};
