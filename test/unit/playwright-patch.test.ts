// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The test tooling's one patch (docs/BACKLOG.md S86): Playwright's Firefox driver can report a frame's navigation commit
 * before the frame's attach (a COOP page whose sandbox frames are recreated under load), and
 * `FrameManager.frameCommittedNewDocumentNavigation` used the frame it did not find, which crashed the test worker. The
 * patch returns early for a frame the manager does not know; its attach follows. This pins that the installed driver
 * carries it, so an upgrade that drops the patch fails here and not, once in a while, in a Firefox run.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const coreDir = path.dirname(require.resolve('playwright-core/package.json'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FrameManager } = require(path.join(coreDir, 'lib/server/frames.js')) as { FrameManager: new (page: unknown) => {
    frameCommittedNewDocumentNavigation(frameId: string, url: string, name: string, documentId: string, initial: boolean): void;
    frameAttached(frameId: string, parentFrameId: string | null): { _url: string };
} };

describe('the patched Playwright driver (S86)', () => {
    it('a navigation commit for a frame the manager has not seen attach is ignored, not a crash', () => {
        const manager = new FrameManager({ emit() {}, isClosed: () => false });
        expect(() => manager.frameCommittedNewDocumentNavigation('unknown-frame', 'about:srcdoc', '', 'doc-1', false)).not.toThrow();
    });

    it('a known frame still commits (positive control)', () => {
        const manager = new FrameManager({ emit() {}, isClosed: () => false }) as unknown as { _frames: Map<string, unknown> } & InstanceType<typeof FrameManager>;
        const frame = { _url: '', childFrames: () => [], parentFrame: () => null };
        manager._frames.set('known', frame);
        // the stub frame lacks what the steps after the URL use: they may throw, the URL is set first
        try { manager.frameCommittedNewDocumentNavigation('known', 'https://example.test/', '', 'doc-1', false); } catch { /* past the URL */ }
        expect(frame._url).toBe('https://example.test/');
    });

    it('the patch is the one package.json names, against the installed version', () => {
        const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { patchedDependencies?: Record<string, string> };
        const installed = (JSON.parse(readFileSync(path.join(coreDir, 'package.json'), 'utf8')) as { version: string }).version;
        expect(Object.keys(pkg.patchedDependencies ?? {})).toEqual([`playwright-core@${installed}`]);
    });
});
