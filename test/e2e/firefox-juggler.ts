/**
 * Playwright's Firefox (1.58.1) drops protocol messages after a cross-origin-opener-policy navigation (S86): Juggler,
 * the browser side of the driver, names each content process's channel `process-<pid>`, so the channel a COOP page gets
 * in the same process as the page before it carries the old one's name, its request ids restart at 1, and the parent
 * process answers each new request whose id matches a response the old channel never acknowledged from its cache,
 * without delivering it. A frame's attach lost that way leaves the frame out of the driver's tree for good.
 * Playwright 1.64.0 names each channel uniquely; this applies that same line to the installed build, as the e2e runs'
 * global setup, so no Firefox run starts on a build that has the bug. S88's upgrade makes it a no-op, then removes it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { firefox } from 'playwright-core';

const MAIN_JS = 'chrome/juggler/content/content/main.js';
export const JUGGLER_CHANNEL_SHARED = `new SimpleChannel('', 'process-' + Services.appinfo.processID);`;
export const JUGGLER_CHANNEL_UNIQUE = `new SimpleChannel('', 'process-' + Services.appinfo.processID + '-' + helper.generateId());`;

/** Juggler's content main.js with a channel name unique per channel; throws on a source that has neither form. */
export function withUniqueChannel(source: string): string {
    if (source.includes(JUGGLER_CHANNEL_UNIQUE)) return source;
    if (source.split(JUGGLER_CHANNEL_SHARED).length !== 2) {
        throw new Error(`Firefox's Juggler (${MAIN_JS}) names its channel neither way this fix knows: check S86 against the installed Playwright`);
    }
    return source.replace(JUGGLER_CHANNEL_SHARED, JUGGLER_CHANNEL_UNIQUE);
}

const readMain = (omni: string) => execFileSync('unzip', ['-p', omni, MAIN_JS], { encoding: 'utf8', maxBuffer: 1 << 24 });

/** Rewrites the omni.ja of the installed Firefox when its Juggler shares a channel name; a no-op when it does not. */
export function ensureUniqueJugglerChannel(): void {
    const executable = firefox.executablePath();
    if (!existsSync(executable)) return; // no Firefox installed: no Firefox run either
    const omni = join(dirname(executable), 'omni.ja');
    const source = readMain(omni);
    const fixed = withUniqueChannel(source);
    if (fixed === source) return;
    const work = mkdtempSync(join(tmpdir(), 'juggler-'));
    try {
        execFileSync('unzip', ['-q', omni, '-d', join(work, 'omni')]);
        writeFileSync(join(work, 'omni', MAIN_JS), fixed);
        execFileSync('zip', ['-q', '-r', '-D', '-X', join(work, 'omni.ja'), '.'], { cwd: join(work, 'omni') });
        // the same directory as the target, so the rename is atomic for another run reading it
        const staged = `${omni}.${process.pid}.tmp`;
        execFileSync('cp', [join(work, 'omni.ja'), staged]);
        renameSync(staged, omni);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
    if (!readMain(omni).includes(JUGGLER_CHANNEL_UNIQUE)) throw new Error(`could not apply the Juggler channel fix to ${omni}`);
}

export default ensureUniqueJugglerChannel;
