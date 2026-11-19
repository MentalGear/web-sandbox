/**
 * The library as a harness page loads it: the build the test asked for (ADR-009). The fixture names it in
 * `window.sandboxBuild` before any script of a page runs (fixture.ts, the `build` option), and every harness page takes
 * its element from here, so one option decides the build for every page a test opens, whatever its URL:
 *
 * - `default`: src/index.ts, the package as published, which has sealed mode alone. The page never requests a module of
 *   the network modes.
 * - `network`: src/network.ts, the build with the network modes.
 *
 * A page opened outside the fixture names no build and gets the default one. A name that is no build stops the page.
 */
import { BUILDS, type Build } from '@src/lib/build-flag';

/** The exports of the network build's entry: the default build's are the same, less the network modes'. */
export type Library = typeof import('@src/network');

/** The build this page runs: the one the fixture named, else the default. */
export function pageBuild(): Build {
    const named = (window as unknown as { sandboxBuild?: unknown }).sandboxBuild ?? 'default';
    if (!(BUILDS as readonly unknown[]).includes(named)) throw new Error(`the e2e harness knows no build ${String(named)}`);
    return named as Build;
}

/**
 * Resolves once the build that stands on `element` has settled: at once unless it is loading, else at its `ready` or
 * `terminated`. A harness page that inserts its element says it is ready after this: the library is imported
 * asynchronously (below), so the page's own `load` does not wait for the frame of the build on insertion, and a spec
 * that started before that build settled would hear its event among its own.
 */
export function buildSettled(element: HTMLElement): Promise<void> {
    if ((element as HTMLElement & { state?: unknown }).state !== 'loading') return Promise.resolve();
    return new Promise(resolve => {
        const settle = () => {
            element.removeEventListener('ready', settle);
            element.removeEventListener('terminated', settle);
            resolve();
        };
        element.addEventListener('ready', settle);
        element.addEventListener('terminated', settle);
    });
}

/**
 * A harness page inserts its element so that the build on insertion has nothing a host policy could refuse, and a spec's
 * own start() (on a fresh element that takes this one's place: the fixture's startFresh()) is the first build that
 * matters. The build with the network modes has a mode for that, started before the insertion: cooperative mode without
 * allow-scripts runs no script of the library's. The default build has sealed mode alone, whose view is a script, so
 * there the element gets no app: an element with no app builds nothing (it stays `idle`), and leaves no trace a spec
 * would read as its own.
 */
export function insertInert(element: HTMLElement & { start(app: object, grants?: object): void }): void {
    if (pageBuild() === 'network') element.start({}, { mode: 'cooperative' });
    document.body.appendChild(element);
}

/** Each build's output directory, as the e2e server serves it (playwright.config.ts builds both at its start). */
const BUILD_DIRECTORY = { default: '/dist', network: '/dist-network' } as const satisfies Record<Build, string>;

/**
 * Where this page's build has its sealed-document.html, sealed mode's view (design 03): the file the e2e server serves
 * unchanged from that build's output directory (vite.config.ts). Relative, so defineWebSandbox() resolves it against
 * the page's own URL. Both builds write the same bytes (I12); each page names its own build's.
 */
export function pageDocumentUrl(build: Build = pageBuild()): string {
    return `${BUILD_DIRECTORY[build]}/sealed-document.html`;
}

/** The entry of the page's build, imported: the default build's page never loads the network build's. */
export async function loadLibrary(): Promise<Library> {
    if (pageBuild() === 'network') return import('@src/network');
    return import('@src/index') as Promise<unknown> as Promise<Library>;
}
