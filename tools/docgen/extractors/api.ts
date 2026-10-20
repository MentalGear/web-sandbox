/**
 * The reference parts of docs/API.md that the public API declares: the element's property and methods, the events with
 * their details, the option types `fetchBridge` and `callLimits`, and the list of exports. They are rendered from the TSDoc
 * of the exports, as api-extractor's doc model keeps it (etc/web-sandbox.api.json, read by ./api-model.ts), so a doc is
 * written once, next to the code. The guide parts of the page stay handwritten, and a section that describes an export
 * names it in a marker (`api:Name` or `api:Name.member`), which goes stale when its declaration changes.
 *
 * Where a doc names a fact the code holds as a value, the value is rendered, not copied into the doc: which events bubble
 * (ELEMENT_EVENTS) and which file types a commit takes without `{ code: true }` (INERT_TYPES).
 */
import path from 'node:path';
import { ID_CITATION, resolveId } from '../../../docs/ids';
import { ELEMENT_EVENTS } from '../../../src/lib/element-events';
import { INERT_TYPES } from '../../../src/lib/guest-writes';
import { signatureOf, type Item } from '../engine';
import { flatten, oneLine, readApiModel, type ApiMember } from './api-model';
import { code, codeList, row, table, type Extractor } from './markdown';

const MODEL = path.resolve(import.meta.dirname, '../../../etc/web-sandbox.api.json');

let loaded: ApiMember[] | undefined;
const model = (): ApiMember[] => (loaded ??= readApiModel(MODEL));

/** The one export called `name` (the class and the interface that share `WebSandbox` are told apart by `kind`). */
function exported(name: string, kind?: ApiMember['kind']): ApiMember {
    const found = model().filter(item => item.name === name && (kind === undefined || item.kind === kind));
    if (found.length !== 1) throw new Error(`docgen: the API model has ${found.length} exports called ${name}${kind ? ` (${kind})` : ''}`);
    return found[0]!;
}

// ---- TSDoc as Markdown

const isId = (token: string) => new RegExp(`^(?:${ID_CITATION.source})$`).test(token);
const isAdr = (token: string) => token.startsWith('ADR-');

/** An ADR citation as a link, relative to docs/API.md. */
function adrLink(id: string): string {
    const target = resolveId(id);
    if (!target) throw new Error(`docgen: ${id} is not an ADR of the registry (docs/ids.ts)`);
    return `[${id}](${target.file.replace(/^docs\//, '')}${target.anchor ? `#${target.anchor}` : ''})`;
}

/**
 * A doc's text as the page says it. `{@link X}` is the name as code; a citation of a finding or an item, written in
 * parentheses by itself (`(R1:R3-6)`), is left out, since the page states what holds and not the story; an ADR is a link;
 * `docs/API.md#slug` is a link within the page. An ID cited any other way is a mistake of the doc's, and fails here.
 */
export function prose(text: string, where: string): string {
    const out = text
        .replace(/\{@link\s+([^}|]+?)\s*\|\s*([^}]+?)\s*\}/g, (_, _name: string, label: string) => label)
        .replace(/\{@link\s+([^}]+?)\s*\}/g, (_, name: string) => code(name))
        .replace(/docs\/API\.md#([a-z0-9-]+)/g, (_, slug: string) => `[${slug.charAt(0).toUpperCase()}${slug.slice(1).replace(/-/g, ' ')}](#${slug})`)
        .replace(/\s*\(([^()]+)\)/g, (whole, inner: string) => {
            const parts = inner.split(',').map(part => part.trim());
            return parts.every(part => isId(part) && !isAdr(part)) ? '' : whole;
        })
        .replace(new RegExp(ID_CITATION.source, 'g'), id => (isAdr(id) ? adrLink(id) : `\u0000${id}\u0000`));
    const left = [...out.matchAll(/\u0000([^\u0000]+)\u0000/g)].map(match => match[1]!);
    if (left.length > 0) throw new Error(`docgen: the TSDoc of ${where} cites ${left.join(', ')} outside parentheses; cite a finding or an item as "(ID)" by itself, which the page leaves out`);
    return out;
}

