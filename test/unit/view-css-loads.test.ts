import { describe, it, expect, afterEach } from 'vitest';
import { cssLoadBound, inSandboxView, sanitizeRender, VIEW_OPTIONS, VIEW_URLS_PER_SECOND, viewBudget, type ViewOptions } from '@src/lib/in-sandbox-view';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { VIOLATION_DIRECTIVES, violationBucket } from '@src/lib/violation';
import { scalingRatio, type ScalingSize } from './scaling';
import { cssReferences, withoutNetworkReferences } from '@src/lib/css-references';

/**
 * S73 (class E-net and P; R5:M-3, a burst behind a slow server): every load the
 * view's CSS can make is charged before the browser can start it. The CSS an operation applies is counted
 * (cssLoadBound) and prepaid to the load budget with the operation; the loads the platform reports later take from that
 * credit first (viewBudget). The engines' side is in test/e2e/strict-view-budget.spec.ts ("S73").
 */

const R = VIEW_URLS_PER_SECOND;
const count = (css: string) => cssLoadBound(css, R);

describe('S73: cssLoadBound counts every token that can load, as the CSS tokenizer reads it', () => {
    it('url(, in any case and any escape form', () => {
        expect(count('background: url(a.png)')).toBe(1);
        expect(count('background: URL(a.png)')).toBe(1);
        expect(count('background: uRl("a.png")')).toBe(1);
        expect(count('background: u\\72 l(a.png)')).toBe(1); // a hex escape and its whitespace
        expect(count('background: \\75 rl(a.png)')).toBe(1);
        expect(count('background: \\55 RL(a.png)')).toBe(1);
        expect(count('background: \\000075rl(a.png)')).toBe(1); // six digits, no whitespace needed
        expect(count('background: u\\72\r\nl(a.png)')).toBe(1); // CR LF is one whitespace after an escape
        expect(count('background: \\u\\r\\l(a.png)')).toBe(1); // a backslash and a code point that is no hex digit
        expect(count('a{b:url(x)}c{d:url(y)}')).toBe(2);
    });

    it('image-set(, -webkit-image-set(, image(, cross-fade( and src(; a nested image-set(url() url()) counts each', () => {
        expect(count(`background: image-set('a.png' 1x, 'b.png' 2x)`)).toBe(1); // it loads one of them
        expect(count('background: -webkit-image-set(url(a.png) 1x)')).toBe(2);
        expect(count('background: image-set(url(a.png) 1x, url(b.png) 2x)')).toBe(3);
        expect(count(`background: image("a.png")`)).toBe(1);
        expect(count('background: cross-fade(url(a.png), url(b.png))')).toBe(3);
        expect(count(`@font-face { src: src("a.woff") }`)).toBe(1); // the property is no function; src() is
        expect(count('background: \\2d webkit-image-set(url(a))')).toBe(2);
    });

    it('nothing else: an identifier that is not a function, a name that goes on, a broken escape', () => {
        expect(count('color: red; display: block; image-rendering: pixelated; src: local(x)')).toBe(0);
        expect(count('background: url (a.png)')).toBe(0); // no function: the ( does not follow the name
        expect(count('background: urlx(a.png)')).toBe(0);
        expect(count('background: u\\\nrl(a.png)')).toBe(0); // a backslash before a newline is no escape: `u` ends there
        expect(count('background: \\0000075rl(a)')).toBe(0); // seven digits: the escape takes six, "5rl" follows
        expect(count('background: url\\28 a.png)')).toBe(0); // an escaped ( is part of the name, and opens nothing
    });

    it('decided: inside comments and strings, and in the middle of an identifier, it counts all the same (only more)', () => {
        expect(count('/* url(a.png) */ color: red')).toBe(1);
        expect(count(`content: "url(a.png)"`)).toBe(1);
        expect(count(`content: 'image-set(' `)).toBe(1);
        expect(count('background: xurl(a.png)')).toBe(1);
        expect(count('width: 5url(a)')).toBe(1); // a dimension and a ( to the tokenizer
        expect(count('background: \\\\75 rl(a)')).toBe(1); // an escaped backslash, then plain digits, to the tokenizer
        // so no string or comment the tokenizer reads differently can hide one: an escape's whitespace that is a newline
        // keeps a string open, which a skip that ended it at the newline would get wrong
        expect(count('content: "\\41\n"; background: url(a.png)')).toBe(1);
        expect(count('background: url(a"b) url(c.png)')).toBe(2); // a bad url's quote opens no string
        // a backslash in a comment is plain text: whatever the pattern makes of it, the token after the comment counts
        expect(count('/*\\*/url(a) /* \\41*/url(b) /* \\41 */\\75 rl(c)')).toBe(3);
    });

    it('each @import, also escaped, counts the allowance of one sheet', () => {
        expect(count('@import "a.css";')).toBe(R);
        expect(count('@import url(a.css);')).toBe(R + 1);
        expect(count('@IMPORT "a.css"; @\\69mport "b.css"; @\\49 MPORT "c.css";')).toBe(3 * R);
        expect(cssLoadBound('@import "a.css";', 7)).toBe(7);
        expect(count('@media screen { a { color: red } } @font-face { font-family: x }')).toBe(0);
    });

    // A seeded generator, and a name spelled one code point at a time as a literal (either case) or an escape: hex, 1-6
    // digits, either case, with one of the whitespaces or none (none only where the next code point cannot be read as a
    // hex digit or a whitespace, or where six digits were written), or a backslash and the code point itself where it is
    // no hex digit.
    const generator = (seed: number) => {
        const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
        const spell = (ch: string, next: string) => {
            const form = random();
            if (form < 0.4) return random() < 0.5 ? ch.toUpperCase() : ch;
            const isHex = /[0-9a-f]/i.test(ch);
            if (form < 0.55 && !isHex) return '\\' + (random() < 0.5 ? ch.toUpperCase() : ch);
            const code = (random() < 0.5 && /[a-z]/.test(ch) ? ch.toUpperCase() : ch).charCodeAt(0).toString(16);
            const digits = random() < 0.5 ? code.padStart(6, '0') : code.padStart(code.length + Math.floor(random() * (6 - code.length + 1)), '0');
            const hex = random() < 0.5 ? digits.toUpperCase() : digits;
            const space = pick([' ', '\t', '\n', '\r\n', '\f', '\r']);
            const needsSpace = digits.length < 6 && /[0-9a-f \t\n\r\f]/i.test(next);
            return '\\' + hex + (needsSpace || random() < 0.5 ? space : '');
        };
        const word = (name: string) => {
            let out = '';
            for (let i = 0; i < name.length; i++) out += spell(name[i]!, i + 1 < name.length ? name[i + 1]! : '(');
            return out + '(';
        };
        return { random, pick, word };
    };
    const NAMES = ['url', 'image-set', '-webkit-image-set', 'image', 'cross-fade', 'src'];

    it('property: random CSS with N tokens that load, each written in a random escape form, counts at least N', () => {
        const { random, pick, word } = generator(11);
        const FILLER = ['a', 'b{', '}', ';', ':', ' ', '\n', '"', "'", '/*', '*/', '\\', '\\9', ')', '(', '@', '-', 'x', '9', 'url', 'image', '#'];
        for (let run = 0; run < 500; run++) {
            const n = Math.floor(random() * 20);
            let css = '';
            for (let i = 0; i < n; i++) {
                for (let f = Math.floor(random() * 6); f > 0; f--) css += pick(FILLER);
                // a separator, so that each word is a token: an escape the filler ends with can take it, never the word
                css += pick([' ', ';', '\n']) + word(pick(NAMES));
                if (random() < 0.5) css += pick(['a.png)', '"a.png")', "'a' 1x)", ' url(b))']);
            }
            for (let f = Math.floor(random() * 6); f > 0; f--) css += pick(FILLER);
            expect(count(css), JSON.stringify(css)).toBeGreaterThanOrEqual(n);
        }
    });

    // The reference: the tokenizer of css-syntax-3 (4.3), as far as what it says of names (comments, strings, url and bad
    // url tokens, identifiers, functions, at-keywords, hashes, numbers and dimensions, escapes), counting the function
    // tokens named in NAMES, the url tokens, and each @import as `R`.
    const tokenizerCount = (input: string) => {
        const text = input.replace(/\r\n|[\r\f]/g, '\n').replace(/\0/g, '\ufffd');
        const n = text.length;
        const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
        const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
        const isWhite = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n';
        const isStart = (c: string | undefined) => c !== undefined && (/^[A-Za-z_]$/.test(c) || c.charCodeAt(0) >= 0x80);
        const isIdent = (c: string | undefined) => isStart(c) || isDigit(c) || c === '-';
        const validEscape = (a: string | undefined, b: string | undefined) => a === '\\' && b !== '\n';
        const startsIdent = (a: string | undefined, b: string | undefined, c: string | undefined) =>
            a === '-' ? isStart(b) || b === '-' || validEscape(b, c) : isStart(a) ? true : a === '\\' ? validEscape(a, b) : false;
        const startsNumber = (a: string | undefined, b: string | undefined, c: string | undefined) =>
            a === '+' || a === '-' ? isDigit(b) || (b === '.' && isDigit(c)) : a === '.' ? isDigit(b) : isDigit(a);
        const lower = (s: string) => s.replace(/[A-Z]/g, ch => ch.toLowerCase());
        let i = 0;
        let total = 0;
        const escaped = () => { // after the backslash
            if (i >= n) return '\ufffd';
            if (isHex(text[i])) {
                let hex = '';
                while (hex.length < 6 && isHex(text[i])) hex += text[i++];
                if (isWhite(text[i])) i++;
                const code = parseInt(hex, 16);
                return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? '\ufffd' : String.fromCodePoint(code);
            }
            return text[i++]!;
        };
        const identSequence = () => {
            let name = '';
            for (;;) {
                if (isIdent(text[i])) name += text[i++];
                else if (validEscape(text[i], text[i + 1])) { i++; name += escaped(); }
                else return name;
            }
        };
        const badUrlRemnants = () => {
            for (;;) {
                if (i >= n) return;
                if (text[i] === ')') { i++; return; }
                if (validEscape(text[i], text[i + 1])) { i++; escaped(); } else i++;
            }
        };
        const urlToken = () => {
            while (isWhite(text[i])) i++;
            for (;;) {
                const c = text[i];
                if (c === undefined) return;
                if (c === ')') { i++; return; }
                if (isWhite(c)) {
                    while (isWhite(text[i])) i++;
                    if (i >= n) return;
                    if (text[i] === ')') { i++; return; }
                    badUrlRemnants();
                    return;
                }
                if (c === '"' || c === "'" || c === '(' || /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(c)) { badUrlRemnants(); return; }
                if (c === '\\') {
                    if (!validEscape(c, text[i + 1])) { badUrlRemnants(); return; }
                    i++;
                    escaped();
                    continue;
                }
                i++;
            }
        };
        const identLike = () => {
            const name = identSequence();
            if (lower(name) === 'url' && text[i] === '(') {
                i++;
                while (isWhite(text[i]) && isWhite(text[i + 1])) i++;
                const quote = isWhite(text[i]) ? text[i + 1] : text[i];
                total++; // a function token named url, or a url token
                if (quote !== '"' && quote !== "'") urlToken();
                return;
            }
            if (text[i] === '(') {
                i++;
                if (NAMES.indexOf(lower(name)) >= 0) total++;
            }
        };
        const numeric = () => {
            if (text[i] === '+' || text[i] === '-') i++;
            while (isDigit(text[i])) i++;
            if (text[i] === '.' && isDigit(text[i + 1])) { i++; while (isDigit(text[i])) i++; }
            if ((text[i] === 'e' || text[i] === 'E') && (isDigit(text[i + 1]) || ((text[i + 1] === '+' || text[i + 1] === '-') && isDigit(text[i + 2])))) {
                i += 2;
                while (isDigit(text[i])) i++;
            }
            if (startsIdent(text[i], text[i + 1], text[i + 2])) identSequence();
            else if (text[i] === '%') i++;
        };
        while (i < n) {
            if (text[i] === '/' && text[i + 1] === '*') {
                const close = text.indexOf('*/', i + 2);
                i = close < 0 ? n : close + 2;
                continue;
            }
            const c = text[i]!;
            if (isWhite(c)) { while (isWhite(text[i])) i++; continue; }
            if (c === '"' || c === "'") {
                i++;
                for (;;) {
                    if (i >= n) break;
                    const d = text[i]!;
                    if (d === c) { i++; break; }
                    if (d === '\n') break;
                    if (d === '\\') {
                        if (i + 1 >= n) { i++; continue; }
                        if (text[i + 1] === '\n') { i += 2; continue; }
                        i++;
                        escaped();
                        continue;
                    }
                    i++;
                }
                continue;
            }
            if (c === '#') {
                i++;
                if (isIdent(text[i]) || validEscape(text[i], text[i + 1])) identSequence();
                continue;
            }
            if ((c === '+' || c === '.') && startsNumber(c, text[i + 1], text[i + 2])) { numeric(); continue; }
            if (c === '-') {
                if (startsNumber(c, text[i + 1], text[i + 2])) numeric();
                else if (text[i + 1] === '-' && text[i + 2] === '>') i += 3;
                else if (startsIdent(c, text[i + 1], text[i + 2])) identLike();
                else i++;
                continue;
            }
            if (c === '@') {
                i++;
                if (startsIdent(text[i], text[i + 1], text[i + 2]) && lower(identSequence()) === 'import') total += R;
                continue;
            }
            if (c === '\\') {
                if (validEscape(c, text[i + 1])) identLike();
                else i++;
                continue;
            }
            if (isDigit(c)) { numeric(); continue; }
            if (isStart(c)) { identLike(); continue; }
            i++;
        }
        return total;
    };

    it('the reference tokenizer reads the examples as the specification does', () => {
        expect(tokenizerCount('a{background:url(x) image-set("y" 1x) u\\72 l(z)} /* url( */ "url(" xurl( 5url( @import "a"; @\\69mport "b";')).toBe(3 + 2 * R);
        expect(tokenizerCount('background: url(a"b) url(c.png)')).toBe(2);
        expect(tokenizerCount('content: "\\41\n"; background: url(a.png)')).toBe(1);
        expect(tokenizerCount('-webkit-image-set(url(a))')).toBe(2);
        expect(tokenizerCount('\\\\75 rl(a) url\\28 a)')).toBe(0);
    });

    // An explicit budget for fixed work (backlog T6's class): 4000 random texts, each counted three times and tokenized
    // once; the runs are what the property needs, so the work stays. 1.9 s alone at load average 3, 9.0 s in a full run
    // at load average 14, past vitest's 5 s. 60 s, about 30 times the idle cost.
    it('property: on random text, the count is never below the tokens that load, as the tokenizer reads them', { timeout: 60000 }, () => {
        const { random, pick, word } = generator(29);
        const PIECES = ['u', 'r', 'l', 'U', 'R', 'L', 'i', 'm', 'a', 'g', 'e', 's', 't', 'c', 'o', 'f', 'd', 'p', 'x', '-', '_', '(', ')',
            '\\', '\\', '"', "'", '/', '*', '/*', '*/', '@', '#', '.', '+', '5', '7', '2', ' ', '\n', '\r', '\r\n', '\f', '\t', ';', ':', '{', '}',
            'url(', 'image-set(', '@import', '\\75 ', '\\72', '\\6c', '\\55 ', '\\\n', '\u00e9', '\0'];
        let loads = 0;
        for (let run = 0; run < 4000; run++) {
            let css = '';
            for (let k = Math.floor(random() * 60); k > 0; k--) css += random() < 0.1 ? word(pick(NAMES)) : pick(PIECES);
            const reference = tokenizerCount(css);
            loads += reference;
            expect(count(css), JSON.stringify(css)).toBeGreaterThanOrEqual(reference);
            // and the texts of one operation counted joined by newlines (cssLoadsOf) count at least what each counts
            const cuts = [0, ...Array.from({ length: 3 }, () => Math.floor(random() * css.length)).sort((a, b) => a - b), css.length];
            const texts = cuts.slice(1).map((end, k) => css.slice(cuts[k], end));
            expect(count(texts.join('\n')), JSON.stringify(texts)).toBeGreaterThanOrEqual(texts.reduce((sum, text) => sum + count(text), 0));
        }
        expect(loads).toBeGreaterThan(1000); // the texts did hold tokens that load
    });

    // Linear, as a ratio measured in the same run (backlog T9's class: "under a second" measured the machine): 8 times the
    // text takes at most 3 times 8 as long. scalingRatio samples both sizes alternately and keeps each one's fastest time
    // (test/unit/scaling.ts). A count quadratic in the text takes about 64 times as long.
    it('linear in the text: 8 times the CSS that loads (1 MiB) takes about 8 times as long to count, not 64', { timeout: 60000 }, () => {
        const css = (n: number) => 'a{background:url(https://a.example/x.png),image-set("y.png" 1x)}/* u\\72 l( */'.repeat(n);
        const size = (n: number): ScalingSize<number> => () => {
            const text = css(n);
            return { run: () => count(text), verify: found => expect(found).toBe(3 * n) };
        };
        const result = scalingRatio(size(13000 / 8), size(13000), { bound: 24 });
        expect(result.ratio, result.message).toBeLessThan(24);
    });
});

