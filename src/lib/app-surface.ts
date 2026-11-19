/**
 * Every public member of the element, classified by what it does with the element's one app (design 01; I1, I3): the
 * one member that binds an app with its grants, the one that changes the bound app's content, and the rest, which run,
 * read or are the platform's. An allowlist over the whole domain, never a list of banned names:
 * test/unit/app-surface.test.ts enumerates the element's prototype in each build and the members of `WebSandbox` in
 * each build's API report, and fails for a member that has no row here, or a row for a member the build does not have.
 * So a new member that takes app content or grants cannot be added without being classified, and exactly one binds.
 *
 * Data for tests and the docs: the element itself does not import it.
 */
import type { Build } from './build-flag';

/** What a member does with the element's app. */
export const APP_SURFACE_KINDS = {
    binds: "takes the app and the embedder's grants and binds them to the element, once (start())",
    changesApp: "changes the bound app's content: its files, by the app's own committed writes",
    runsApp: "acts on the bound app's environment (builds, ends or calls it) and takes no app content and no grant",
    readsApp: 'reads what the element or its app holds, and changes nothing',
    platform: "the platform's: a custom element reaction, or the typed listeners of EventTarget",
} as const;
export type AppSurfaceKind = keyof typeof APP_SURFACE_KINDS;

/** One member: its kind, and the builds whose element has it (`'every'`, or only the build with the network modes). */
export interface AppSurfaceRow {
    readonly kind: AppSurfaceKind;
    readonly builds: 'every' | Build;
}

export const APP_SURFACE = {
    start: { kind: 'binds', builds: 'every' },
    commitGuestWrites: { kind: 'changesApp', builds: 'every' },
    reset: { kind: 'runsApp', builds: 'every' },
    terminate: { kind: 'runsApp', builds: 'every' },
    call: { kind: 'runsApp', builds: 'every' },
    callWithTimeout: { kind: 'runsApp', builds: 'every' },
    // code the embedder runs in the app's environment, not part of the app: never stored, never in a build
    execute: { kind: 'runsApp', builds: 'network' },
    state: { kind: 'readsApp', builds: 'every' },
    started: { kind: 'readsApp', builds: 'every' },
    listFiles: { kind: 'readsApp', builds: 'every' },
    listGuestWrites: { kind: 'readsApp', builds: 'every' },
    connectedCallback: { kind: 'platform', builds: 'every' },
    disconnectedCallback: { kind: 'platform', builds: 'every' },
    adoptedCallback: { kind: 'platform', builds: 'every' },
    addEventListener: { kind: 'platform', builds: 'every' },
    removeEventListener: { kind: 'platform', builds: 'every' },
} as const satisfies Readonly<Record<string, AppSurfaceRow>>;
export type AppSurfaceMember = keyof typeof APP_SURFACE;

/** The members the element of `build` has, by their names. */
export function surfaceOf(build: Build): AppSurfaceMember[] {
    const members: AppSurfaceMember[] = [];
    for (const [name, row] of Object.entries(APP_SURFACE) as [AppSurfaceMember, AppSurfaceRow][]) {
        if (row.builds === 'every' || row.builds === build) members.push(name);
    }
    return members;
}
