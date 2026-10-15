/**
 * The tokens of a JavaScript or TypeScript text, comments and whitespace left out, as TypeScript's own scanner reads them
 * (typescript/unstable/ast, the dev dependency's JavaScript scanner; no type checker, no compiler process). Shared by
 * scripts/declaration-specifiers.ts (review round 2, C-11: only real import and export specifiers are rewritten, never
 * text in a comment or a string that looks like one) and by the unit test that scans the guest-realm functions for
 * intrinsics read after their capture point (C-1).
 *
 * The scanner alone cannot tell two ambiguities apart, which a parser resolves from context; this resolves them the way
 * a parser would for the texts it is given:
 *   - `}` closes either a block or a template substitution: a stack of open braces says which, and the template's
 *     continuation is then re-scanned as template text;
 *   - `/` starts either a division or a regular expression: after a token that ends an expression (an identifier, a
 *     literal, `)`, `]`, `}`, or a postfix `++`/`--`) it is a division, anywhere else a regular expression, re-scanned as one.
 * A keyword used as a property name (`x.default`) is an identifier token here, as the scanner reads it after a dot.
 */
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';

export interface Token {
    kind: SyntaxKind;
    text: string;
    start: number;
    end: number;
}

// Tokens after which `/` divides: they end an expression.
const ENDS_EXPRESSION = new Set<SyntaxKind>([
    SyntaxKind.Identifier, SyntaxKind.PrivateIdentifier, SyntaxKind.NumericLiteral, SyntaxKind.BigIntLiteral,
    SyntaxKind.StringLiteral, SyntaxKind.RegularExpressionLiteral, SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.TemplateTail, SyntaxKind.CloseParenToken, SyntaxKind.CloseBracketToken, SyntaxKind.CloseBraceToken,
    SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken, SyntaxKind.ThisKeyword, SyntaxKind.SuperKeyword,
    SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword,
]);

export function tokenize(text: string): Token[] {
    const scanner = createScanner(true, undefined, text);
    const out: Token[] = [];
    // one entry per open `{` or template substitution: true for a substitution
    const braces: boolean[] = [];
    for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
        if (kind === SyntaxKind.CloseBraceToken && braces.pop() === true) kind = scanner.reScanTemplateToken(false);
        else if ((kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) && !ENDS_EXPRESSION.has(out.at(-1)?.kind as SyntaxKind)) kind = scanner.reScanSlashToken();
        if (kind === SyntaxKind.OpenBraceToken) braces.push(false);
        if (kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle) braces.push(true);
        out.push({ kind, text: scanner.getTokenText(), start: scanner.getTokenStart(), end: scanner.getTokenEnd() });
    }
    return out;
}

export { SyntaxKind };
