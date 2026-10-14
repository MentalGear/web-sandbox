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
