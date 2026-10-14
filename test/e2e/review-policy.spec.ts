import type { Page } from '@playwright/test';
import { test, expect } from './fixture';
import { useRecorder } from './recorder';
import { inView, waitInView } from './strict-view';

/**
 * Adversarial review 2026-10, policy (docs/security/ADVERSARIAL-REVIEW-2026-10.md, A1). A configured value or key
 * cannot add a directive to a guest policy: the policy grammar keeps only known names and single source
 * expressions (src/lib/csp/policy-grammar.ts). Asserted here where it matters most, in strict mode, whose view
 * relies on script-src-attr 'none' (G1): an injected value that once enabled handler attributes in the view.
 * Evidence (T5): the view's policy and DOM read from outside; the handler's would-be request on the recorder,
 * with a positive control for the same kind of load in the same test; the view's violation report.
 */

const recorder = useRecorder();

const INJECTED_DEFAULT_SRC = "'none'; script-src-attr 'unsafe-inline'; script-src * 'unsafe-inline'; frame-src *";

test("A1: an injected default-src value gives the strict view no handler attributes: script-src-attr stays 'none', the handler never runs", async ({ sandbox, page, browserName }) => {
    // rendered by the entry, not execute(): the injected script-src would also have taken eval away
    const handler = `new Image().src='${recorder.allowed}/handler-ran.svg'`;
    const markup = `<img id="h" src="${recorder.allowed}/not-an-image.txt" onerror="${handler}"><img id="c" src="${recorder.allowed}/control.svg"><p id="done">done</p>`;
    await sandbox.registerFiles({ 'main.js': `sandboxView.render(${JSON.stringify(markup)});` });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', connectionsAllowed: { 'default-src': [INJECTED_DEFAULT_SRC], 'img-src': [recorder.allowed] } })).toBe('ready');
    await waitInView(page, browserName, `!!document.getElementById('done')`, 8000);

    // positive control: the view loads from the allowed origin, and the broken image did load (and fail)
    await recorder.waitFor('allowed', '/control.svg');
    await recorder.waitFor('allowed', '/not-an-image.txt');
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
});

/**
 * Follow-up audit 2026-10-14, the A3 class: one table says which directive governs each kind of load
 * (src/lib/csp/effective-directive.ts), and registered files add blob: there. With script-src-elem or
 * style-src-elem configured, those govern <script src> and stylesheets, so blob: must be in them: before the table it
 * went to script-src and style-src only, and every registered script and stylesheet was refused. Evidence (T5): each
 * load's own outcome and the computed style read from outside the guest frame, the host's violation events, the
 * policy read from outside; the same files without -elem directives as the positive control; the policy compared
 * whole, so nothing else was widened.
 */
test.describe('A3 class: registered files load under the directive that governs them', () => {
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

    test('script-src-elem and style-src-elem configured: the registered script runs and the stylesheet applies, no violation; blob: is in those two and connect-src, nowhere else new', async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles(FILES);
        expect(await sandbox.mount({ connectionsAllowed: { 'script-src-elem': ["'unsafe-inline'"], 'style-src-elem': ["'unsafe-inline'"] } })).toBe('ready');
        expect(await sandbox.load(MARKUP)).toBe('ready');
        expect(await waitInView(page, browserName, OUTCOME, 8000)).toEqual({ js: 'load', css: 'load', ran: true, width: '123px' });
        expect(await sandbox.violations()).toEqual([]);
        expect(await policyOf(page, browserName)).toEqual({
            'default-src': "'none'",
            'script-src': "'unsafe-inline' 'unsafe-eval'", // the baseline's scriptUnsafe; no blob: here
            'base-uri': "'none'",
            'style-src': "'unsafe-inline'",
            'form-action': "'none'",
            'worker-src': 'blob:', // never data: (broad review PD1)
            'script-src-elem': "'unsafe-inline' blob:",
            'style-src-elem': "'unsafe-inline' blob:",
            'upgrade-insecure-requests': '',
            'connect-src': 'blob:',
        });
    });

    test('positive control: without -elem directives the same files load, with blob: in script-src and style-src', async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles(FILES);
        expect(await sandbox.mount()).toBe('ready');
        expect(await sandbox.load(MARKUP)).toBe('ready');
        expect(await waitInView(page, browserName, OUTCOME, 8000)).toEqual({ js: 'load', css: 'load', ran: true, width: '123px' });
        expect(await sandbox.violations()).toEqual([]);
        const policy = await policyOf(page, browserName);
        expect([policy['script-src'], policy['style-src'], policy['script-src-elem'], policy['style-src-elem']]).toEqual(["'unsafe-inline' blob: 'unsafe-eval'", "'unsafe-inline' blob:", undefined, undefined]);
    });

    test("strict mode: a configured style-src-elem (which the view never emits) leaves blob: in the view's style-src, and a registered stylesheet applies there", async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles({ 'app.css': '#probe { width: 123px; }' });
        expect(await sandbox.mount({ mode: 'strict', connectionsAllowed: { 'style-src-elem': ["'unsafe-inline'"] } })).toBe('ready');
        await sandbox.run(`sandboxView.render('<div id="probe"></div><link rel="stylesheet" href="app.css"><p id="done">done</p>')`);
        await waitInView(page, browserName, `getComputedStyle(document.getElementById('probe')).width === '123px'`, 8000);
        const policy = await policyOf(page, browserName);
        expect([policy['style-src'], policy['style-src-elem']]).toEqual(["'unsafe-inline' blob:", undefined]);
    });
});
