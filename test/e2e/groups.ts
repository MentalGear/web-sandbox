import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The e2e suite's two groups (backlog T10), for a run that takes one of them: playwright.config.ts reads the selection.
 *
 * - `measuring`: the specs that measure what the host page has left (ticks, a busy share, a stall). They are the specs
 *   that import the one meter, host-share.ts (test/unit/host-share.test.ts fails a spec that measures with one of its
 *   own, T9), so the group is derived from that import and never listed. The machine's load is one of their inputs
 *   (S81): they run on the workers the whole suite has always run on, half of the machine's cores.
 * - `rest`: every other spec. None reads the host page's clock against a bound, so they run on all of the cores.
 *
 * With no group named, a run is the whole suite on half of the cores, in one go.
 */
export const E2E_GROUP_VARIABLE = 'WEB_SANDBOX_E2E_GROUP';

export const E2E_GROUPS = ['measuring', 'rest'] as const;
export type E2eGroup = (typeof E2E_GROUPS)[number];

/** Where the suite's specs are, relative to the checkout's root. */
export const SPEC_DIRECTORIES = ['test/e2e', 'docs/research'] as const;
const SPEC_SUFFIX = '.spec.ts';

/** The suite's specs as Playwright's globs, which it matches against absolute paths. */
export const SPEC_GLOBS = SPEC_DIRECTORIES.map(directory => `${directory}/**/*${SPEC_SUFFIX}`);

// an import of the meter, by any relative path: `from './host-share'`, `from '../../../test/e2e/host-share'`
const METER_IMPORT = /\bfrom\s+['"](?:[^'"]*\/)?host-share['"]/;

/** Whether a spec's source imports the meter. */
export function importsMeter(source: string): boolean {
    return METER_IMPORT.test(source);
}

/** The group named by the variable's value: null when it is unset or empty, and an error for any other name. */
export function selectedGroup(value: string | undefined): E2eGroup | null {
    if (value === undefined || value === '') return null;
    for (const group of E2E_GROUPS) {
        if (group === value) return group;
    }
    throw new Error(`${E2E_GROUP_VARIABLE} is '${value}': it names one of ${E2E_GROUPS.join(', ')}, or is left out for the whole suite`);
}

/** Every spec under SPEC_DIRECTORIES of the checkout at `root`, as absolute paths; worktrees nested in it are not read. */
export function specFiles(root: string): string[] {
    const found: string[] = [];
    for (const directory of SPEC_DIRECTORIES) collectSpecs(join(root, directory), found);
    return found.sort();
}

function collectSpecs(directory: string, found: string[]) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') collectSpecs(path, found);
            continue;
        }
        if (entry.isFile() && entry.name.endsWith(SPEC_SUFFIX)) found.push(path);
    }
}

/** The measuring group: the specs of the checkout at `root` that import the meter. */
export function measuringSpecs(root: string): string[] {
    const measuring: string[] = [];
    for (const path of specFiles(root)) {
        if (importsMeter(readFileSync(path, 'utf8'))) measuring.push(path);
    }
    return measuring;
}

const escapeRegExp = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const exactly = (path: string) => new RegExp(`^${escapeRegExp(path)}$`);

/** What a run of `group` (or of the whole suite, null) matches, leaves out and runs on. */
export interface GroupSelection {
    /** Playwright's `testMatch`. */
    readonly match: readonly (string | RegExp)[];
    /** What Playwright's `testIgnore` gains. */
    readonly ignore: readonly RegExp[];
    /** Playwright's `workers`; undefined is its default, half of the machine's cores. */
    readonly workers: string | undefined;
}

/**
 * The selection of a group, from the measuring specs' absolute paths. The two groups divide the suite by one list: what
 * `measuring` matches is exactly what `rest` leaves out.
 */
export function groupSelection(group: E2eGroup | null, measuring: readonly string[]): GroupSelection {
    if (group === null) return { match: SPEC_GLOBS, ignore: [], workers: undefined };
    const paths = measuring.map(exactly);
    if (group === 'measuring') return { match: paths, ignore: [], workers: undefined };
    return { match: SPEC_GLOBS, ignore: paths, workers: '100%' };
}
