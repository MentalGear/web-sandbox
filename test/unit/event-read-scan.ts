import { SyntaxKind, tokenize, type Token } from '../../scripts/js-tokens';
import { expressionEnd, partners, scopes, type Scope } from './read-once-scan';

/**
 * The event-read scan (class G, research 18, "One reader for guest values at the boundary"; BD1:TST-1, S80): in the
 * code that runs in a guest realm, nothing reads a member of an event the platform hands a listener, except
 * SAFE_EVENT_READS. An event's fields (`reason`, `message`, `error`, `data`, ...) are accessors on a prototype the guest
 * can replace, so a listener reads them through the getters captured before guest code runs (readEvent, and the
 * captured `dataOf`/`portsOf` and the strict prelude's `errorEventMessage`), which take the event as an argument and
 * are not member reads of it.
 *
 * What it enumerates is the registrations, never a name. Every place where a function is handed to the platform as a
 * listener is a site: a use of a captured `addEventListener` (a sink: a variable whose initializer names
 * `addEventListener`, or the setter of an `on…` property), a direct `.addEventListener(` call, and an assignment to an
 * `on…` property. At each site the scan follows the value to the functions it can be: an inline function, a named one, a
 * variable's initializer, and what a local function returns (the egress table's listeners come out of `listenerFor`).
 * A site with no function the scan can follow is an error, and so is any use of `addEventListener` or an `on…` name the
 * scan does not understand, so a registration it cannot see fails the test rather than going unscanned. A listener's
 * first parameter is the event whatever it is called: a destructured or rest first parameter is itself a read and an
 * error.
 *
 * The event is then followed: through an alias (`const e = event`), and as an argument to a local function (whose
 * parameter is followed in turn). A member read of it (`event.reason`, `event?.reason`, `event[k]`), a destructuring, a
 * spread, `in`, and putting the event into an object or array literal that is not a call's argument list, are errors.
 * What it does not follow: a value returned from a function call or stored in a property (`o.e = event`), which the
 * read-once and capture scans do not cover either; the structure of the library's own code keeps events in parameters.
 *
 * SAFE_EVENT_READS is `isTrusted` alone: the one own, non-configurable property of the instance (WebIDL's
 * [LegacyUnforgeable] on Event), which no guest code can redefine on an event the platform made; one a guest makes
 * itself is not trusted, and says so. The backlog's `type` and `defaultPrevented` are accessors of Event.prototype
 * that the guest can replace, and no listener needs them (a listener knows its type from its registration, and
 * cancelling goes through the captured preventDefault), so they are not allowed.
 *
 * Works on the text a function's toString() gives (the compiled JavaScript the guest receives), with the tokens of
 * scripts/js-tokens.ts and the function scopes of read-once-scan.ts.
 */

export const SAFE_EVENT_READS: ReadonlySet<string> = new Set(['isTrusted']);

export interface EventReadReport {
    /** "line: what", one per violation. */
    findings: string[];
    /** The registration sites the scan found. */
    sites: number;
    /** The distinct functions it scanned as listeners (or as helpers an event is passed to). */
    handlers: number;
}

