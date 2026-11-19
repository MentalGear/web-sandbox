import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSandbox } from '@src/index';
import { APP_SURFACE, APP_SURFACE_KINDS, surfaceOf, type AppSurfaceKind } from '@src/lib/app-surface';
import { BUILDS, type Build } from '@src/lib/build-flag';
import { NETWORK_ELEMENT_METHODS } from '@src/lib/network-modes';
import { NetworkMethods } from '@src/lib/network-host';

/**
 * The element's whole public surface against APP_SURFACE (src/lib/app-surface.ts; design 01, I1 and I3): every member
 * of the element's prototype in each build, and every member of `WebSandbox` in each build's API report, has its row,
 * and every row is a member of the builds it names. Exactly one member binds an app, and only it and the commit take
 * or change app content. This file imports the default build; what the network build adds to the element is
 * NetworkMethods' prototype, which its entry installs (network-install.ts) and which is read here without installing.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sorted = (names: Iterable<string>) => [...new Set(names)].sort();

// The own names of a prototype that a caller can name: no constructor, no member the class keeps private by its `_`.
const ownPublic = (prototype: object) => Object.getOwnPropertyNames(prototype).filter(name => name !== 'constructor' && !name.startsWith('_'));

// The typed listeners: declared on the interface that shares the class's name, inherited from EventTarget at run time.
const INHERITED = ['addEventListener', 'removeEventListener'];

/** The members of the element of `build` at run time: its own public names, and the listeners it inherits. */
function prototypeOf(build: Build): string[] {
    const own = ownPublic(WebSandbox.prototype);
    // the network build installs every method of NetworkMethods; the ones the element calls through the seam are internal
    const added = build === 'network' ? ownPublic(NetworkMethods.prototype).filter(name => !(NETWORK_ELEMENT_METHODS as readonly string[]).includes(name)) : [];
    return sorted([...own, ...added, ...INHERITED]);
}

// The members of an interface or class of an API report: the block's lines at its first indent, by name.
function reportMembers(report: string, head: string): string[] {
    const start = report.indexOf(`\n${head} {\n`);
    expect(start, head).toBeGreaterThanOrEqual(0);
    const body = report.slice(start + head.length + 4, report.indexOf('\n}\n', start));
    return [...body.matchAll(/^ {4}(?:get |set )?(\w+)[<(?:]/gm)].map(match => match[1]!).filter(name => name !== 'constructor');
}

const REPORTS: Record<Build, string> = { default: 'etc/web-sandbox.api.md', network: 'etc/web-sandbox.network.api.md' };
// a report as text with one kind of line end (api-extractor writes CRLF)
const readReport = (build: Build) => readFileSync(path.join(ROOT, REPORTS[build]), 'utf8').replace(/\r\n/g, '\n');

/** The members of `WebSandbox` in the API report of `build`: the class's, its interface's, and the network modes' methods merged into it. */
function reportOf(build: Build): string[] {
    const report = readReport(build);
    const members = [...reportMembers(report, 'export class WebSandbox extends HTMLElement'), ...reportMembers(report, 'export interface WebSandbox')];
    if (build === 'network') members.push(...reportMembers(report, 'export interface NetworkModeMethods'));
    return sorted(members);
}

describe('APP_SURFACE: every public member of the element is classified, in each build (I1, I3)', () => {
    it('every row has a kind of the table', () => {
        for (const [name, row] of Object.entries(APP_SURFACE)) expect(Object.keys(APP_SURFACE_KINDS), name).toContain(row.kind);
    });

    it.each(BUILDS)("the %s build's element has exactly the members APP_SURFACE gives that build", (build) => {
        expect(prototypeOf(build)).toEqual(sorted(surfaceOf(build)));
    });

    it.each(BUILDS)("the %s build's API report has exactly those members of WebSandbox", (build) => {
        expect(reportOf(build)).toEqual(sorted(surfaceOf(build)));
    });

    it('exactly one member binds an app: start(); and only it and the commit take or change app content or grants', () => {
        const of = (kind: AppSurfaceKind) => Object.entries(APP_SURFACE).filter(([, row]) => row.kind === kind).map(([name]) => name);
        expect(of('binds')).toEqual(['start']);
        expect(of('changesApp')).toEqual(['commitGuestWrites']);
        for (const build of BUILDS) expect(surfaceOf(build), build).toContain('start');
    });

    it("the scans see a member no row classifies: one more own name, in either build, is a member the table lacks", () => {
        const probe = sorted([...prototypeOf('default'), 'registerFiles']);
        expect(probe).not.toEqual(sorted(surfaceOf('default')));
        const report = readReport('network').replace('export class WebSandbox extends HTMLElement {\n', 'export class WebSandbox extends HTMLElement {\n    load(html: string): void;\n');
        expect(sorted([...reportMembers(report, 'export class WebSandbox extends HTMLElement'), ...reportMembers(report, 'export interface WebSandbox'), ...reportMembers(report, 'export interface NetworkModeMethods')])).toContain('load');
    });
});
