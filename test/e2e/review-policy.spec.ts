import type { Page } from '@playwright/test';
import { test, expect } from './fixture';
import { useRecorder } from './recorder';
import { inView, waitInView } from './strict-view';

/**
 * Adversarial review 2026-10, policy (docs/archive/reviews/ADVERSARIAL-REVIEW-2026-10.md, A1). A configured value or key
 * cannot add a directive to a guest policy: only exact origins reach it, each in its kind's directive of a fixed
 * template (src/lib/csp/origins.ts, csp-generator.ts, ADR-007). Asserted here where it matters most, in strict mode, whose view
 * relies on script-src-attr 'none' (G1): an injected value that once enabled handler attributes in the view.
 * The renderer keeps no handler attribute (an allowlist since the broad review 2026-10-14), so the policy layer is
 * probed on its own: the handler is set on the rendered image from outside (DevTools), and the document's policy
 * decides whether it compiles, whoever set it.
 * Evidence (T5): the view's policy and DOM read from outside; the handler's would-be request on the recorder,
 * with a positive control for the same kind of load in the same test; the view's violation report.
 */

const recorder = useRecorder();

const INJECTED = "'none'; script-src-attr 'unsafe-inline'; script-src * 'unsafe-inline'; frame-src *";

test("A1: an injected origins value gives the strict view no handler attributes: it is dropped, script-src-attr stays 'none', the handler never runs", async ({ sandbox, page, browserName }) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
    // rendered by the entry, not execute(): the injected script-src would also have taken eval away
    const handler = `new Image().src='${recorder.allowed}/handler-ran.svg'`;
    const markup = `<img id="h" src="${recorder.allowed}/not-an-image.txt" onerror="${handler}"><img id="c" src="${recorder.allowed}/control.svg"><p id="done">done</p>`;
    await sandbox.registerFiles({ 'main.js': `sandboxView.render(${JSON.stringify(markup)});` });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', origins: { images: [INJECTED, recorder.allowed] } })).toBe('ready');
    await waitInView(page, browserName, `!!document.getElementById('done')`, 8000);

    // positive control: the view loads from the allowed origin, and the broken image did load (and fail)
    await recorder.waitFor('allowed', '/control.svg');
    await recorder.waitFor('allowed', '/not-an-image.txt');
    // the renderer removed the guest's handler; set it from outside and fail the image again: the policy alone decides
    expect(await inView(page, browserName, `document.getElementById('h').hasAttribute('onerror')`)).toBe(false);
    await inView(page, browserName, `(() => { const h = document.getElementById('h'); h.setAttribute('onerror', ${JSON.stringify(handler)}); h.src = '${recorder.allowed}/not-an-image-2.txt'; return true; })()`);
    await recorder.waitFor('allowed', '/not-an-image-2.txt');
    await page.waitForTimeout(1000);
    expect(recorder.paths('allowed')).not.toContain('/handler-ran.svg');
    // and the attempt is on record: the view refused the handler and reported it
    await sandbox.waitForViolation('script-src-attr', 'inline', 8000);

    const policy = await inView<string>(page, browserName, `document.querySelector('meta[http-equiv]').content`);
    const first = new Map<string, string>();
    for (const part of policy.split(';')) {
        const [name, ...tokens] = part.trim().split(/\s+/);
        if (name && !first.has(name.toLowerCase())) first.set(name.toLowerCase(), tokens.join(' '));
    }
    expect(first.get('script-src-attr')).toBe("'none'");
    expect(first.get('frame-src')).toBe("'none'");
    expect(first.get('script-src')).toMatch(/^'sha256-[A-Za-z0-9+/]+=' 'unsafe-eval'$/); // the baseline config has scriptUnsafe
    expect(first.get('img-src')).toBe(recorder.allowed);
    expect(warnings.filter(w => w.includes('origins.images entry') && w.includes('was dropped'))).toHaveLength(1);
});

/**
 * Follow-up audit 2026-10-14, the A3 class: registered files must load under the directive that governs their kind of
 * load. Since ADR-007 no config can name a directive (script-src-elem, style-src-elem), so the directive that governs
 * scripts and stylesheets is always the template's script-src and style-src, and blob: goes there, from the one
 * load-kind table (load-kinds.ts). Evidence (T5): each load's own outcome and the computed style read from outside
 * the guest frame, the host's violation events, the policy read from outside and compared whole.
 */
test.describe('A3 class: registered files load under the directive of their kind', () => {
    const FILES = { 'app.js': 'globalThis.__appRan = (globalThis.__appRan || 0) + 1;', 'app.css': '#probe { width: 123px; }' };
    const MARKUP = '<div id="probe"></div>'
        + '<link rel="stylesheet" href="app.css" onload="window.__css = \'load\'" onerror="window.__css = \'error\'">'
        + '<script src="app.js" onload="window.__js = \'load\'" onerror="window.__js = \'error\'"></script>';
    const OUTCOME = `(window.__js && window.__css) ? { js: window.__js, css: window.__css, ran: globalThis.__appRan === 1, width: getComputedStyle(document.getElementById('probe')).width } : null`;
    const directivesOf = (policy: string) => {
        const first = new Map<string, string>();
        for (const part of policy.split(';')) {
            const [name, ...tokens] = part.trim().split(/\s+/);
            if (name && !first.has(name.toLowerCase())) first.set(name.toLowerCase(), tokens.join(' '));
        }
        return Object.fromEntries(first);
    };
    const policyOf = async (page: Page, browserName: string) => directivesOf(await inView<string>(page, browserName, `document.querySelector('meta[http-equiv]').content`) as string);

    test('cooperative mode: the registered script runs and the stylesheet applies, no violation; blob: is in script-src, style-src and connect-src, nowhere else', async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles(FILES);
        expect(await sandbox.mount()).toBe('ready');
        expect(await sandbox.load(MARKUP)).toBe('ready');
        expect(await waitInView(page, browserName, OUTCOME, 8000)).toEqual({ js: 'load', css: 'load', ran: true, width: '123px' });
        expect(await sandbox.violations()).toEqual([]);
        expect(await policyOf(page, browserName)).toEqual({
            'default-src': "'none'",
            'script-src': "'unsafe-inline' blob: 'unsafe-eval'", // the baseline's scriptUnsafe
            'style-src': "'unsafe-inline' blob:",
            'img-src': "'none'",
            'font-src': "'none'",
            'media-src': "'none'",
            'connect-src': 'blob:',
            'worker-src': 'blob:', // never data: (broad review PD1)
            'frame-src': "'none'",
            'object-src': "'none'",
            'base-uri': "'none'",
            'form-action': "'none'",
            'manifest-src': "'none'",
            'upgrade-insecure-requests': '',
        });
    });

    test("strict mode: a registered stylesheet applies in the view, with blob: in the view's style-src and no -elem directive", async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles({ 'app.css': '#probe { width: 123px; }' });
        expect(await sandbox.mount({ mode: 'strict' })).toBe('ready');
        await sandbox.run(`sandboxView.render('<div id="probe"></div><link rel="stylesheet" href="app.css"><p id="done">done</p>')`);
        await waitInView(page, browserName, `getComputedStyle(document.getElementById('probe')).width === '123px'`, 8000);
        const policy = await policyOf(page, browserName);
        expect([policy['style-src'], policy['style-src-elem']]).toEqual(["'unsafe-inline' blob:", undefined]);
    });
});
