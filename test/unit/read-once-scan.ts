import { SyntaxKind, tokenize, type Token } from '../../scripts/js-tokens';

/**
 * The read-once scan (class G, research 18; R5:N-6): in a function, a property of one value is read at
 * most once. A value the guest supplies (an option object, an event, a thrown value) can answer each read differently
 * through a getter or a Proxy, so library code that reads `init.method` to check it and again to use it has checked
 * one value and used another. The scan counts every
 * read of `x.p` (and `x?.p`) in the function that declares `x`, nested closures included, wherever the reads are, not
 * only `typeof x.p … x.p` in one statement.
 *
 * What counts as one function's value: its parameters and the `const`, `let` and `var` it declares, outside nested
 * functions that declare the same name again. What counts as a read: `x.p` or `x?.p` where `x` is not itself a
 * property (`a.x.p` is a read of `a.x`, counted as `a.x`), and the read is not the target of a plain assignment
 * (`x.p = v`). Computed reads (`x[k]`) are not counted: the guest-realm code reads its own lists by index.
 *
 * Works on the text a function's toString() gives (the compiled JavaScript the guest receives), with TypeScript's own
 * scanner (scripts/js-tokens.ts); the brackets decide where a function's parameters and body are.
 */

export interface RepeatedRead {
    /** The value and the property, `init.method`. */
    read: string;
    /** How often it is read in the function that declares the value. */
    count: number;
}

const OPEN: Partial<Record<SyntaxKind, SyntaxKind>> = {
    [SyntaxKind.OpenParenToken]: SyntaxKind.CloseParenToken,
    [SyntaxKind.OpenBraceToken]: SyntaxKind.CloseBraceToken,
    [SyntaxKind.OpenBracketToken]: SyntaxKind.CloseBracketToken,
};

// The index of each bracket's partner (template substitutions are braces too: js-tokens rescans their ends).
function partners(tokens: Token[]): number[] {
    const partner = new Array<number>(tokens.length).fill(-1);
    const stack: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const kind = tokens[i]!.kind;
        if (kind in OPEN || kind === SyntaxKind.TemplateHead) {
            stack.push(i);
            continue;
        }
        const closes = kind === SyntaxKind.CloseParenToken || kind === SyntaxKind.CloseBraceToken || kind === SyntaxKind.CloseBracketToken || kind === SyntaxKind.TemplateTail;
        if (!closes) continue;
        const open = stack.pop();
        if (open === undefined) continue;
        partner[open] = i;
        partner[i] = open;
    }
    return partner;
}

interface Scope {
    // tokens [start, end) of the body
    start: number;
    end: number;
    names: Set<string>;
}

// The plain identifiers of a parameter list (tokens between the parentheses), defaults skipped; patterns are not names.
function parameterNames(tokens: Token[], partner: number[], from: number, to: number): string[] {
    const names: string[] = [];
    let expectName = true;
    for (let i = from; i < to; i++) {
        const token = tokens[i]!;
        if (token.kind in OPEN) {
            i = partner[i]!;
            expectName = false;
            continue;
        }
        if (token.kind === SyntaxKind.CommaToken) {
            expectName = true;
            continue;
        }
        if (token.kind === SyntaxKind.DotDotDotToken) continue;
        if (expectName && token.kind === SyntaxKind.Identifier) names.push(token.text);
        expectName = false;
    }
    return names;
}

// Where an expression body that starts at `from` ends: the first `,` `;` or closing bracket at its own depth.
function expressionEnd(tokens: Token[], partner: number[], from: number): number {
    for (let i = from; i < tokens.length; i++) {
        const kind = tokens[i]!.kind;
        if (kind in OPEN || kind === SyntaxKind.TemplateHead) {
            i = partner[i]! >= 0 ? partner[i]! : i;
            continue;
        }
        if (kind === SyntaxKind.CommaToken || kind === SyntaxKind.SemicolonToken || kind === SyntaxKind.CloseParenToken || kind === SyntaxKind.CloseBraceToken || kind === SyntaxKind.CloseBracketToken) return i;
    }
    return tokens.length;
}