/** The first sentence of a doc's summary, for a table that lists what each export is. */
const firstSentence = (text: string): string => /^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;

/** A type as a table cell shows it: whitespace folded, a bare alias of string literals written out. */
function shownType(type: string): string {
    const folded = oneLine(type);
    const alias = /^\w+$/.test(folded) ? model().find(item => item.kind === 'TypeAlias' && item.name === folded) : undefined;
    return alias && /^'[^']*'(?: \| '[^']*')*$/.test(oneLine(alias.type)) ? oneLine(alias.type) : folded;
}

/** A doc's summary and remarks, one after the other. */
const body = (member: ApiMember, where = member.path): string => [member.doc.summary, member.doc.remarks].filter(Boolean).map(text => prose(text, where)).join('\n\n');

// ---- Regions

/** The order the page presents the element's methods in; a method it does not name follows, by name. */
export const METHOD_ORDER = ['setConfig', 'load', 'reset', 'terminate', 'execute', 'expose', 'call', 'callWithTimeout', 'registerFiles', 'unregisterFiles', 'listFiles', 'listGuestWrites', 'commitGuestWrites'];

/** Things a doc says that a value holds, rendered after the method's own text. */
const APPENDICES: Readonly<Record<string, () => string>> = {
    'WebSandbox.commitGuestWrites': () => `The inert types, exactly: ${codeList([...INERT_TYPES].sort())}.`,
};

const REACTIONS = ['connectedCallback', 'disconnectedCallback', 'adoptedCallback'];

const webSandbox = () => exported('WebSandbox', 'Class');

