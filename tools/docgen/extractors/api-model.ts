/**
 * The public API as api-extractor's doc model describes it (etc/web-sandbox.api.json, written from the compiled
 * declarations by `bun run api:update`): every export with its declaration and its TSDoc, parsed into plain data. The
 * model is JSON, so this reads it with no compiler and no extra dependency; the TSDoc blocks api-extractor keeps as text
 * are split here (`parseDocComment`). The renderers of extractors/api.ts and the coverage test read the result.
 */
import { readFileSync } from 'node:fs';

/** The TSDoc of one declaration, split by tag. The text of each part is Markdown with `{@link …}` left as written. */
export interface Doc {
    readonly summary: string;
    /** The `@remarks` block. */
    readonly remarks: string;
    /** `@param name - text`, by name. */
    readonly params: Readonly<Record<string, string>>;
    /** `@typeParam name - text`, by name. */
    readonly typeParams: Readonly<Record<string, string>>;
    readonly returns: string;
    /** One entry per `@throws`. */
    readonly throws: readonly string[];
    readonly defaultValue: string;
    /** One entry per `@example`. */
    readonly examples: readonly string[];
}

export interface ApiParameter {
    readonly name: string;
    readonly type: string;
    readonly optional: boolean;
    /** A rest parameter (`...args`). */
    readonly rest: boolean;
}

/** The kinds of declaration the model holds that this package exports. */
export type ApiKind = 'Variable' | 'Function' | 'Class' | 'Interface' | 'TypeAlias' | 'Constructor' | 'Method' | 'MethodSignature' | 'Property' | 'PropertySignature';

export interface ApiMember {
    readonly kind: ApiKind;
    /** `''` for a constructor. */
    readonly name: string;
    /** `Class.member`, or the export's name; overloads share one. */
    readonly path: string;
    readonly doc: Doc;
    /** The declaration as the `.d.ts` writes it, without `export declare` and the final `;`, whitespace as written. */
    readonly declaration: string;
    /** The declared type: of a property, a variable or a type alias; `''` for the others. */
    readonly type: string;
    readonly parameters: readonly ApiParameter[];
    /** The return type of a function or method; `''` for the others. */
    readonly returnType: string;
    /** `<T = unknown>` and the like; `''` when there is none. */
    readonly typeParameters: string;
    readonly optional: boolean;
    readonly readonly: boolean;
    readonly members: readonly ApiMember[];
}

interface Token { kind: string; text: string }
interface Range { startIndex: number; endIndex: number }
interface RawMember {
    kind: string;
    name?: string;
    docComment?: string;
    excerptTokens: Token[];
    members?: RawMember[];
    parameters?: { parameterName: string; parameterTypeTokenRange: Range; isOptional: boolean }[];
    returnTypeTokenRange?: Range;
    propertyTypeTokenRange?: Range;
    variableTypeTokenRange?: Range;
    typeTokenRange?: Range;
    typeParameters?: { typeParameterName: string; constraintTokenRange: Range; defaultTypeTokenRange: Range }[];
    isOptional?: boolean;
    isReadonly?: boolean;
    isStatic?: boolean;
}

/** The text of the tokens in `range`. */
const textOf = (tokens: readonly Token[], range?: Range): string => (range ? tokens.slice(range.startIndex, range.endIndex).map(token => token.text).join('') : '');

/** `<T = unknown>` from the model's type parameter list; the tokens it points into are the declaration's. */
function typeParametersOf(raw: RawMember): string {
    if (!raw.typeParameters?.length) return '';
    const parts = raw.typeParameters.map(parameter => {
        const constraint = textOf(raw.excerptTokens, parameter.constraintTokenRange);
        const fallback = textOf(raw.excerptTokens, parameter.defaultTypeTokenRange);
        return `${parameter.typeParameterName}${constraint ? ` extends ${constraint}` : ''}${fallback ? ` = ${fallback}` : ''}`;
    });
    return `<${parts.join(', ')}>`;
}

/** A `/** … *\/` block split into its tags. A line that starts with an `@tag` begins a block, except inside a code fence. */
export function parseDocComment(raw: string | undefined): Doc {
    const lines = (raw ?? '').replace(/^\s*\/\*\*/, '').replace(/\*\/\s*$/, '').split('\n').map(line => line.replace(/^\s*\* ?/, '').replace(/\s+$/, ''));
    const blocks: { tag: string; lines: string[] }[] = [{ tag: 'summary', lines: [] }];
    let fenced = false;
    for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        const start = fenced ? null : /^@([A-Za-z]+)\b\s*(.*)$/.exec(line);
        if (start) blocks.push({ tag: start[1]!, lines: [start[2]!] });
        else blocks[blocks.length - 1]!.lines.push(line);
    }
    const text = (block: { lines: string[] }) => block.lines.join('\n').trim();
    const named = (tag: string): Record<string, string> => {
        const out: Record<string, string> = {};
        for (const block of blocks.filter(candidate => candidate.tag === tag)) {
            const match = /^([\w$]+)\s*-\s*([\s\S]*)$/.exec(text(block));
            if (match) out[match[1]!] = match[2]!.trim();
        }
        return out;
    };
    const first = (tag: string) => {
        const block = blocks.find(candidate => candidate.tag === tag);
        return block ? text(block) : '';
    };
    const all = (tag: string) => blocks.filter(candidate => candidate.tag === tag).map(text);
    return {
        summary: text(blocks[0]!),
        remarks: first('remarks'),
        params: named('param'),
        typeParams: named('typeParam'),
        returns: first('returns'),
        throws: all('throws'),
        defaultValue: first('defaultValue'),
        examples: all('example'),
    };
}

function member(raw: RawMember, parent: string): ApiMember {
    const tokens = raw.excerptTokens;
    const name = raw.name ?? '';
    const path = parent && name ? `${parent}.${name}` : parent || name;
    const parameters = (raw.parameters ?? []).map((parameter): ApiParameter => {
        const type = textOf(tokens, parameter.parameterTypeTokenRange);
        return { name: parameter.parameterName, type, optional: parameter.isOptional, rest: tokens.some(token => token.text.includes(`...${parameter.parameterName}`)) };
    });
    const type = textOf(tokens, raw.propertyTypeTokenRange ?? raw.variableTypeTokenRange ?? raw.typeTokenRange);
    const declaration = tokens.map(token => token.text).join('').replace(/^export (declare )?/, '').replace(/;\s*$/, '').trim();
    return {
        kind: raw.kind as ApiKind,
        name,
        path,
        doc: parseDocComment(raw.docComment),
        declaration,
        type,
        parameters,
        returnType: textOf(tokens, raw.returnTypeTokenRange),
        typeParameters: typeParametersOf(raw),
        optional: raw.isOptional === true,
        readonly: raw.isReadonly === true,
        members: (raw.members ?? []).map(child => member(child, path)),
    };
}

/** The package's exports (the entry point's members), in the model's order: sorted by name. */
export function readApiModel(file: string): ApiMember[] {
    const model = JSON.parse(readFileSync(file, 'utf8')) as { members: { kind: string; members: RawMember[] }[] };
    const entry = model.members.find(candidate => candidate.kind === 'EntryPoint');
    if (!entry) throw new Error(`${file} has no entry point: it is not an api-extractor doc model`);
    return entry.members.map(raw => member(raw, ''));
}

/** Every member of the model with its descendants, parents first. */
export function flatten(members: readonly ApiMember[]): ApiMember[] {
    return members.flatMap(item => [item, ...flatten(item.members)]);
}

/** Whitespace folded: how a type is shown in a table cell or compared in a signature. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
