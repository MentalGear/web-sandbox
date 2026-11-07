import { SyntaxKind, tokenize, type Token } from '../../scripts/js-tokens';
import { graphOf, unitOf } from './call-graph';

/**
 * Which functions of the host realm receive guest content (HOST_PASSES, src/lib/host-passes.ts; class A's third realm):
 * from the places guest content enters (GUEST_ENTRIES: an element member and the names in it that hold the content), it
 * follows the content through the call graph of src/ (test/unit/call-graph.ts) and answers every unit a call hands it to.
 *
 * Conservative, as the graph is: it reads tokens, not types. Inside a unit a name holds guest content when a parameter
 * that received it, a declaration or an assignment from an expression that names one, a loop over one, or a callback's
 * parameter of a call on one does; an expression names one when any of its names does. A call of a unit with such an
 * argument hands that unit the parameter at its position; a class, or an object an element field holds (FIELD_UNITS),
 * receives it as a whole: every parameter in it holds guest content then. A unit's text stringified into another realm
 * (`name.toString()`) is not a call.
 */

export interface GuestEntryPoint {
    readonly member: string;
    readonly holds: readonly string[];
}

/** A unit that received guest content, and how: the parameters (by position) that hold it, or `all`. */
export interface Received {
    readonly unit: string;
    readonly trail: readonly string[];
}

// The element's fields that hold an object of the library's: a call of a method on one is a call into its unit.
const FIELD_UNITS: Readonly<Record<string, string>> = {
    _files: 'src/lib/files.ts#FileStore',
    _broker: 'src/lib/rpc.ts#createBroker',
    _guestWrites: 'src/lib/guest-writes.ts#createGuestWrites',
    _fetchBridge: 'src/lib/fetch-bridge.ts#createFetchBridge',
    _resizer: 'src/lib/auto-resize.ts#startAutoResize',
};

const OPEN = new Set([SyntaxKind.OpenParenToken, SyntaxKind.OpenBraceToken, SyntaxKind.OpenBracketToken, SyntaxKind.TemplateHead]);
const CLOSE = new Set([SyntaxKind.CloseParenToken, SyntaxKind.CloseBraceToken, SyntaxKind.CloseBracketToken, SyntaxKind.TemplateTail]);

// The index of each bracket's partner (a template's head and tail are a pair; its middles are inside it).
function partners(tokens: readonly Token[]): number[] {
    const partner = new Array<number>(tokens.length).fill(-1);
    const stack: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const kind = tokens[i]!.kind;
        if (OPEN.has(kind)) {
            stack.push(i);
            continue;
        }
        if (!CLOSE.has(kind)) continue;
        const open = stack.pop();
        if (open === undefined) continue;
        partner[open] = i;
        partner[i] = open;
    }
    return partner;
}

/** The text of `this.a.b` chains, as one string, starting at a `this` token: `this._config.html`. */
function chainAt(tokens: readonly Token[], at: number): string {
    let text = 'this';
    for (let i = at + 1; i + 1 < tokens.length; i += 2) {
        const dot = tokens[i]!.kind;
        if (dot !== SyntaxKind.DotToken && dot !== SyntaxKind.QuestionDotToken) break;
        text += `.${tokens[i + 1]!.text}`;
    }
    return text;
}

