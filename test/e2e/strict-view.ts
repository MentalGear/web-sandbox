import type { Frame, Page } from '@playwright/test';

/**
 * Reading strict mode's documents from outside the page (ADR-005), for evidence that does not depend on
 * anything the library or the guest reports: what the view's DOM holds, which frames exist, and what ran.
 *
 *   main (harness) / wrapper (the element's iframe) / view / ...
 *
 * Firefox and WebKit: through page.frames(). Chromium: always through CDP, from ground truth, never through
 * Playwright's frame model. The sandboxed wrapper can be an out-of-process iframe (measured so in earlier runs, idle
 * or under CPU load; in the broad review's runs it shared the page's process: no iframe target, both frames local),
 * and Playwright 1.58 maps such an OOPIF target to its Frame asynchronously and not reliably:
 * right after 'ready' it may already list the wrapper's children, may list none yet, or (under CPU load, about
 * 1 run in 10) never attach the target at all, so that newCDPSession(wrapper) keeps failing with "part of the
 * parent frame's session" although the wrapper has its own target. So Chromium is read through one CDP session
 * on the page: Page.getFrameTree lists the frames that share the page's process, Target.getTargets lists the
 * out-of-process ones with their parentFrameId, and each of those is read through a non-flattened
 * Target.attachToTarget from that same session, recursively. The same code reads an in-process wrapper and an
 * out-of-process one, at any depth, so no test depends on the process model or on Playwright's attach timing.
 * Each frame is evaluated with Runtime.evaluate in its default execution context. DevTools evaluation is not
 * subject to the page's CSP in any engine, so reading never depends on the policy under test.
 */

export interface FrameValue<T = unknown> { path: string; url: string; value: T | 'no-context' }

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T) =>
    Promise.race([promise.catch(() => fallback), new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

const frameName = (depth: number, name: string | undefined) => (depth === 0 ? 'main' : depth === 1 ? 'wrapper' : depth === 2 ? 'view' : name || `d${depth}`);

function framePath(frame: Frame): string {
    const chain: Frame[] = [];
    for (let f: Frame | null = frame; f; f = f.parentFrame()) chain.unshift(f);
    return chain.map((f, depth) => frameName(depth, f.name())).join('/');
}

type CdpFrameTree = { frame: { id: string; name?: string; url: string; urlFragment?: string }; childFrames?: CdpFrameTree[] };
type CDPSession = Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>;

/** One CDP target to talk to: the page's own session, or a target attached through it (non-flattened). */
interface Cdp {
    send(method: string, params?: object): Promise<any>;
    on(event: string, listener: (params: any) => void): void;
    close(): Promise<void>;
}

function pageCdp(session: CDPSession): Cdp {
    return {
        send: (method, params) => session.send(method as any, params as any),
        on: (event, listener) => { session.on(event as any, listener); },
        close: () => session.detach().catch(() => {}),
    };
}

// Non-flattened attach: the target's protocol messages travel as Target.sendMessageToTarget /
// Target.receivedMessageFromTarget on the page's session, so they never depend on Playwright knowing the target.
async function attachedCdp(session: CDPSession, targetId: string): Promise<Cdp> {
    const { sessionId } = await session.send('Target.attachToTarget' as any, { targetId, flatten: false }) as { sessionId: string };
    let nextId = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const listeners = new Map<string, ((params: any) => void)[]>();
    const onMessage = (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (typeof message.id === 'number') {
            const entry = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) entry?.reject(new Error(message.error.message));
            else entry?.resolve(message.result);
        } else {
            for (const listener of listeners.get(message.method) ?? []) listener(message.params);
        }
    };
    session.on('Target.receivedMessageFromTarget' as any, onMessage);
    return {
        send: (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            session.send('Target.sendMessageToTarget' as any, { sessionId, message: JSON.stringify({ id, method, params }) })
                .catch((e: Error) => { pending.delete(id); reject(e); });
        }),
        on: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
        close: async () => {
            session.off('Target.receivedMessageFromTarget' as any, onMessage);
            for (const entry of pending.values()) entry.reject(new Error('detached'));
            await session.send('Target.detachFromTarget' as any, { sessionId }).catch(() => {});
        },
    };
}

// Visits every Chromium frame of the page (see the top of this file), depth first, with the CDP client that owns
// it, its frame id, its path and its default execution context (if any).
type FrameVisitor = (cdp: Cdp, frame: CdpFrameTree['frame'], path: string, contextId: number | undefined) => Promise<void>;

