import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyntaxKind, tokenize, type Token } from '../../scripts/js-tokens';

/**
 * The host page's policy comes from `hostContentSecurityPolicy` alone (BD4:CHL-1, BD4:CHL-2; class A, the host page's
 * context a sandbox document inherits, INHERITED_CONTEXT.cspFetch). No API returns a page's policy, so code that learns it
 * from the page predicts a browser's state: a decoy request whose violation reports the policy's text, a hidden frame to
 * make it in, a wait for its answer. Each such prediction was found wrong (a policy that admits the decoy is never seen; a
 * host long task outlasts the wait). The chokepoint is hostReach (src/lib/csp/host-connect.ts), which decides a build's
 * connect lists from the option alone; this file keeps it the only decision and keeps src/ from asking the page:
 *  - no code of src/ names the read's parts, reads a violation's policy text, listens for the host page's violations,
 *    or reads the page's `<meta>` policy;
 *  - hostReach is called once, by host.ts `_reach`, with the stored option, and the option is read nowhere else in
 *    host.ts but by the Trusted Types rule (host-trusted-types.ts, which reads the same text).
 * The other two ways to ask (a frame of the host's own, a request of the host's own) are closed by
 * test/unit/frame-isolation.test.ts (every frame of src/ is a sandbox's) and test/unit/structural.test.ts (no code of
 * src/ names the platform's fetch outside the guest bootstrap and the bridge's frame). The rule's table is
 * test/unit/host-connect.test.ts ("hostReach"), and its wiring in the element test/unit/host.test.ts.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceFiles = (directory: string): string[] => readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
});
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** Names of the read of the page's policy, and of the build's wait for it: none may come back. */
const READ_NAMES = [
    'knownHostPolicies', 'whenHostPoliciesKnown', 'hostPolicyReaderLeft', 'hostPolicyReadFailed', 'forgetHostPolicies',
    'READ_FRAMES', 'READ_TIMEOUT_MS', 'DECOY_URL', 'DECOY_HOST', 'DECOY_PORT', 'HostPolicySource', 'POLICY_UNREADABLE', 'buildGate', '_buildGate',
];

/** Files whose listener for `securitypolicyviolation` runs in a realm of the sandbox's own, not in the host page, with why. */
const SANDBOX_REALM_LISTENERS: Readonly<Record<string, string>> = {
    'src/lib/in-sandbox-view.ts': "the strict view's own document reports its violations (egress.ts, the view's row)",
};

const isString = (token: Token | undefined): boolean => token !== undefined && (token.kind === SyntaxKind.StringLiteral || token.kind === SyntaxKind.NoSubstitutionTemplateLiteral);
const unquoted = (token: Token): string => token.text.slice(1, -1);

/** What in `text` asks the page for its policy, as `file: what` lines. `file` decides only the allowlists. */
function asksThePage(file: string, text: string): string[] {
    const tokens = tokenize(text);
    const found: string[] = [];
    const say = (what: string) => found.push(`${file}: ${what}`);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        const next = tokens[i + 1];
        if (token.kind === SyntaxKind.Identifier && READ_NAMES.includes(token.text)) say(token.text);
        if (isString(token) && /host-csp/.test(token.text)) say(`a module of the read (${token.text})`);
        // the one API that reports a page's policy text: a violation's `originalPolicy`
        if (token.kind === SyntaxKind.Identifier && token.text === 'originalPolicy') say('originalPolicy');
        if (isString(token) && unquoted(token) === 'originalPolicy') say("'originalPolicy'");
        // a listener for the violations of a document of the host page's
        const listens = token.text === 'addEventListener' && next?.kind === SyntaxKind.OpenParenToken && isString(tokens[i + 2]) && unquoted(tokens[i + 2]!).toLowerCase() === 'securitypolicyviolation';
        if ((listens || token.text === 'onsecuritypolicyviolation') && !(file in SANDBOX_REALM_LISTENERS)) say('a securitypolicyviolation listener');
        // the page's own `<meta>` policy, read from its document
        if (/^(querySelector|querySelectorAll|getElementsByTagName|closest|matches)$/.test(token.text) && next?.kind === SyntaxKind.OpenParenToken && isString(tokens[i + 2]) && /meta|http-equiv/i.test(unquoted(tokens[i + 2]!))) say(`${token.text}(${tokens[i + 2]!.text})`);
    }
    return found;
}