/** Whether a unit's text is code that can be called: a function, a method, an arrow, a class. */
export function isCode(text: string | undefined): boolean {
    if (text === undefined) return false;
    const first = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
    if (/^\s*(export\s+)?(async\s+)?(function|class)\b/.test(first) || /^ {4}(private |public |static |async |get |set )*\w+\s*\(/.test(first)) return true;
    const arrow = /=\s*(async\s+)?(<[^>]*>)?\s*\(/.test(first) && first.includes('=>');
    return arrow || /=\s*(async\s+)?\w+\s*=>/.test(first) || /=\s*function\b/.test(first);
}

class UnitScan {
    readonly tokens: Token[];
    readonly partner: number[];
    readonly names = new Set<string>();

    constructor(readonly node: string, readonly reads: readonly string[]) {
        this.tokens = tokenize(unitOf(node) ?? '');
        this.partner = partners(this.tokens);
    }

    /** Whether tokens [from, to) name guest content: a held name, or a read of the element's state that holds it. */
    names_(from: number, to: number): boolean {
        for (let i = from; i < to; i++) {
            const token = this.tokens[i]!;
            if (token.kind === SyntaxKind.ThisKeyword) {
                const chain = chainAt(this.tokens, i);
                if (this.reads.some(read => chain === read || chain.startsWith(`${read}.`))) return true;
                continue;
            }
            if (token.kind !== SyntaxKind.Identifier) continue;
            const before = this.tokens[i - 1]?.kind;
            if (before === SyntaxKind.DotToken || before === SyntaxKind.QuestionDotToken) continue; // a property name
            if (this.names.has(token.text)) return true;
        }
        return false;
    }

    /** The end of the expression that starts at `from`: the first `,` `;` or closing bracket at its own depth. */
    expressionEnd(from: number): number {
        for (let i = from; i < this.tokens.length; i++) {
            const kind = this.tokens[i]!.kind;
            if (OPEN.has(kind) && this.partner[i]! > i) {
                i = this.partner[i]!;
                continue;
            }
            if (kind === SyntaxKind.CommaToken || kind === SyntaxKind.SemicolonToken || CLOSE.has(kind)) return i;
        }
        return this.tokens.length;
    }

    /** The plain names a binding pattern or parameter declares, in [from, to): its identifiers before any type or default. */
    declared(from: number, to: number): string[] {
        const out: string[] = [];
        let depth = 0;
        for (let i = from; i < to; i++) {
            const token = this.tokens[i]!;
            if (OPEN.has(token.kind)) depth++;
            if (CLOSE.has(token.kind)) depth--;
            // a type annotation or a default value at the top of the binding ends what it declares
            if (depth === 0 && (token.kind === SyntaxKind.ColonToken || token.kind === SyntaxKind.EqualsToken)) break;
            if (token.kind === SyntaxKind.Identifier && this.tokens[i - 1]?.kind !== SyntaxKind.DotToken) out.push(token.text);
        }
        return out;
    }

    /** The parameters of the first parameter list in [from, to) (a function's, a method's, an arrow's), as name lists by position. */
    parametersAt(open: number): string[][] {
        const close = this.partner[open]!;
        const out: string[][] = [];
        let start = open + 1;
        for (let i = open + 1; i <= close; i++) {
            const kind = this.tokens[i]!.kind;
            if (OPEN.has(kind) && i !== close && this.partner[i]! > i) {
                i = this.partner[i]!;
                continue;
            }
            if (kind !== SyntaxKind.CommaToken && i !== close) continue;
            if (i > start) out.push(this.declared(start, i).filter(name => !['private', 'readonly', 'public', 'protected'].includes(name)));
            start = i + 1;
        }
        return out;
    }

    /** The unit's own parameters: its first parameter list. */
    ownParameters(): string[][] {
        const open = this.tokens.findIndex(token => token.kind === SyntaxKind.OpenParenToken);
        return open < 0 ? [] : this.parametersAt(open);
    }

    /** Every name any parameter list of the unit declares: what a unit that receives guest content as a whole holds. */
    everyParameter(): string[] {
        const out: string[] = [];
        for (let i = 0; i < this.tokens.length; i++) {
            if (this.tokens[i]!.kind !== SyntaxKind.OpenParenToken) continue;
            const close = this.partner[i]!;
            const after = this.tokens[close + 1]?.kind;
            const isList = after === SyntaxKind.EqualsGreaterThanToken || after === SyntaxKind.OpenBraceToken || after === SyntaxKind.ColonToken;
            if (isList) for (const names of this.parametersAt(i)) out.push(...names);
        }
        for (let i = 1; i < this.tokens.length; i++) {
            // a single parameter without parentheses: `x => …`
            if (this.tokens[i]!.kind === SyntaxKind.EqualsGreaterThanToken && this.tokens[i - 1]!.kind === SyntaxKind.Identifier) out.push(this.tokens[i - 1]!.text);
        }
        return out;
    }

    /** One pass of the propagation inside the unit: whether a name was added. */
    propagate(): boolean {
        const before = this.names.size;
        const { tokens } = this;
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]!;
            // const/let/var <binding> = <expression>
            if (token.kind === SyntaxKind.ConstKeyword || token.kind === SyntaxKind.LetKeyword || token.kind === SyntaxKind.VarKeyword) {
                let equals = -1;
                for (let j = i + 1; j < tokens.length; j++) {
                    const kind = tokens[j]!.kind;
                    if (OPEN.has(kind) && this.partner[j]! > j) {
                        j = this.partner[j]!;
                        continue;
                    }
                    if (kind === SyntaxKind.EqualsToken) {
                        equals = j;
                        break;
                    }
                    // `for (const x of y)`: the loop's binding holds what its iterable does
                    if (tokens[j]!.text === 'of' || tokens[j]!.text === 'in') {
                        const end = this.expressionEnd(j + 1);
                        if (this.names_(j + 1, end)) for (const name of this.declared(i + 1, j)) this.names.add(name);
                        break;
                    }
                    if (kind === SyntaxKind.SemicolonToken || CLOSE.has(kind)) break;
                }
                if (equals < 0) continue;
                const end = this.expressionEnd(equals + 1);
                if (this.names_(equals + 1, end)) for (const name of this.declared(i + 1, equals)) this.names.add(name);
                continue;
            }
            // <name> = <expression>, and <name> ??= / ||= <expression>
            const assigns = token.kind === SyntaxKind.EqualsToken || token.kind === SyntaxKind.QuestionQuestionEqualsToken || token.kind === SyntaxKind.BarBarEqualsToken || token.kind === SyntaxKind.PlusEqualsToken;
            if (assigns && tokens[i - 1]?.kind === SyntaxKind.Identifier && tokens[i - 2]?.kind !== SyntaxKind.DotToken) {
                const end = this.expressionEnd(i + 1);
                if (this.names_(i + 1, end)) this.names.add(tokens[i - 1]!.text);
                continue;
            }
            // a callback's parameters, given to a call on something that holds guest content: `files.filter(entry => …)`
            if (token.kind === SyntaxKind.EqualsGreaterThanToken) {
                const params = this.arrowParameters(i);
                const call = this.enclosingCall(i);
                if (call >= 0 && this.names_(this.calleeStart(call), call)) for (const name of params) this.names.add(name);
            }
        }
        return this.names.size > before;
    }

    /** The names an arrow at `at` (the `=>` token) declares. */
    arrowParameters(at: number): string[] {
        const previous = this.tokens[at - 1]!;
        if (previous.kind === SyntaxKind.Identifier) return [previous.text];
        if (previous.kind !== SyntaxKind.CloseParenToken) return [];
        return this.parametersAt(this.partner[at - 1]!).flat();
    }

    /** The `(` of the call whose arguments hold the token at `at`, or -1. */
    enclosingCall(at: number): number {
        for (let i = at - 1; i >= 0; i--) {
            if (this.tokens[i]!.kind !== SyntaxKind.OpenParenToken || this.partner[i]! < at) continue;
            const callee = this.tokens[i - 1]?.kind;
            return callee === SyntaxKind.Identifier || callee === SyntaxKind.CloseParenToken || callee === SyntaxKind.CloseBracketToken ? i : -1;
        }
        return -1;
    }

    /** Where the callee chain of the call at `open` starts: `a.b(c).d` back to `a`. */
    calleeStart(open: number): number {
        let i = open - 1;
        while (i >= 0) {
            const kind = this.tokens[i]!.kind;
            if (CLOSE.has(kind)) {
                i = this.partner[i]! - 1;
                continue;
            }
            if (kind === SyntaxKind.Identifier || kind === SyntaxKind.ThisKeyword) {
                const before = this.tokens[i - 1]?.kind;
                if (before === SyntaxKind.DotToken || before === SyntaxKind.QuestionDotToken) {
                    i -= 2;
                    continue;
                }
                return i;
            }
            return i + 1;
        }
        return 0;
    }

    /** The arguments of the call whose `(` is at `open`, as token ranges. */
    argumentsAt(open: number): [number, number][] {
        const close = this.partner[open]!;
        const out: [number, number][] = [];
        let start = open + 1;
        for (let i = open + 1; i <= close; i++) {
            const kind = this.tokens[i]!.kind;
            if (OPEN.has(kind) && i !== close && this.partner[i]! > i) {
                i = this.partner[i]!;
                continue;
            }
            if (kind !== SyntaxKind.CommaToken && i !== close) continue;
            if (i > start) out.push([start, i]);
            start = i + 1;
        }
        return out;
    }

    /** The units this one hands guest content to: a unit and its parameter positions, or `all`. */
    handsOn(): Map<string, Set<number> | 'all'> {
        const { units, imports } = graphOf(this.node.split('#')[0]!);
        const file = this.node.split('#')[0]!;
        const out = new Map<string, Set<number> | 'all'>();
        const give = (unit: string, position: number | 'all') => {
            if (!isCode(unitOf(unit))) return; // a value of no code (a table, a constant) receives nothing
            const known = out.get(unit);
            if (known === 'all') return;
            if (position === 'all') {
                out.set(unit, 'all');
                return;
            }
            out.set(unit, (known ?? new Set<number>()).add(position));
        };
        const { tokens } = this;
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]!;
            if (token.kind !== SyntaxKind.Identifier) continue;
            const before = tokens[i - 1]?.kind;
            const isMember = before === SyntaxKind.DotToken || before === SyntaxKind.QuestionDotToken;
            let unit: string | undefined;
            let whole = false;
            if (isMember && tokens[i - 2]?.kind === SyntaxKind.ThisKeyword) {
                if (units.has(`this.${token.text}`)) unit = `${file}#this.${token.text}`;
                else if (FIELD_UNITS[token.text] && tokens[i + 1]?.kind === SyntaxKind.DotToken) {
                    // this._files.register(files): a call on the object the field holds
                    const method = i + 2;
                    const open = tokens[method + 1]?.kind === SyntaxKind.OpenParenToken ? method + 1 : -1;
                    if (open >= 0 && this.argumentsAt(open).some(([from, to]) => this.names_(from, to))) give(FIELD_UNITS[token.text]!, 'all');
                    continue;
                }
            } else if (!isMember) {
                unit = units.has(token.text) ? `${file}#${token.text}` : imports.get(token.text);
                whole = before === SyntaxKind.NewKeyword;
            }
            if (!unit) continue;
            if (tokens[i + 1]?.kind === SyntaxKind.DotToken && tokens[i + 2]?.text === 'toString') continue; // stringified, not called
            if (tokens[i + 1]?.kind === SyntaxKind.OpenParenToken) {
                const args = this.argumentsAt(i + 1);
                args.forEach(([from, to], position) => {
                    if (this.names_(from, to)) give(unit!, whole || /#[A-Z]/.test(unit!) ? 'all' : position);
                });
                continue;
            }
            // a unit handed as a callback to a call on guest content: `entries.map(entryText)`
            const call = this.enclosingCall(i);
            if (call >= 0 && this.names_(this.calleeStart(call), call)) give(unit, 'all');
        }
        return out;
    }
}