async function walkChromiumFrames(page: Page, visit: FrameVisitor): Promise<void> {
    const session = await page.context().newCDPSession(page);
    const clients: Cdp[] = [];
    try {
        const { targetInfos } = await session.send('Target.getTargets' as any) as { targetInfos: { type: string; targetId: string; parentFrameId?: string }[] };
        const outOfProcess = targetInfos.filter(t => t.type === 'iframe' && t.parentFrameId);
        // Reads every frame local to `cdp`'s target, depth first, descending into out-of-process children in place.
        const readTarget = async (cdp: Cdp, parentPath: string, depth: number) => {
            const contexts = new Map<string, number>();
            // Runtime.enable reports every existing context before it returns
            cdp.on('Runtime.executionContextCreated', (event: any) => {
                const aux = event.context.auxData ?? {};
                if (aux.isDefault) contexts.set(aux.frameId, event.context.id);
            });
            await cdp.send('Runtime.enable');
            const { frameTree } = await cdp.send('Page.getFrameTree') as { frameTree: CdpFrameTree };
            const walk = async (tree: CdpFrameTree, parentPath: string, depth: number) => {
                const name = frameName(depth, tree.frame.name);
                const path = parentPath ? `${parentPath}/${name}` : name;
                await visit(cdp, tree.frame, path, contexts.get(tree.frame.id));
                for (const child of tree.childFrames ?? []) await walk(child, path, depth + 1);
                for (const target of outOfProcess.filter(t => t.parentFrameId === tree.frame.id)) {
                    // a target outlives its frame for a moment (a rebuilt sandbox's previous wrapper): only frames still owned count
                    const owned = await cdp.send('DOM.getFrameOwner', { frameId: target.targetId }).then(() => true, () => false);
                    if (!owned) continue;
                    const child = await attachedCdp(session, target.targetId);
                    clients.push(child);
                    await readTarget(child, path, depth + 1);
                }
            };
            await walk(frameTree, parentPath, depth);
        };
        await readTarget(pageCdp(session), '', 0);
    } finally {
        for (const client of clients) await client.close();
        await session.detach().catch(() => {});
    }
}

async function inFramesThroughCdp<T>(page: Page, expression: string, only: (path: string) => boolean): Promise<FrameValue<T>[]> {
    const results: FrameValue<T>[] = [];
    await walkChromiumFrames(page, async (cdp, frame, path, contextId) => {
        let value: T | 'no-context' = 'no-context';
        if (contextId !== undefined && only(path)) {
            const reply = await withTimeout(cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }), 3000, null);
            if (reply && !reply.exceptionDetails) value = reply.result.value as T;
        }
        results.push({ path, url: frame.url + (frame.urlFragment ?? ''), value });
    });
    return results;
}

/**
 * Chromium only: the URL its accessibility tree exposes for every link in the view (Accessibility.getFullAXTree
 * of the view frame, the `url` property of each node with the role link), in tree order. What assistive
 * technology announces and acts on, read from the browser, not from the page. null when there is no view.
 */
export async function chromiumViewLinkUrls(page: Page): Promise<string[] | null> {
    let urls: string[] | null = null;
    await walkChromiumFrames(page, async (cdp, frame, path) => {
        if (path !== 'main/wrapper/view') return;
        const reply = await withTimeout(cdp.send('Accessibility.getFullAXTree', { frameId: frame.id }), 3000, null);
        if (!reply) return;
        urls = [];
        for (const node of reply.nodes as { role?: { value?: string }; properties?: { name: string; value: { value?: unknown } }[] }[]) {
            if (node.role?.value !== 'link') continue;
            const url = node.properties?.find(property => property.name === 'url')?.value.value;
            urls.push(typeof url === 'string' ? url : '');
        }
    });
    return urls;
}

/**
 * Evaluates `expression` (a JS expression; JSON-serialisable result, promises awaited) in every frame of the
 * page, or only in the frames whose path `only` accepts (the others are listed with 'no-context').
 */
export async function inFrames<T = unknown>(page: Page, browserName: string, expression: string, only: (path: string) => boolean = () => true): Promise<FrameValue<T>[]> {
    if (browserName === 'chromium') return inFramesThroughCdp<T>(page, expression, only);
    const results: FrameValue<T>[] = [];
    for (const frame of page.frames()) {
        const path = framePath(frame);
        const value = only(path) ? await withTimeout<T | 'no-context'>(frame.evaluate(expression) as Promise<T>, 3000, 'no-context') : 'no-context';
        results.push({ path, url: frame.url(), value });
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
