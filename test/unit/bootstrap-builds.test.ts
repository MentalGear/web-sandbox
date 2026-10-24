import { afterEach, describe, expect, it } from 'vitest';
import { createBroker } from '@src/lib/rpc';
import { createSizeOf } from '@src/lib/structured-size';

/**
 * Every build hands the guest's bootstrap the byte measure (BD3:TST-10, class P): the bootstrap measures what it posts with
 * the one measure of `call()` (structured-size.ts), and a build that left it out would post unmeasured, which only the
 * Chromium e2e (exact-budget.spec.ts) noticed for the strict worker. The text of each of the three builds (strict, cooperative
 * and worker mode) carries the measure and the broker whole, once each.
 */
afterEach(() => { document.body.replaceChildren(); });

async function build(mode: 'strict' | 'cooperative' | 'worker') {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    el.setConfig({ mode, ...(mode === 'strict' ? { entry: 'main.js' } : {}) });
    if (mode === 'strict') el.registerFiles({ 'main.js': 'void 0' });
    const prepared = el._prepareBuild();
    let text: string = mode === 'strict' ? prepared.strictInit.workerSource : prepared.iframe.srcdoc;
    for (let i = 0; i < 4; i++) text = text.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    return text;
}

// Worker mode's frame holds the worker's whole source as one string literal, so the functions stand there escaped.
const escaped = (code: string) => JSON.stringify(code).slice(1, -1).replaceAll('<', '\\u003c');
const occurrences = (text: string, part: string) => text.split(part).length - 1;
const either = (text: string, code: string) => occurrences(text, code) + occurrences(text, escaped(code));

describe('the guest bootstrap of every build carries the byte measure and the broker', () => {
    for (const mode of ['strict', 'cooperative', 'worker'] as const) {
        it(`${mode} mode: createSizeOf and createBroker, whole, once each`, async () => {
            const text = await build(mode);
            expect(either(text, createSizeOf.toString()), 'createSizeOf').toBe(1);
            expect(either(text, createBroker.toString()), 'createBroker').toBe(1);
        });
    }
});