describe('S73: the load budget keeps what the view prepaid as credit, at most a second of the rate', () => {
    const RATES = VIEW_OPTIONS.rates;

    it('a load the platform reports takes the credit first, and is charged only once it is spent', () => {
        const budget = viewBudget(RATES, 0, VIEW_OPTIONS);
        budget.prepay(50, 0);
        expect(budget.held('urls', 0)).toBe(R - 50); // charged when applied, before any load
        expect(budget.credit()).toBe(50);
        budget.observed(30, 0);
        expect(budget.held('urls', 0)).toBe(R - 50);
        expect(budget.credit()).toBe(20);
        budget.observed(30, 0); // 20 from the credit, 10 charged
        expect(budget.held('urls', 0)).toBe(R - 60);
        expect(budget.credit()).toBe(0);
        budget.observed(5, 0);
        expect(budget.held('urls', 0)).toBe(R - 65);
    });

    it('the credit is capped at a second of the rate: what an over-counted operation prepaid past it is forfeited', () => {
        const budget = viewBudget(RATES, 0, VIEW_OPTIONS);
        budget.prepay(5 * R, 0);
        expect(budget.held('urls', 0)).toBe(-4 * R); // all of it charged
        expect(budget.credit()).toBe(R);
        budget.observed(3 * R, 0); // R from the credit, the rest charged again
        expect(budget.held('urls', 0)).toBe(-6 * R);
        expect(budget.credit()).toBe(0);
        // nor do small prepayments add up past it, however many
        for (let i = 0; i < 10; i++) budget.prepay(R / 2, 60000 + i);
        expect(budget.credit()).toBe(R);
    });

    it('property: every load is charged at least once, prepaid or reported, and the credit never holds more than R', () => {
        let seed = 3;
        const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let run = 0; run < 200; run++) {
            const budget = viewBudget({ ...RATES, urls: R }, 0, VIEW_OPTIONS);
            let charged = 0; // what the operations and the reports took, without refill
            let loads = 0;
            let prepaid = 0;
            for (let step = 0; step < 50; step++) {
                const before = budget.held('urls', 0);
                if (random() < 0.5) {
                    const amount = Math.floor(random() * 3 * R);
                    budget.prepay(amount, 0);
                    prepaid += amount;
                } else {
                    const amount = Math.floor(random() * R);
                    budget.observed(amount, 0);
                    loads += amount;
                }
                charged += before - budget.held('urls', 0);
                expect(budget.credit()).toBeLessThanOrEqual(R);
            }
            // the loads reported were charged, except those the credit covered, which they had prepaid
            expect(charged).toBeGreaterThanOrEqual(Math.max(prepaid, loads));
        }
    });
});