/** The element's methods in the page's order: everything public that is not a property, a constructor or a reaction. */
export function methods(): ApiMember[] {
    const all = webSandbox().members.filter(member => member.kind === 'Method' && !REACTIONS.includes(member.name));
    const rank = (member: ApiMember) => (METHOD_ORDER.includes(member.name) ? METHOD_ORDER.indexOf(member.name) : METHOD_ORDER.length);
    return [...all].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The order a table lists the fields of an interface in (the model sorts them by name); a field it does not name follows, by name. */
const FIELD_ORDER: Readonly<Record<string, readonly string[]>> = {
    SandboxLog: ['type', 'level', 'args', 'source'],
    SandboxViolation: ['directive', 'blockedURI', 'sourceFile', 'lineNumber', 'columnNumber', 'source'],
    FetchBridgeConfig: ['allow', 'maxBytes', 'timeoutMs', 'methods', 'headers', 'maxConcurrent'],
    CallLimits: ['maxPerSecond', 'maxBytesPerSecond'],
};

function fieldsOf(owner: ApiMember): ApiMember[] {
    const order = FIELD_ORDER[owner.name] ?? [];
    const rank = (member: ApiMember) => (order.includes(member.name) ? order.indexOf(member.name) : order.length);
    return [...owner.members].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** `name(a, b?, ...c)`: a method as its heading writes it. */
const heading = (member: ApiMember): string => `${member.name}(${member.parameters.map(parameter => `${parameter.rest ? '...' : ''}${parameter.name}${parameter.optional ? '?' : ''}`).join(', ')})`;

const bullets = (entries: readonly (readonly [string, string])[], where: string) => entries.map(([name, text]) => `- ${code(name)}: ${prose(text, where)}`).join('\n');

/** A function or method: its heading (none for `null`), its signature, its text and its parameters, result and refusals. */
function renderCallable(member: ApiMember, title: string | null): string {
    const where = member.path;
    const { doc } = member;
    const parts = [...(title === null ? [] : [`### ${code(title)}`]), ['```ts', oneLine(member.declaration), '```'].join('\n'), body(member)];
    const typeParams = Object.entries(doc.typeParams);
    if (typeParams.length > 0) parts.push(`**Type parameters**\n\n${bullets(typeParams, where)}`);
    const params = member.parameters.map(parameter => [`${parameter.rest ? '...' : ''}${parameter.name}`, doc.params[parameter.name] ?? ''] as const);
    if (params.length > 0) parts.push(`**Parameters**\n\n${bullets(params, where)}`);
    if (doc.returns) parts.push(`**Returns:** ${prose(doc.returns, where)}`);
    for (const thrown of doc.throws) parts.push(`**Throws:** ${prose(thrown, where)}`);
    const appendix = APPENDICES[where];
    if (appendix) parts.push(appendix());
    return parts.join('\n\n');
}

/** The sentence a doc ends with to say whether an event bubbles, taken out of the text: the table has a column for it. */
const BUBBLES = /\s*(Does not bubble|Bubbles)\.(?=\s|$)/;

/** The event map's members in the order of ELEMENT_EVENTS, each checked against it: the same events, the same bubbling. */
function events(): { name: string; member: ApiMember; bubbles: boolean }[] {
    const map = exported('WebSandboxEventMap');
    const names = Object.keys(ELEMENT_EVENTS);
    const declared = map.members.map(member => member.name.replace(/^["']|["']$/g, ''));
    if (names.slice().sort().join() !== declared.slice().sort().join()) {
        throw new Error(`docgen: WebSandboxEventMap declares ${declared.join(', ')} but the element dispatches ${names.join(', ')} (src/lib/element-events.ts)`);
    }
    return names.map(name => {
        const member = map.members.find(candidate => candidate.name.replace(/^["']|["']$/g, '') === name)!;
        const bubbles = ELEMENT_EVENTS[name as keyof typeof ELEMENT_EVENTS].bubbles;
        const said = BUBBLES.exec(`${member.doc.summary} ${member.doc.remarks}`)?.[1];
        if (said === undefined || (said === 'Bubbles') !== bubbles) throw new Error(`docgen: the TSDoc of WebSandboxEventMap.${name} must say "${bubbles ? 'Bubbles' : 'Does not bubble'}." (ELEMENT_EVENTS)`);
        return { name, member, bubbles };
    });
}

/** `CustomEvent<…>` as the `detail` column writes it. */
function detailOf(type: string): string {
    const inner = /^CustomEvent<([\s\S]*)>$/.exec(oneLine(type))?.[1] ?? type;
    return inner === 'null' ? 'none' : code(shownType(inner).replace(/\breadonly /g, '').replace(/;?\s*}$/, ' }'));
}

/** A table of the properties of an interface: field, type and meaning, the optional ones marked `?`. */
function fieldTable(owner: ApiMember): string {
    return table(['Field', 'Type', 'Meaning'], fieldsOf(owner).map(member => row([
        code(member.name),
        code(`${shownType(member.type)}${member.optional ? '?' : ''}`),
        body(member, member.path).replace(/\n+/g, ' '),
    ])));
}

/** A table of the options of an option type: field, type, default and what it does. */
function optionTable(owner: ApiMember): string {
    return table(['Field', 'Type', 'Default', 'What it does'], fieldsOf(owner).map(member => row([
        code(member.name),
        code(shownType(member.type)),
        member.doc.defaultValue ? prose(member.doc.defaultValue, member.path) : member.optional ? 'none' : '(required)',
        body(member, member.path).replace(/\n+/g, ' '),
    ])));
}

function renderEvents(): string {
    const map = exported('WebSandboxEventMap');
    return [body(map), eventTable()].join('\n\n');
}

function eventTable(): string {
    return table(['Event', '`detail`', 'Bubbles', 'When'], events().map(({ name, member, bubbles }) => row([
        code(name),
        detailOf(member.type),
        bubbles ? 'yes' : 'no',
        prose(`${member.doc.summary} ${member.doc.remarks}`.replace(BUBBLES, '').replace(/\s+/g, ' ').trim(), `WebSandboxEventMap.${name}`),
    ])));
}

function renderElement(): string {
    const properties = webSandbox().members.filter(member => member.kind === 'Property');
    return table(['Property', 'Type', 'Description'], properties.map(member => row([
        code(member.name),
        `${code(shownType(member.type))}${member.readonly ? ' (read-only)' : ''}`,
        body(member, member.path).replace(/\n+/g, ' '),
    ])));
}

function renderReactions(): string {
    return REACTIONS.map(name => {
        const member = webSandbox().members.find(candidate => candidate.name === name);
        if (!member) throw new Error(`docgen: WebSandbox has no ${name}`);
        return `- ${code(`${name}()`)}: ${body(member).replace(/\n+/g, ' ')}`;
    }).join('\n');
}

/** The first sentence of each export, for the lists of what the package exports. */
const exportRow = (member: ApiMember) => row([code(member.name), prose(firstSentence(member.doc.summary), member.path)]);

const KIND_ORDER = ['Function', 'Class', 'Variable'];

function renderValues(): string {
    const values = model().filter(member => KIND_ORDER.includes(member.kind));
    const ordered = [...values].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
    return table(['Export', 'What it is'], ordered.map(exportRow));
}

function renderTypes(): string {
    const types = model().filter(member => member.kind === 'Interface' || member.kind === 'TypeAlias');
    // the interface that shares the class's name adds the typed listeners to it; the class is listed
    return table(['Type', 'What it is'], [...types].filter(member => !(member.kind === 'Interface' && member.name === 'WebSandbox')).sort((a, b) => a.name.localeCompare(b.name)).map(exportRow));
}

function renderFetchRecord(): string {
    const record = exported('FetchRecord');
    return [prose(record.doc.summary, 'FetchRecord'), record.doc.remarks && prose(record.doc.remarks, 'FetchRecord'), ['```ts', record.declaration, '```'].join('\n')].filter(Boolean).join('\n\n');
}

// ---- Items for the markers: `api:Name` and `api:Name.member`

/** What a declaration is, to the digit of a marker: never its doc, which is rendered above and checked as a region. */
const declarationOf = (member: ApiMember) => ({ kind: member.kind, declaration: oneLine(member.declaration), optional: member.optional, readonly: member.readonly });

const items = (): Item[] => {
    const byId = new Map<string, unknown[]>();
    const add = (id: string, signature: unknown) => byId.set(id, [...(byId.get(id) ?? []), signature]);
    for (const member of flatten(model())) {
        if (member.name === '') continue; // a constructor is part of its class's signature
        // a container's signature has its members', so a section that describes the element or an option type goes stale
        // when one of them changes; a member's has its own declaration (overloads share an ID)
        add(`api:${member.path}`, member.members.length > 0 ? { ...declarationOf(member), members: member.members.map(child => [child.name, declarationOf(child)]) } : declarationOf(member));
    }
    return [...byId.entries()].map(([id, signature]) => ({ id, signature: signatureOf(signature), render: () => '' }));
};

export const api: Extractor = {
    items,
    regions: {
        'api-element': renderElement,
        'api-reactions': renderReactions,
        'api-define': () => renderCallable(exported('defineWebSandbox'), null),
        'api-methods': () => methods().map(method => renderCallable(method, heading(method))).join('\n\n'),
        'api-events': renderEvents,
        'api-sandbox-log': () => fieldTable(exported('SandboxLog')),
        'api-violation': () => [body(exported('SandboxViolation')), fieldTable(exported('SandboxViolation'))].join('\n\n'),
        'api-fetch-record': renderFetchRecord,
        'api-fetch-bridge': () => [body(exported('FetchBridgeConfig')), optionTable(exported('FetchBridgeConfig'))].join('\n\n'),
        'api-call-limits': () => optionTable(exported('CallLimits')),
        'api-exports-values': renderValues,
        'api-exports-types': renderTypes,
    },
};