/** Every unit guest content reaches from `entries`, with the trail that reached it. */
export function guestContentUnits(entries: readonly GuestEntryPoint[]): Map<string, Received> {
    const reached = new Map<string, Received>();
    const held = new Map<string, Set<string>>(); // the names already followed in a unit
    const queue: { node: string; names: string[]; reads: readonly string[]; trail: string[] }[] = [];
    for (const entry of entries) {
        const node = `src/host.ts#this.${entry.member}`;
        const names = entry.holds.filter(name => !name.startsWith('this.'));
        const reads = entry.holds.filter(name => name.startsWith('this.'));
        queue.push({ node, names, reads, trail: [node] });
    }
    while (queue.length > 0) {
        const { node, names, reads, trail } = queue.shift()!;
        const known = held.get(node) ?? new Set<string>();
        const fresh = names.filter(name => !known.has(name));
        if (reached.has(node) && fresh.length === 0 && reads.length === 0) continue;
        for (const name of fresh) known.add(name);
        held.set(node, known);
        if (!reached.has(node)) reached.set(node, { unit: node, trail });
        if (node === 'src/host.ts#step' || unitOf(node) === undefined) continue;
        const scan = new UnitScan(node, reads);
        for (const name of known) scan.names.add(name);
        for (let pass = 0; pass < 8 && scan.propagate(); pass++);
        for (const [unit, positions] of scan.handsOn()) {
            const next = new UnitScan(unit, []);
            const params = next.ownParameters();
            const given = positions === 'all' ? next.everyParameter() : [...positions].flatMap(position => params[position] ?? []);
            queue.push({ node: unit, names: given, reads: [], trail: [...trail, unit] });
        }
    }
    return reached;
}