describe('S73: the view prepays the CSS each operation applies, and a reported load takes the credit', () => {
    // The view in jsdom, with stand-ins for the platform's resource timing (jsdom has none) and a budget the test can
    // read: every prepay() and observed() the view makes, in order.
    const saved: Record<string, unknown> = {};
    const GLOBALS = ['PerformanceEntry', 'PerformanceObserver', 'PerformanceObserverEntryList', 'Performance', 'Worker'];
    afterEach(() => {
        for (const name of GLOBALS) (globalThis as any)[name] = saved[name];
        delete (globalThis as any).__sandboxViewRuns;
        delete (globalThis as any).__budget;
        delete (globalThis as any).__calls;
        document.body.replaceChildren();
    });
    async function startView() {
        for (const name of GLOBALS) saved[name] = (globalThis as any)[name];
        let report: ((list: unknown) => void) | null = null;
        class Entry { constructor(public readonly url: string) {} get name() { return this.url; } }
        class EntryList { constructor(public readonly entries: Entry[]) {} getEntries() { return this.entries; } }
        class Observer { constructor(callback: (list: unknown) => void) { report = callback; } observe() {} }
        class PerformanceStandIn { clearResourceTimings() {} }
        Object.assign(globalThis, { PerformanceEntry: Entry, PerformanceObserverEntryList: EntryList, PerformanceObserver: Observer, Performance: PerformanceStandIn });
        const workers: { transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            constructor() { workers.push(this as any); }
            onerror: unknown = null;
            transfer: MessagePort[] = [];
            postMessage(_message: unknown, transfer: MessagePort[]) { this.transfer = transfer; }
        };
        // the characters and time budgets high enough not to hold an operation back; the load budget as shipped
        const options: ViewOptions = { ...VIEW_OPTIONS, rates: { characters: 1e9, time: 1e9, urls: R } };
        const spy = `(rates, start, limits) => {
            const budget = (${viewBudget.toString()})(rates, start, limits);
            globalThis.__calls = [];
            const prepay = budget.prepay, observed = budget.observed;
            budget.prepay = (loads, now) => { if (loads > 0) globalThis.__calls.push(['prepay', loads]); prepay(loads, now); };
            budget.observed = (loads, now) => { globalThis.__calls.push(['observed', loads]); observed(loads, now); };
            return (globalThis.__budget = budget);
        }`;
        // the listener the view registers for violations, called directly (jsdom makes no trusted event of its own)
        const listeners: Record<string, (event: unknown) => void> = {};
        const add = window.addEventListener;
        window.addEventListener = function (this: Window, type: string, listener: any, options?: any) {
            if (type === 'securitypolicyviolation') listeners[type] = listener;
            return add.call(this, type, listener, options);
        } as typeof window.addEventListener;
        try {
            new Function(`(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${spy}, ${cssLoadBound.toString()}, ${cssReferences.toString()}, ${withoutNetworkReferences.toString()}, ${JSON.stringify(options)});`)();
        } finally {
            window.addEventListener = add;
        }
        const logic = new MessageChannel(), view = new MessageChannel();
        const html = '<div id="a"></div><style id="s"></style><textarea id="t"></textarea>';
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html, allowAnimations: true, origins: { images: ['https://a.example'] } }, source: window, ports: [logic.port1, view.port1] }));
        const render = workers[0]!.transfer[1]!;
        let acks = 0;
        render.onmessage = (event) => { if (event.data?.type === 'VIEW_ACK') acks++; };
        render.postMessage({ type: 'VIEW_STARTED' });
        const send = async (message: Record<string, unknown>) => {
            const before = acks;
            (globalThis as any).__calls.length = 0;
            render.postMessage(message);
            for (let i = 0; i < 400 && acks === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
            return (globalThis as any).__calls.slice();
        };
        const loaded = (...urls: string[]) => {
            (globalThis as any).__calls.length = 0;
            report!(new EntryList(urls.map(url => new Entry(url))));
            return (globalThis as any).__calls.slice();
        };
        const violation = (blockedURI: string) => {
            (globalThis as any).__calls.length = 0;
            listeners['securitypolicyviolation']!({ isTrusted: true, blockedURI, effectiveDirective: 'img-src' });
            return (globalThis as any).__calls.slice();
        };
        // the reports the view posts to the host, by the directive they name (the host labels and counts them: host.ts)
        const reported: string[] = [];
        view.port2.onmessage = (event) => { if (event.data?.type === 'VIOLATION') reported.push(event.data.directive); };
        const refused = async (directive: string, blockedURI: string) => {
            listeners['securitypolicyviolation']!({ isTrusted: true, blockedURI, effectiveDirective: directive });
            await new Promise(resolve => setTimeout(resolve, 0));
        };
        return { send, loaded, violation, refused, reported, budget: () => (globalThis as any).__budget, close: () => { render.close(); view.port2.close(); logic.port2.close(); } };
    }

    it('the view caps its violation reports by the host\'s buckets: each known directive apart, every other name together (BD3:LIM-3)', async () => {
        const { refused, reported, close } = await startView();
        const limit = VIEW_OPTIONS.violationLimit;
        for (let i = 0; i < limit + 5; i++) await refused('img-src', `https://a.example/${i}.png`);
        await refused('script-src-attr', 'inline');
        // unlisted names, each reported twice: one shared bucket, however many distinct names (the old rule kept 32 apart)
        for (let name = 0; name < 150; name++) for (let again = 0; again < 2; again++) await refused(`made-up-${name}`, `https://a.example/${name}.png`);
        close();
        const count = (directive: string) => reported.filter(name => name === directive).length;
        expect([count('img-src'), count('script-src-attr')]).toEqual([limit, 1]);
        const other = reported.filter(name => !VIOLATION_DIRECTIVES.includes(name));
        expect(other, 'unlisted names share the cap of one bucket').toHaveLength(limit);
        // and the host's bucket of those names is one too
        expect(new Set(other.map(violationBucket))).toEqual(new Set(['*']));
    });

    it('what each operation can add CSS with is prepaid: style attributes, <style> texts, text() and a render into a <style>', async () => {
        const { send, close } = await startView();
        expect(await send({ type: 'VIEW_RENDER', html: '<p style="background: url(https://a.example/1.png)">x</p><p style="color: red">y</p>', into: 'a' })).toEqual([['prepay', 1]]);
        expect(await send({ type: 'VIEW_RENDER', html: '<style>@import "https://a.example/x.css"; i { background: image-set(url(https://a.example/2.png) 1x) }</style>', into: 'a' })).toEqual([['prepay', R + 2]]);
        expect(await send({ type: 'VIEW_RENDER', html: '<svg><style>i { background: url(https://a.example/3.png) }</style></svg>', into: 'a' })).toEqual([['prepay', 1]]);
        expect(await send({ type: 'VIEW_TEXT', text: 'i { background: url(https://a.example/4.png), url(https://a.example/5.png) }', into: 's' })).toEqual([['prepay', 2]]);
        expect(await send({ type: 'VIEW_RENDER', html: 'i { background: url(https://a.example/6.png) }', into: 's' })).toEqual([['prepay', 1]]);
        // nothing that is not CSS
        expect(await send({ type: 'VIEW_RENDER', html: '<p>url(https://a.example/7.png)</p>', into: 'a' })).toEqual([]);
        expect(await send({ type: 'VIEW_TEXT', text: 'url(https://a.example/8.png)', into: 'a' })).toEqual([]);
        expect(await send({ type: 'VIEW_SET', id: 't', value: 'url(https://a.example/9.png)' })).toEqual([]);
        close();
    });

    it('a reported load takes the credit; a URL a render kept in an attribute, charged when rendered, is not charged again', async () => {
        const { send, loaded, violation, budget, close } = await startView();
        await send({ type: 'VIEW_RENDER', html: '<img src="https://a.example/kept.png"><p style="background: url(https://a.example/css.png)">x</p>', into: 'a' });
        expect(budget().credit()).toBe(1);
        // the kept URL is skipped (it was charged as an attribute), and the CSS one takes the credit
        expect(loaded('https://a.example/kept.png', 'https://a.example/kept.png#f', 'https://a.example/css.png')).toEqual([['observed', 1]]);
        expect(budget().credit()).toBe(0);
        // a violation of a kept URL is not charged either; any other takes the credit the same way, then is charged
        expect(violation('https://a.example/kept.png')).toEqual([]);
        await send({ type: 'VIEW_RENDER', html: '<p style="background: url(https://r.example/refused.png)">x</p>', into: 'a' });
        expect(budget().credit()).toBe(1);
        const held = budget().held('urls', performance.now());
        expect(violation('https://r.example/refused.png')).toEqual([['observed', 1]]);
        expect(budget().credit()).toBe(0);
        expect(budget().held('urls', performance.now())).toBeGreaterThanOrEqual(held); // not charged: refill only
        close();
    });
});