const ON_PROPERTY = /^on[a-z]+$/;
const ON_PROPERTY_LITERAL = /^['"]on[a-z]+['"]$/;

export function eventReads(source: string): EventReadReport {
    const tokens = tokenize(source);
    const partner = partners(tokens);
    const found = scopes(tokens, partner);
    const findings: string[] = [];
    const report = (at: number, what: string) => findings.push(`${source.slice(0, tokens[at]!.start).split('\n').length}: ${what}`);

    const isOpen = (kind: SyntaxKind) => kind === SyntaxKind.OpenParenToken || kind === SyntaxKind.OpenBraceToken || kind === SyntaxKind.OpenBracketToken;
    const isClose = (kind: SyntaxKind) => kind === SyntaxKind.CloseParenToken || kind === SyntaxKind.CloseBraceToken || kind === SyntaxKind.CloseBracketToken;
    const isSelf = (i: number) => tokens[i]!.kind === SyntaxKind.Identifier && tokens[i - 1]?.kind !== SyntaxKind.DotToken && tokens[i - 1]?.kind !== SyntaxKind.QuestionDotToken;
    // The innermost bracket open at `index`: its index, or -1.
    const enclosing = (index: number) => {
        for (let i = index - 1; i >= 0; i--) {
            const kind = tokens[i]!.kind;
            if (isClose(kind) && partner[i]! >= 0) i = partner[i]!;
            else if (isOpen(kind)) return i;
        }
        return -1;
    };
    const within = (scope: Scope, at: number) => at >= scope.start && at < scope.end;

    // ---- what a name is: the functions declared with it, and the ranges that initialise it
    const declaredFunctions = new Map<string, Scope[]>();
    const initializers = new Map<string, [number, number][]>();
    const push = <T>(map: Map<string, T[]>, key: string, value: T) => map.set(key, [...(map.get(key) ?? []), value]);
    for (let i = 0; i + 1 < tokens.length; i++) {
        const kind = tokens[i]!.kind;
        const name = tokens[i + 1]!;
        if (kind === SyntaxKind.FunctionKeyword && name.kind === SyntaxKind.Identifier) {
            const scope = found.find(candidate => candidate.at === i);
            if (scope) push(declaredFunctions, name.text, scope);
        }
        const declares = kind === SyntaxKind.ConstKeyword || kind === SyntaxKind.LetKeyword || kind === SyntaxKind.VarKeyword;
        if (declares && name.kind === SyntaxKind.Identifier && tokens[i + 2]?.kind === SyntaxKind.EqualsToken) push(initializers, name.text, [i + 3, expressionEnd(tokens, partner, i + 3)]);
    }

    // The functions a range of tokens can hold as values: its outermost inline functions, the functions its names are
    // declared as or initialised with, and what the local functions it calls return.
    const functionsIn = (from: number, to: number, seen: Set<string>): Set<Scope> => {
        const values = new Set<Scope>();
        const inline = found.filter(scope => scope.at >= from && scope.at < to);
        for (const scope of inline) {
            if (!inline.some(other => other !== scope && within(other, scope.at))) values.add(scope);
        }
        for (let i = from; i < to; i++) {
            if (!isSelf(i) || inline.some(scope => within(scope, i))) continue;
            const name = tokens[i]!.text;
            const called = tokens[i + 1]?.kind === SyntaxKind.OpenParenToken;
            for (const scope of called ? returnedBy(name, seen) : named(name, seen)) values.add(scope);
        }
        return values;
    };
    const named = (name: string, seen: Set<string>): Set<Scope> => {
        const values = new Set<Scope>();
        if (seen.has(name)) return values;
        seen.add(name);
        for (const scope of declaredFunctions.get(name) ?? []) values.add(scope);
        for (const [from, to] of initializers.get(name) ?? []) for (const scope of functionsIn(from, to, seen)) values.add(scope);
        return values;
    };
    const returnedBy = (name: string, seen: Set<string>): Set<Scope> => {
        const values = new Set<Scope>();
        for (const scope of named(name, new Set())) {
            if (tokens[scope.start]!.kind !== SyntaxKind.OpenBraceToken) {
                for (const found of functionsIn(scope.start, scope.end, seen)) values.add(found);
                continue;
            }
            for (let i = scope.start; i < scope.end; i++) {
                if (tokens[i]!.kind !== SyntaxKind.ReturnKeyword || innermost(i) !== scope) continue;
                for (const found of functionsIn(i + 1, expressionEnd(tokens, partner, i + 1), seen)) values.add(found);
            }
        }
        return values;
    };
    const innermost = (at: number): Scope | null => {
        let best: Scope | null = null;
        for (const scope of found) if (within(scope, at) && (!best || scope.start > best.start)) best = scope;
        return best;
    };

    // ---- the sites
    const registers: [number, number][] = []; // the token range whose functions are registered
    const sinks = new Set<string>();
    const sinkRanges: [number, number][] = [];
    for (const [name, ranges] of initializers) {
        for (const [from, to] of ranges) {
            let names = false;
            for (let i = from; i < to; i++) names ||= tokens[i]!.text === 'addEventListener' || (tokens[i]!.kind === SyntaxKind.StringLiteral && ON_PROPERTY_LITERAL.test(tokens[i]!.text));
            if (!names) continue;
            sinks.add(name);
            sinkRanges.push([from, to]);
        }
    }
    const inSink = (i: number) => sinkRanges.some(([from, to]) => i >= from && i < to);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (inSink(i)) continue;
        if (isSelf(i) && sinks.has(token.text) && tokens[i - 1]?.kind !== SyntaxKind.TypeOfKeyword && !isDeclaredName(i)) {
            const open = enclosing(i);
            registers.push(open < 0 ? [0, tokens.length] : [open + 1, partner[open]! >= 0 ? partner[open]! : tokens.length]);
            continue;
        }
        const member = tokens[i - 1]?.kind === SyntaxKind.DotToken || tokens[i - 1]?.kind === SyntaxKind.QuestionDotToken;
        if (token.kind === SyntaxKind.Identifier && member && token.text === 'addEventListener') {
            if (tokens[i + 1]?.kind !== SyntaxKind.OpenParenToken) report(i, 'addEventListener used other than as a captured value or a call');
            else registers.push([i + 2, partner[i + 1]!]);
            continue;
        }
        if (token.kind === SyntaxKind.Identifier && member && ON_PROPERTY.test(token.text) && tokens[i + 1]?.kind === SyntaxKind.EqualsToken) {
            registers.push([i + 2, expressionEnd(tokens, partner, i + 2)]);
            continue;
        }
        if (token.kind === SyntaxKind.StringLiteral && ON_PROPERTY_LITERAL.test(token.text)) report(i, `the name ${token.text} used outside a captured setter`);
        if (token.kind === SyntaxKind.Identifier && token.text === 'addEventListener' && !member) report(i, 'addEventListener used outside a captured value');
    }
    function isDeclaredName(i: number): boolean {
        const before = tokens[i - 1]?.kind;
        return (before === SyntaxKind.ConstKeyword || before === SyntaxKind.LetKeyword || before === SyntaxKind.VarKeyword) && tokens[i + 1]?.kind === SyntaxKind.EqualsToken;
    }

    // ---- the listeners, and where an event goes from them
    const queue: [Scope, number][] = [];
    const queued = new Set<string>();
    const enqueue = (scope: Scope, index: number) => {
        const key = `${scope.at}:${index}`;
        if (queued.has(key)) return;
        queued.add(key);
        queue.push([scope, index]);
    };
    for (const [from, to] of registers) {
        const handlers = functionsIn(from, to, new Set());
        if (handlers.size === 0) report(from, 'a registration whose listener the scan cannot follow');
        for (const scope of handlers) enqueue(scope, 0);
    }

    // The k-th parameter of a function: its name, or null for none, and a finding for a pattern or a rest parameter.
    const parameterAt = (scope: Scope, k: number): string | null => {
        let index = 0;
        let from = scope.params.from;
        for (let i = scope.params.from; i <= scope.params.to; i++) {
            const kind = i < scope.params.to ? tokens[i]!.kind : SyntaxKind.CommaToken;
            if (isOpen(kind) && partner[i]! >= 0) i = partner[i]!;
            if (i < scope.params.to && kind !== SyntaxKind.CommaToken) continue;
            if (index === k && i > from) {
                const first = tokens[from]!;
                if (first.kind === SyntaxKind.Identifier) return first.text;
                report(from, first.kind === SyntaxKind.DotDotDotToken ? 'a rest parameter where the event is' : 'a destructured parameter where the event is');
                return null;
            }
            index++;
            from = i + 1;
        }
        return null;
    };
    const argumentIndex = (open: number, at: number) => {
        let index = 0;
        for (let i = open + 1; i < at; i++) {
            if (isOpen(tokens[i]!.kind) && partner[i]! >= 0) i = partner[i]!;
            else if (tokens[i]!.kind === SyntaxKind.CommaToken) index++;
        }
        return index;
    };
    const isLiteralOpen = (open: number) => {
        const before = tokens[open - 1]?.kind;
        if (tokens[open]!.kind === SyntaxKind.OpenBraceToken) return before === SyntaxKind.EqualsToken || before === SyntaxKind.OpenParenToken || before === SyntaxKind.CommaToken || before === SyntaxKind.ColonToken || before === SyntaxKind.ReturnKeyword || before === SyntaxKind.OpenBracketToken;
        // an array literal, unless it is an index (`list[i]`)
        return before !== SyntaxKind.Identifier && before !== SyntaxKind.CloseParenToken && before !== SyntaxKind.CloseBracketToken && before !== SyntaxKind.CloseBraceToken;
    };
    const isCallArguments = (open: number) => tokens[open]!.kind === SyntaxKind.OpenParenToken && tokens[open - 1]?.kind === SyntaxKind.Identifier;

    const names = new Map<Scope, Set<string>>();
    while (queue.length > 0) {
        const [scope, index] = queue.shift()!;
        const name = parameterAt(scope, index);
        if (name === null) continue;
        const known = names.get(scope) ?? new Set<string>();
        names.set(scope, known);
        known.add(name);
        for (let grew = true; grew;) {
            grew = false;
            for (const event of [...known]) {
                // nested functions that declare the name again have another value under it
                const shadowed = found.filter(nested => nested !== scope && nested.start > scope.start && nested.end <= scope.end && nested.names.has(event));
                for (let i = scope.start; i < scope.end; i++) {
                    if (tokens[i]!.text !== event || !isSelf(i)) continue;
                    if (shadowed.some(nested => i >= nested.params.from && i < nested.end)) continue;
                    const before = tokens[i - 1]?.kind;
                    const after = tokens[i + 1]?.kind;
                    const open = enclosing(i);
                    if ((before === SyntaxKind.OpenBraceToken || before === SyntaxKind.CommaToken) && after === SyntaxKind.ColonToken) continue; // an object's key
                    if (after === SyntaxKind.DotToken || after === SyntaxKind.QuestionDotToken) {
                        const property = tokens[i + 2]!.text;
                        if (!SAFE_EVENT_READS.has(property)) report(i, `a member read of the event: ${event}.${property}`);
                        continue;
                    }
                    if (after === SyntaxKind.OpenBracketToken) report(i, `a computed read of the event: ${event}[…]`);
                    else if (before === SyntaxKind.DotDotDotToken) report(i, 'the event spread');
                    else if (before === SyntaxKind.InKeyword || before === SyntaxKind.OfKeyword) report(i, 'the event iterated or tested with in');
                    else if (before === SyntaxKind.EqualsToken && (tokens[i - 2]?.kind === SyntaxKind.CloseBraceToken || tokens[i - 2]?.kind === SyntaxKind.CloseBracketToken)) report(i, 'the event destructured');
                    else if (before === SyntaxKind.EqualsToken && tokens[i - 2]?.kind === SyntaxKind.Identifier) {
                        const alias = tokens[i - 2]!.text;
                        if (!known.has(alias)) {
                            known.add(alias);
                            grew = true;
                        }
                    } else if (open >= 0 && isLiteralOpen(open) && !isCallArguments(enclosing(open)) && (before === SyntaxKind.ColonToken || before === SyntaxKind.OpenBraceToken || before === SyntaxKind.CommaToken || before === SyntaxKind.OpenBracketToken)) {
                        report(i, 'the event put in a literal');
                    } else if (open >= 0 && tokens[open]!.kind === SyntaxKind.OpenParenToken && isSelf(open - 1) && (before === SyntaxKind.OpenParenToken || before === SyntaxKind.CommaToken) && (after === SyntaxKind.CommaToken || after === SyntaxKind.CloseParenToken)) {
                        for (const callee of named(tokens[open - 1]!.text, new Set())) enqueue(callee, argumentIndex(open, i));
                    }
                }
            }
        }
    }
    return { findings, sites: registers.length, handlers: names.size };
}