/** The token range of a method's body: the braces after `private <name>(…)…`. */
function methodBody(tokens: Token[], name: string): [number, number] {
    const at = tokens.findIndex((token, i) => token.text === name && tokens[i - 1]?.kind === SyntaxKind.PrivateKeyword && tokens[i + 1]?.kind === SyntaxKind.OpenParenToken);
    if (at < 0) throw new Error(`no method ${name}`);
    let open = at + 1;
    while (tokens[open]!.kind !== SyntaxKind.OpenBraceToken) open++;
    let depth = 0;
    for (let i = open; i < tokens.length; i++) {
        if (tokens[i]!.kind === SyntaxKind.OpenBraceToken) depth++;
        if (tokens[i]!.kind === SyntaxKind.CloseBraceToken && --depth === 0) return [open, i];
    }
    throw new Error(`unbalanced ${name}`);
}

describe("the host page's policy comes from hostContentSecurityPolicy alone (BD4:CHL-1, BD4:CHL-2)", () => {
    it('no code of src/ asks the page for its policy: no part of a read, no violation text, no listener for its violations, no read of its <meta>', () => {
        const found: string[] = [];
        for (const file of sourceFiles('src')) found.push(...asksThePage(file, read(file)));
        expect(found).toEqual([]);
    });

    it("positive control: the scan flags each way the read asked, and lets the view's own listener through", () => {
        const spellings: Record<string, string> = {
            'a name of the read': 'const answer = knownHostPolicies();',
            'its wait': 'await whenHostPoliciesKnown(root);',
            'its module': "import { DECOY_URL } from './lib/host-csp';",
            'the build gate': 'const gate = host.buildGate?.() ?? null;',
            "a violation's policy text": "doc.addEventListener('x', (event) => seen.push(event.originalPolicy));",
            'the same, destructured': 'const { disposition, originalPolicy } = event;',
            "the host page's violations": "document.addEventListener('securitypolicyviolation', onViolation);",
            'the same, by a handler': 'frame.contentWindow.onsecuritypolicyviolation = onViolation;',
            "the page's <meta> policy": `const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');`,
        };
        for (const [what, code] of Object.entries(spellings)) expect(asksThePage('src/host.ts', code), what).not.toEqual([]);
        // the same words in a comment or a string that is not one of the patterns are not code that asks
        expect(asksThePage('src/host.ts', "// knownHostPolicies, originalPolicy\nconst text = 'the policy is not read';")).toEqual([]);
        for (const file of Object.keys(SANDBOX_REALM_LISTENERS)) {
            const text = read(file);
            expect(asksThePage(file, text), file).toEqual([]);
            expect(asksThePage('src/host.ts', text), `${file} still listens, or leaves the list`).toContain('src/host.ts: a securitypolicyviolation listener');
        }
    });

    it('hostReach is the one decision: called once, by host.ts `_reach`, with the stored option, which host.ts reads nowhere else but in the Trusted Types rule', () => {
        const calls: string[] = [];
        for (const file of sourceFiles('src')) {
            const tokens = tokenize(read(file));
            tokens.forEach((token, i) => {
                if (token.text === 'hostReach' && tokens[i + 1]?.kind === SyntaxKind.OpenParenToken && tokens[i - 1]?.kind !== SyntaxKind.FunctionKeyword) calls.push(`${file}:${i}`);
            });
        }
        expect(calls).toHaveLength(1);
        const host = read('src/host.ts');
        const tokens = tokenize(host);
        const [open, close] = methodBody(tokens, '_reach');
        const call = Number(calls[0]!.split(':')[1]);
        expect(calls[0]!.startsWith('src/host.ts:') && call > open && call < close, 'the call is in `_reach`').toBe(true);
        const body = tokens.slice(open, close).map(token => token.text).join('');
        expect(body).toContain('hostReach(this._origins,this._fetchPolicy,this._config.hostContentSecurityPolicy,');

        const readers = [methodBody(tokens, '_reach'), methodBody(tokens, '_trustedTypes')];
        const reads = tokens.flatMap((token, i) => (token.text === 'hostContentSecurityPolicy' && tokens[i - 1]?.kind === SyntaxKind.DotToken ? [i] : []));
        expect(reads.length, 'positive control: the scan sees the reads').toBeGreaterThanOrEqual(2);
        for (const index of reads) expect(readers.some(([from, to]) => index > from && index < to), host.slice(tokens[index]!.start - 80, tokens[index]!.end)).toBe(true);
    });
});
