/**
 * What counts as a host meter of a spec's own (backlog T9): code that counts the host page's ticks, measures the gaps
 * between them, or computes a busy share from them, anywhere but test/e2e/host-share.ts. A source scan, by the shapes
 * such a meter takes: a 10 ms interval (`setInterval(..., 10)`), a timer that re-arms itself every 10 ms
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

/**
 * A unit test that measures how its code scales by clock reads of its own (backlog T9's class): a best-of-N that keeps the
 * fastest of several clock differences (`Math.min(fastest, performance.now() - started)`), or a ceiling on one name
 * over another (`expect(large / small, ...).toBeLessThan(24)`), which is that ratio. Both measured the machine's load: a loaded stretch
 * landing on one size's runs inflated the ratio. test/unit/scaling.ts (`scalingRatio`) is the one measure: it alternates
 * the sizes and keeps sampling while the ratio is over the bound.
 */
export function handTimedScaling(source: string): MeterHit[] {
    const code = withoutComments(source);
    const lineOf = (at: number) => code.slice(0, at).split('\n').length;
    const hits: MeterHit[] = [];
    const shapes: [string, RegExp][] = [
        ['a fastest of clock differences', /\bMath\.(?:min|max)\([^;]*\b(?:performance|Date)\.now\(\)/g],
        ['a ceiling on a ratio of two names', /\bexpect\(\s*[\w.]+\s*\/\s*[\w.]+\s*[,)][^;]*?\.toBeLessThan(?:OrEqual)?\(/g],
    ];
    for (const [pattern, shape] of shapes) {
        for (const match of code.matchAll(shape)) hits.push({ pattern, line: lineOf(match.index!), text: code.split('\n')[lineOf(match.index!) - 1]!.trim() });
    }
    return hits;
}

/**
 * An e2e spec's ceiling on one time it measured, given as another time it measured, scaled (`expect(full).toBeLessThan(none
 * * 1.5)`): the two were timed one after the other, so the load between them, and the engine's state as it moved, were in
 * the ratio (S81). The one measure is `scalingRatio` (test/unit/scaling.ts), run inside the page from its text. A ceiling
 * that is a constant scaled (`LIMIT_MS / 2`) is none.
 */
export function scaledCeilings(source: string): MeterHit[] {
    const code = withoutComments(source);
    const lineOf = (at: number) => code.slice(0, at).split('\n').length;
    const hits: MeterHit[] = [];
    const shape = /\.toBeLessThan(?:OrEqual)?\(\s*([A-Za-z_][\w.]*)\s*[*/]\s*[\d.]+\s*\)/g;
    for (const match of code.matchAll(shape)) {
        if (/^[A-Z][A-Z0-9_]*$/.test(match[1]!)) continue;
        hits.push({ pattern: 'a ceiling that is another measured value, scaled', line: lineOf(match.index!), text: code.split('\n')[lineOf(match.index!) - 1]!.trim() });
    }
    return hits;
}

// A test's declaration, on its own line: it(…, test(…, it.each(…)(…
const TEST_DECLARATION = /^\s*(?:it|test)\b/;
// The time limit a scaling test declares there (test/unit/scaling.ts).
const SCALING_TIMEOUT = /\{\s*timeout:\s*SCALING_TIMEOUT_MS\s*\}/;

/**
 * Each call of scalingRatio() in a test that does not declare SCALING_TIMEOUT_MS on its declaration line: the runner's
 * default time limit, or a number of the test's own, bounds the machine's load on it (T9's class).
 */
export function scalingWithoutItsTimeout(source: string): MeterHit[] {
    const hits: MeterHit[] = [];
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const text = lines[index]!;
        if (!/\bscalingRatio\(/.test(text) || /^\s*(?:\/\/|\*|import\b)/.test(text)) continue;
        let declared = index;
        while (declared >= 0 && !TEST_DECLARATION.test(lines[declared]!)) declared--;
        if (declared >= 0 && SCALING_TIMEOUT.test(lines[declared]!)) continue;
        hits.push({ pattern: 'a scaling measure under a time limit that is not SCALING_TIMEOUT_MS', line: index + 1, text: text.trim() });
    }
    return hits;
}