function scopes(tokens: Token[], partner: number[]): Scope[] {
    const found: Scope[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const kind = tokens[i]!.kind;
        let params: string[] | null = null;
        let bodyStart = -1;
        if (kind === SyntaxKind.FunctionKeyword) {
            let open = i + 1;
            while (open < tokens.length && tokens[open]!.kind !== SyntaxKind.OpenParenToken) open++;
            const close = partner[open]!;
            if (close < 0 || tokens[close + 1]?.kind !== SyntaxKind.OpenBraceToken) continue;
            params = parameterNames(tokens, partner, open + 1, close);
            bodyStart = close + 1;
        } else if (kind === SyntaxKind.EqualsGreaterThanToken) {
            const before = tokens[i - 1]!;
            if (before.kind === SyntaxKind.CloseParenToken) {
                const open = partner[i - 1]!;
                params = parameterNames(tokens, partner, open + 1, i - 1);
            } else if (before.kind === SyntaxKind.Identifier) {
                params = [before.text];
            } else continue;
            bodyStart = i + 1;
        } else if (kind === SyntaxKind.OpenParenToken && tokens[i - 1]?.kind === SyntaxKind.Identifier && tokens[partner[i]! + 1]?.kind === SyntaxKind.OpenBraceToken
            && (tokens[i - 2]?.kind === SyntaxKind.OpenBraceToken || tokens[i - 2]?.kind === SyntaxKind.CommaToken || tokens[i - 2]?.kind === SyntaxKind.CloseBraceToken)
            && !['if', 'for', 'while', 'switch', 'catch', 'with'].includes(tokens[i - 1]!.text)) {
            // a method of an object literal or a class: `name(a) { … }`
            const close = partner[i]!;
            params = parameterNames(tokens, partner, i + 1, close);
            bodyStart = close + 1;
        } else continue;
        const start = bodyStart;
        const end = tokens[start]?.kind === SyntaxKind.OpenBraceToken ? partner[start]! : expressionEnd(tokens, partner, start);
        if (end < 0) continue;
        found.push({ start, end, names: new Set(params) });
    }
    // the declarations of each function: the ones whose innermost enclosing function it is
    for (let i = 0; i < tokens.length; i++) {
        const kind = tokens[i]!.kind;
        if (kind !== SyntaxKind.ConstKeyword && kind !== SyntaxKind.LetKeyword && kind !== SyntaxKind.VarKeyword) continue;
        const name = tokens[i + 1];
        if (name?.kind !== SyntaxKind.Identifier) continue;
        const owner = innermost(found, i);
        if (owner) owner.names.add(name.text);
    }
    return found;
}

function innermost(found: Scope[], at: number): Scope | null {
    let best: Scope | null = null;
    for (const scope of found) {
        if (at < scope.start || at >= scope.end) continue;
        if (!best || scope.start > best.start) best = scope;
    }
    return best;
}

/** Every value of every function in `source` whose property is read more than once in that function. */
export function repeatedReads(source: string): RepeatedRead[] {
    const tokens = tokenize(source);
    const partner = partners(tokens);
    const found = scopes(tokens, partner);
    const counts = new Map<string, number>();
    for (let i = 1; i + 1 < tokens.length; i++) {
        const dot = tokens[i]!;
        if (dot.kind !== SyntaxKind.DotToken && dot.kind !== SyntaxKind.QuestionDotToken) continue;
        const value = tokens[i - 1]!;
        const property = tokens[i + 1]!;
        if (value.kind !== SyntaxKind.Identifier || property.kind !== SyntaxKind.Identifier) continue;
        const previous = tokens[i - 2];
        if (previous && (previous.kind === SyntaxKind.DotToken || previous.kind === SyntaxKind.QuestionDotToken)) continue; // a property itself
        const next = tokens[i + 2];
        if (next?.kind === SyntaxKind.EqualsToken) continue; // an assignment, not a read
        // the function that declares the value: the innermost one that has the name
        let owner: Scope | null = null;
        for (const scope of found) {
            if (i < scope.start || i >= scope.end || !scope.names.has(value.text)) continue;
            if (!owner || scope.start > owner.start) owner = scope;
        }
        if (!owner) continue;
        const key = `${owner.start}:${value.text}.${property.text}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeated: RepeatedRead[] = [];
    for (const [key, count] of counts) {
        if (count > 1) repeated.push({ read: key.slice(key.indexOf(':') + 1), count });
    }
    return repeated;
}
