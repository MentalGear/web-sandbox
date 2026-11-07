import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The element's warnings that a config or a build brings back (host.ts, _warnOnce): every build of the same config says
 * the same, so each text is said once per element, and each element says it for itself. The config schema's warnings,
 * the import maps', a module the lexer cannot read, cooperative mode without scripts, the view's still stylesheet and
 * `html`'s scripts are pinned beside their subjects; these are the build's others.
 */

const A = 'https://a.example';

async function mount(config: Record<string, unknown>, files: Record<string, string>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    el.registerFiles(files);
    el.setConfig(config);
    document.body.appendChild(el); // configured first: the one build of the first config is the config's mode
    return el;
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const CASES: [string, Record<string, unknown>, Record<string, string>, string][] = [
    ['a reference in guest markup to a file of a type its load is not for', { mode: 'cooperative', capabilities: ['allow-scripts'], html: '<script src="x.txt"></script>' }, { 'x.txt': 'a' }, 'guest markup names "x.txt"'],
    ["a registered stylesheet's URL the view drops (strict)", { mode: 'strict' }, { 'a.css': `p { background: url(${A}/x.png) }` }, 'registered stylesheet "a.css"'],
    ["a registered stylesheet's URL the view drops (sealed)", { mode: 'sealed' }, { 'a.css': `p { background: url(${A}/x.png) }` }, 'registered stylesheet "a.css"'],
    ["an origin the host page's policy does not admit", { mode: 'strict', origins: { connect: [A] }, hostContentSecurityPolicy: "connect-src 'self'" }, {}, `origins.connect dropped ${A}`],
];

describe('every warning a build brings back is said once per element', () => {
    it.each(CASES)('%s: once across rebuilds (reset(), a setConfig() that changes only html), and once more for another element', async (_, config, files, text) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const said = () => warn.mock.calls.map(call => String(call[0])).filter(message => message.includes(text));
        const el = await mount(config, files);
        expect(said(), 'the first build says it').toHaveLength(1);
        el.reset();
        el.setConfig({ ...config, html: '<p>another build</p>' + String(config.html ?? '') });
        el.reset();
        expect(said()).toHaveLength(1);
        await mount(config, files);
        expect(said(), 'another element says it for itself').toHaveLength(2);
    });
});
