// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The test tooling's one patch (docs/archive/backlog/BACKLOG-done.md, S86): Playwright's Firefox driver reports the
 * frames of each content process on its own, with no order between processes, so a frame's navigation, execution
 * context or load can come before the frame's attach, and a frame's attach before its parent's (a COOP page whose
 * sandbox frames are recreated under load). Unpatched, `FrameManager.frameCommittedNewDocumentNavigation` uses the frame
 * it does not find, which crashes the test worker; `FFPage` drops the frame's contexts, so a spec cannot evaluate in it;
 * and `FrameManager.frameAttached` takes a frame whose parent it does not know for the main frame. The patch holds each
 * event of a frame, and the attach of a frame whose parent has not attached, in `FFPage` until that frame attaches and
 * replays them in order then, and `FrameManager` returns early for an unknown frame. This pins that the installed driver carries it, so an upgrade that drops the patch fails here and
 * not, once in a while, in a Firefox run.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const coreDir = path.dirname(require.resolve('playwright-core/package.json'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FrameManager } = require(path.join(coreDir, 'lib/server/frames.js')) as { FrameManager: new (page: unknown) => {
    frameCommittedNewDocumentNavigation(frameId: string, url: string, name: string, documentId: string, initial: boolean): void;
    frameAttached(frameId: string, parentFrameId: string | null): { _url: string };
} };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FFPage } = require(path.join(coreDir, 'lib/server/firefox/ffPage.js')) as { FFPage: { prototype: object } };

type Calls = unknown[][];
/** An FFPage's event handlers over a recording frame manager, without a browser: what the patch decides is the order. */
function firefoxPage(known: string[]) {
    const frames = new Set(known);
    const calls: Calls = [];
    const frameManager = {
        frame: (id: string) => (frames.has(id) ? { id } : null),
        frameAttached: (id: string, parent: string | null) => { frames.add(id); calls.push(['attached', id, parent]); },
        frameDetached: (id: string) => { frames.delete(id); calls.push(['detached', id]); },
        frameCommittedNewDocumentNavigation: (id: string, url: string) => calls.push(['committed', id, url]),
        frameRequestedNavigation: (id: string) => calls.push(['requested', id]),
        frameLifecycleEvent: (id: string, event: string) => calls.push(['lifecycle', id, event]),
    };
    const page = Object.assign(Object.create(FFPage.prototype), { _page: { frameManager }, _workers: new Map(), _pendingFrameEvents: new Map() }) as Record<string, (params: object) => void>;
    return { page, calls };
}

describe('the patched Playwright driver (S86)', () => {
    it("a frame's navigation and load that come before its attach are held, and replayed in order once it attaches", () => {
        const { page, calls } = firefoxPage(['main']);
        page._onNavigationStarted!({ frameId: 'f1', navigationId: 'n1' });
        page._onNavigationCommitted!({ frameId: 'f1', url: 'about:srcdoc', navigationId: 'n1' });
        page._onEventFired!({ frameId: 'f1', name: 'load' });
        expect(calls).toEqual([]);
        page._onFrameAttached!({ frameId: 'f1', parentFrameId: 'main' });
        expect(calls).toEqual([['attached', 'f1', 'main'], ['requested', 'f1'], ['committed', 'f1', 'about:srcdoc'], ['lifecycle', 'f1', 'load']]);
    });

    it("a frame's attach that comes before its parent's is held, and replayed with what it held once the parent attaches", () => {
        const { page, calls } = firefoxPage(['main']);
        page._onFrameAttached!({ frameId: 'view', parentFrameId: 'wrapper' });
        page._onEventFired!({ frameId: 'view', name: 'load' });
        expect(calls, 'a child of an unknown parent would otherwise take the main frame\'s place').toEqual([]);
        page._onFrameAttached!({ frameId: 'wrapper', parentFrameId: 'main' });
        expect(calls).toEqual([['attached', 'wrapper', 'main'], ['attached', 'view', 'wrapper'], ['lifecycle', 'view', 'load']]);
    });

    it("a frame's execution context that comes before its attach is held, not dropped", () => {
        const { page } = firefoxPage(['main']);
        let created = 0;
        const original = page._onExecutionContextCreated!;
        page._onExecutionContextCreated = function (this: unknown, payload: object) {
            const queuedBefore = (page as unknown as { _pendingFrameEvents: Map<string, unknown[]> })._pendingFrameEvents.get('f1')?.length ?? 0;
            original.call(page, payload);
            const queuedAfter = (page as unknown as { _pendingFrameEvents: Map<string, unknown[]> })._pendingFrameEvents.get('f1')?.length ?? 0;
            if (queuedAfter === queuedBefore) created++;
        };
        page._onExecutionContextCreated({ executionContextId: 'c1', auxData: { frameId: 'f1' } });
        expect(created, 'held while the frame is unknown').toBe(0);
        expect((page as unknown as { _pendingFrameEvents: Map<string, unknown[]> })._pendingFrameEvents.get('f1')).toHaveLength(1);
    });

    it("a known frame's events go through at once, and a detach drops what was held (positive controls)", () => {
        const { page, calls } = firefoxPage(['main', 'f2']);
        page._onNavigationCommitted!({ frameId: 'f2', url: 'about:blank', navigationId: 'n2' });
        expect(calls).toEqual([['committed', 'f2', 'about:blank']]);
        page._onEventFired!({ frameId: 'gone', name: 'load' });
        page._onFrameDetached!({ frameId: 'gone' });
        page._onFrameAttached!({ frameId: 'gone', parentFrameId: 'main' });
        expect(calls.slice(1)).toEqual([['detached', 'gone'], ['attached', 'gone', 'main']]);
    });

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
