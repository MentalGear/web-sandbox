import { afterEach, describe, expect, it } from 'vitest';

/**
 * The list the request gate admits (`features.connect` of each bootstrap) is the guest policy's connect-src, exactly, in
 * every mode, after the host page's policy has narrowed the configured origins (BD3:TST-2, class E-net with A: one list,
 * two readers). request-gate.test.ts builds its own list with connectSources() and hands it to the bootstrap, and the e2e
 * specs use two fixed hosts, so nothing compared the two at the element: a gate that admitted the list from before the
 * page's policy narrowed it (or an origin nobody configured) left only the browser's policy between the guest and the
 * origin, and the gate's report and the browser's differed.
 */
afterEach(() => { document.body.replaceChildren(); });

const A = 'https://a.example';
const B = 'https://b.example';

async function element(config: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    el.setConfig(config);
    return el;
}

/** The gate's list as a bootstrap text carries it (the features literal), or null. */
const gateListIn = (text: string): string[] | null => {
    let decoded = text;
    for (let i = 0; i < 4; i++) decoded = decoded.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('\\"', '"');
    const found = /"connect":(\[[^\]]*\])/.exec(decoded);
    return found ? JSON.parse(found[1]!) : null;
};

/** The sources of the guest policy's connect-src. */
const connectSrcOf = (policy: string): string[] => /connect-src ([^;]*)/.exec(policy)![1]!.split(' ');

describe('the gate admits the policy\'s connect-src, exactly', () => {
    const narrowed = { origins: { connect: [A, B] }, hostContentSecurityPolicy: `connect-src ${A}` };

    for (const mode of ['strict', 'cooperative', 'worker'] as const) {
        it(`${mode}: the bootstrap's list equals the connect-src of the guest policy (the host page's policy dropped ${B})`, async () => {
            const el = await element({ ...narrowed, mode, ...(mode === 'strict' ? { entry: 'main.js' } : {}) });
            if (mode === 'strict') el.registerFiles({ 'main.js': 'void 0' });
            const prepared = el._prepareBuild();
            const policy: string = el._guestPolicy(el._files.snapshot(), el._reach().origins);
            const expected = connectSrcOf(policy);
            expect(expected.slice(0, 1), 'the page admitted the first').toEqual([A]);
            expect(expected, 'and dropped the second').not.toContain(B);
            const text = mode === 'strict' ? prepared.strictInit.workerSource : prepared.iframe.srcdoc;
            expect(gateListIn(text), mode).toEqual(expected);
            expect(gateListIn(text), `${mode}: the origin the page dropped is not admitted`).not.toContain(B);
        });
    }

    it('an origin that no configuration lists is in no list: the gate admits nothing the policy does not', async () => {
        const el = await element({ mode: 'worker', origins: { connect: [A] }, hostContentSecurityPolicy: `connect-src ${A}` });
        const prepared = el._prepareBuild();
        const list = gateListIn(prepared.iframe.srcdoc)!;
        expect(list).toEqual(connectSrcOf(el._guestPolicy(el._files.snapshot(), el._reach().origins)));
        expect(list.every((source: string) => source === A || source === 'blob:' || source === "'none'"), JSON.stringify(list)).toBe(true);
    });

    it('hostContentSecurityPolicy: false leaves the configured origins as they are, and the gate admits all of them', async () => {
        const el = await element({ mode: 'worker', origins: { connect: [A, B] }, hostContentSecurityPolicy: false });
        const prepared = el._prepareBuild();
        const expected = connectSrcOf(el._guestPolicy(el._files.snapshot(), el._reach().origins));
        expect(expected.slice(0, 2)).toEqual([A, B]);
        expect(gateListIn(prepared.iframe.srcdoc)).toEqual(expected);
    });
});
