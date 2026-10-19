/**
 * What counts as a host meter of a spec's own (backlog T9): code that counts the host page's ticks, measures the gaps
 * between them, or computes a busy share from them, anywhere but test/e2e/host-share.ts. A source scan, by the shapes
 * every such meter took before: a 10 ms interval (`setInterval(..., 10)`), a timer that re-arms itself every 10 ms
 * (`setTimeout(tick, 10)`), a gap read off the clock (`now - last`), a share or a limit taken against idle ticks
 * (`1 - loaded / idle`, `idle * 0.7`), the helpers' old names (`countTicks`, `longestGapWhile`, `START_LAG`), a calibration
 * of a spec's own (`operationCost`), a stall bounded by a fixed number or a table per engine instead of by a calibration in
 * the same run, and a pausable flood measured against one baseline instead of baselines interleaved with its windows.
 */

export interface MeterHit { pattern: string; line: number; text: string }

// Line and block comments that start a line: what a comment says about a meter is not one.
function withoutComments(source: string): string {
    return source
        .replace(/^\s*\/\*[\s\S]*?\*\//gm, match => match.replace(/[^\n]/g, ' '))
        .replace(/^\s*\/\/.*$/gm, match => match.replace(/./g, ' '))
        .replace(/^\s*\*.*$/gm, match => match.replace(/./g, ' '));
}

// The arguments of every call to `name`, by balanced brackets (strings and templates are skipped over whole).
function callArguments(source: string, name: string): { at: number; args: string[] }[] {
    const calls: { at: number; args: string[] }[] = [];
    const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
    for (let match; (match = pattern.exec(source));) {
        const args: string[] = [];
        let depth = 0;
        let start = match.index + match[0].length;
        let i = start;
        for (; i < source.length; i++) {
            const c = source[i]!;
            if (c === '"' || c === "'" || c === '`') {
                for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
                continue;
            }
            if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') {
                if (depth === 0) break;
                depth--;
            } else if (c === ',' && depth === 0) {
                args.push(source.slice(start, i).trim());
                start = i + 1;
            }
        }
        args.push(source.slice(start, i).trim());
        calls.push({ at: match.index, args });
    }
    return calls;
}

const TEXT_PATTERNS: [string, RegExp][] = [
    ['a self-arming 10 ms timer', /\bsetTimeout\(\s*\w+\s*,\s*10\s*\)/g],
    ['a gap read off the clock', /\bnow\s*-\s*[\w.]*\blast\b/g],
    ['a busy share against idle ticks', /\b1\s*-\s*\(?\s*[\w.]*(ticks|loaded|count|Ticks)\b[\w.]*\s*\)?\s*\//g],
    ['a limit taken against idle ticks', /\b(idle|before|idleTicks)(\.count)?\s*\*\s*[\d(]/g],
    ['an old meter helper', /\b(countTicks|longestGapWhile|START_LAG)\b/g],
    ['a calibration of its own', /\b(const|function)\s+operationCost\b/g],
    // a stall bounded by a number, not by what the code costs in the same run (oneApplyStall, quietStall)
    ['a stall against a fixed number', /\bexpect\([^;]*?(stall|[lL]ag|longest|Gap)[^;]*?\)\.toBeLessThan\(\s*\d+\s*\)/g],
    ['a stall bound per engine', /\{\s*chromium:\s*(\{\s*lag:\s*)?\d+/g],
];

// A flood the spec can stop (`globalThis.<name> = () => { ... globalThis.stop ... }`) measured with busyShare(), against
// one baseline taken before it, where interleavedShare() brackets each window with baselines taken at the same time.
const STOPPABLE = /\bglobalThis\.(\w+)\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,400}?\bglobalThis\.stop\b/g;

export function meterHits(source: string): MeterHit[] {
    const code = withoutComments(source);
    const lineOf = (at: number) => code.slice(0, at).split('\n').length;
    const hits: MeterHit[] = [];
    for (const { at, args } of callArguments(code, 'setInterval')) {
        if (args.length >= 2 && args[args.length - 1] === '10') hits.push({ pattern: 'a 10 ms interval', line: lineOf(at), text: code.split('\n')[lineOf(at) - 1]!.trim() });
    }
    for (const [name, pattern] of TEXT_PATTERNS) {
        for (const match of code.matchAll(pattern)) hits.push({ pattern: name, line: lineOf(match.index!), text: code.split('\n')[lineOf(match.index!) - 1]!.trim() });
    }
    for (const [, name] of code.matchAll(STOPPABLE)) {
        const started = new RegExp(`\\bbusyShare\\([^;]*['"\`]${name}\\(\\)`, 'g');
        for (const match of code.matchAll(started)) hits.push({ pattern: 'a pausable flood against one baseline', line: lineOf(match.index!), text: code.split('\n')[lineOf(match.index!) - 1]!.trim() });
    }
    return hits;
}

/**
 * A unit test that bounds its own wall-clock time from above by a number (`expect(performance.now() - started)
 * .toBeLessThan(1000)`, directly or through a name it gave the difference): it measures the machine's speed and load. A
 * lower bound (a wait that must last) is not one: a slower machine only makes it longer. Linearity is asserted as a ratio of two sizes measured in the same run, and
 * fixed work gets an explicit timeout with its reasoning (backlog T6, T9).
 */
export function wallClockBounds(source: string): MeterHit[] {
    const code = withoutComments(source);
    const lineOf = (at: number) => code.slice(0, at).split('\n').length;
    const hit = (at: number): MeterHit => ({ pattern: 'a wall-clock bound', line: lineOf(at), text: code.split('\n')[lineOf(at) - 1]!.trim() });
    // an upper bound in ms on a difference of the clock, written in the expect() itself
    const direct = /\bexpect\([^;]*\b(performance|Date)\.now\(\)[^;]*\)\.toBeLessThan(OrEqual)?\(\s*\d+\s*\)/g;
    // or on a name the test gave it (const elapsed = performance.now() - started; ... expect(elapsed).toBeLessThan(1000))
    const names = [...code.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*[^;]*\b(?:performance|Date)\.now\(\)\s*-/g)].map(match => match[1]!);
    const hits = [...code.matchAll(direct)].map(match => hit(match.index!));
    for (const name of names) {
        for (const match of code.matchAll(new RegExp(`\\bexpect\\(\\s*${name}\\b[^;]*?\\)\\.toBeLessThan(OrEqual)?\\(\\s*\\d+\\s*\\)`, 'g'))) hits.push(hit(match.index!));
    }
    return hits;
}
