import type { Frame, Page } from '@playwright/test';

/**
 * Reading strict mode's documents from outside the page (ADR-005), for evidence that does not depend on
 * anything the library or the guest reports: what the view's DOM holds, which frames exist, and what ran.
 *
 *   main (harness) / wrapper (the element's iframe) / view / ...
 *
 * Firefox and WebKit: through page.frames(). Chromium: the sandboxed wrapper is an out-of-process iframe,
 * and Playwright 1.58 with Chromium 141 lists it with no child frames (research 15, "Note on Chromium and
 * Playwright"), so below the host page Chromium is read through a CDP session on that target: its frame
 * tree, and Runtime.evaluate in each frame's default execution context. DevTools evaluation is not subject
 * to the page's CSP in any engine, so reading never depends on the policy under test.
 */

export interface FrameValue<T = unknown> { path: string; url: string; value: T | 'no-context' }

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T) =>
    Promise.race([promise.catch(() => fallback), new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

function framePath(frame: Frame): string {
    const chain: Frame[] = [];
    for (let f: Frame | null = frame; f; f = f.parentFrame()) chain.unshift(f);
    return chain.map((f, depth) => (depth === 0 ? 'main' : depth === 1 ? 'wrapper' : depth === 2 ? 'view' : f.name() || `d${depth}`)).join('/');
}

type CdpFrameTree = { frame: { id: string; name?: string; url: string; urlFragment?: string }; childFrames?: CdpFrameTree[] };

/**
 * Evaluates `expression` (a JS expression; JSON-serialisable result, promises awaited) in every frame of the
 * page, or only in the frames whose path `only` accepts (the others are listed with 'no-context').
 */
export async function inFrames<T = unknown>(page: Page, browserName: string, expression: string, only: (path: string) => boolean = () => true): Promise<FrameValue<T>[]> {
    const results: FrameValue<T>[] = [];
    if (browserName !== 'chromium') {
        for (const frame of page.frames()) {
            const path = framePath(frame);
            const value = only(path) ? await withTimeout<T | 'no-context'>(frame.evaluate(expression) as Promise<T>, 3000, 'no-context') : 'no-context';
            results.push({ path, url: frame.url(), value });
        }
        return results;
    }
    const main = page.mainFrame();
    results.push({ path: 'main', url: main.url(), value: only('main') ? await withTimeout<T | 'no-context'>(main.evaluate(expression) as Promise<T>, 3000, 'no-context') : 'no-context' });
    const wrapper = main.childFrames()[0];
    if (!wrapper) return results;
    const session = await page.context().newCDPSession(wrapper);
    try {
        const contexts = new Map<string, number>();
        session.on('Runtime.executionContextCreated' as any, (event: any) => {
            const aux = event.context.auxData ?? {};
            if (aux.isDefault) contexts.set(aux.frameId, event.context.id);
        });
        await session.send('Runtime.enable' as any);
        const { frameTree } = await session.send('Page.getFrameTree' as any) as { frameTree: CdpFrameTree };
        const walk = async (tree: CdpFrameTree, parentPath: string, depth: number) => {
            const name = depth === 1 ? 'wrapper' : depth === 2 ? 'view' : tree.frame.name || `d${depth}`;
            const path = `${parentPath}/${name}`;
            const contextId = contexts.get(tree.frame.id);
            let value: T | 'no-context' = 'no-context';
            if (contextId !== undefined && only(path)) {
                const reply = await withTimeout(session.send('Runtime.evaluate' as any, { expression, contextId, returnByValue: true, awaitPromise: true }) as Promise<any>, 3000, null);
                if (reply && !reply.exceptionDetails) value = reply.result.value as T;
            }
            results.push({ path, url: tree.frame.url + (tree.frame.urlFragment ?? ''), value });
            for (const child of tree.childFrames ?? []) await walk(child, path, depth + 1);
        };
        await walk(frameTree, 'main', 1);
    } finally {
        await session.detach().catch(() => {});
    }
    return results;
}

/** Evaluates `expression` in the view (main/wrapper/view); 'no-context' when there is none. */
export async function inView<T = unknown>(page: Page, browserName: string, expression: string): Promise<T | 'no-context'> {
    const found = (await inFrames<T>(page, browserName, expression, path => path === 'main/wrapper/view')).find(f => f.path === 'main/wrapper/view');
    return found ? found.value : 'no-context';
}

/** Polls the view until `expression` is truthy; returns its value. */
export async function waitInView<T = unknown>(page: Page, browserName: string, expression: string, timeout = 5000): Promise<T> {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await inView<T>(page, browserName, expression);
        if (value !== 'no-context' && value) return value as T;
        if (Date.now() > deadline) throw new Error(`the view never satisfied: ${expression} (last: ${JSON.stringify(value)})`);
        await page.waitForTimeout(50);
    }
}

/** A trusted click at (x, y) inside the sandbox element (the view fills the wrapper, which fills the element). */
export async function clickInSandbox(page: Page, x: number, y: number) {
    const box = await page.locator('web-sandbox').boundingBox();
    await page.mouse.click(box!.x + x, box!.y + y);
}
