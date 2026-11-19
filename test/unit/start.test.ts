import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineWebSandbox } from '@src/host';
import { APP_OPTIONS, CONFIG_SCHEMA, EMBEDDER_OPTIONS } from '@src/lib/config-schema';
import { MAX_TOTAL_BYTES } from '@src/lib/files';
import { VIEW_RENDER_MAX_LENGTH } from '@src/lib/in-sandbox-view';
import { reasonText } from '@src/lib/reasons';

/**
 * `start(app, grants)` in the default build (design 01, "start(app, grants)"; I1, I2, I17): every way it throws leaves
 * the element equal to a new one; the check that the element has no app and the store of what was validated are one
 * step, so a getter or a Proxy trap of the arguments that calls start() on the same element binds one app, never a mix;
 * a second call throws; the app builds on insertion, again after a removal, and on reset(); each argument refuses the
 * other's keys and any it does not know; and an option of the network modes is refused with `networkModesOff`'s text.
 * The network build's part is test/unit/start-network.test.ts.
 */

defineWebSandbox();

const newElement = () => document.createElement('web-sandbox') as any;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const APP_JS = 'bridge.expose("ping", () => "pong");';
const app = (html = '<p>one</p>') => ({ html, entry: 'app.js', files: { 'app.js': APP_JS, 'app.css': 'p { color: red }' } });
const save = () => 'saved';

/**
 * A guest's call to the element's host method `name`, delivered on a port of the element's (as test/unit/rpc-what-crosses
 * delivers it), and its answer.
 */
function guestCall(el: any, name: string): Promise<unknown> {
    const { port1 } = new MessageChannel();
    const saved = el._port;
    el._port = port1;
    return new Promise<unknown>(resolve => {
        el._onGuestMessage(port1, (reply: any) => resolve(reply.ok ? { ok: reply.value } : { code: reply.code }), { type: 'RPC_REQ', id: 1, method: name, args: [] }, null);
    }).finally(() => {
        el._port = saved;
        port1.close();
    });
}

/** Everything a start() could have stored or started, as one value: what a new element compares equal to. */
async function snapshot(el: any) {
    return {
        state: el.state,
        started: el.started,
        files: el.listFiles(),
        config: structuredClone(el._config),
        lifecycle: { gen: el._lc.gen, inputs: el._lc.inputs, refused: el._lc.refused, build: el._lc.build },
        frames: el.shadowRoot.querySelectorAll('iframe').length,
        warned: [...el._warned],
        exposed: [...el._exposedNames],
        save: await guestCall(el, 'save'),
    };
}

// Each way start() refuses its arguments: the call, and the class of what it throws (a FileError carries its code).
const REFUSALS: [string, (el: any) => void, string][] = [
    ['an app that is not an object', (el) => el.start(null), 'TypeError'],
    ['an app that is a list', (el) => el.start([]), 'TypeError'],
    ['no app at all', (el) => el.start(), 'TypeError'],
    ['grants that are not an object', (el) => el.start(app(), 5), 'TypeError'],
    ['grants that are null', (el) => el.start(app(), null), 'TypeError'],
    ["a grant in the app (I17): guestWrites", (el) => el.start({ ...app(), guestWrites: true }), 'TypeError'],
    ["a grant in the app (I17): methods", (el) => el.start({ ...app(), methods: { save } }), 'TypeError'],
    ["a grant in the app (I17): capabilities", (el) => el.start({ ...app(), capabilities: ['allow-modals'] }), 'TypeError'],
    ["the app's own content in the grants: html", (el) => el.start({}, { html: '<p>x</p>' }), 'TypeError'],
    ["the app's own content in the grants: files", (el) => el.start({}, { files: { 'a.js': '' } }), 'TypeError'],
    ['a key the app does not know', (el) => el.start({ ...app(), hmtl: '<p>x</p>' }), 'TypeError'],
    ['a key the grants do not know', (el) => el.start(app(), { methods: { save }, guestWrite: true }), 'TypeError'],
    ['an html that is not a string', (el) => el.start({ html: 5 }), 'TypeError'],
    ['an html longer than one render', (el) => el.start({ html: 'x'.repeat(VIEW_RENDER_MAX_LENGTH + 1) }), 'TypeError'],
    ['an entry that is not a string', (el) => el.start({ entry: 5, files: { 'app.js': APP_JS } }), 'TypeError'],
    ['an entry that names no file given', (el) => el.start({ entry: 'main.js', files: { 'app.js': APP_JS } }), 'TypeError'],
    ['an entry that names a file that is not JavaScript', (el) => el.start({ entry: 'app.css', files: { 'app.css': 'p {}' } }), 'TypeError'],
    ['an entry with no files', (el) => el.start({ entry: 'app.js' }), 'TypeError'],
    ['a mode that is no mode', (el) => el.start(app(), { mode: 'seald' }), 'TypeError'],
    ['a switch that is not a boolean', (el) => el.start(app(), { guestWrites: 'yes' }), 'TypeError'],
    ['a view switch that is not a boolean', (el) => el.start(app(), { allowAnimations: 1 }), 'TypeError'],
    ['capabilities that are not a list', (el) => el.start(app(), { capabilities: 'allow-modals' }), 'TypeError'],
    ['a capability that is not allowed', (el) => el.start(app(), { capabilities: ['allow-top-navigation'] }), 'TypeError'],
    ['callLimits that are not an object', (el) => el.start(app(), { callLimits: 5 }), 'TypeError'],
    ['a callLimits field below 1', (el) => el.start(app(), { callLimits: { maxPerSecond: 0 } }), 'TypeError'],
    ['a watchdogTimeout that is no delay', (el) => el.start(app(), { watchdogTimeout: -1 }), 'TypeError'],
    ['a hostContentSecurityPolicy of the wrong type', (el) => el.start(app(), { hostContentSecurityPolicy: true }), 'TypeError'],
    ['scriptUnsafe in sealed mode', (el) => el.start(app(), { scriptUnsafe: true }), 'TypeError'],
    ['an option that cannot be copied', (el) => el.start(app(), { capabilities: new Proxy([], {}) }), 'TypeError'],
    ['a network mode', (el) => el.start(app(), { mode: 'strict' }), 'TypeError'],
    ['origins', (el) => el.start(app(), { origins: { images: ['https://cdn.example'] } }), 'TypeError'],
    ['fetchBridge', (el) => el.start(app(), { fetchBridge: { allow: ['https://api.example'] } }), 'TypeError'],
    ['files that are not an object', (el) => el.start({ files: 'app.js' }), 'INVALID_FILE'],
    ['a path that is not valid', (el) => el.start({ files: { '../app.js': APP_JS } }), 'INVALID_PATH'],
    ['a file entry that is not one', (el) => el.start({ files: { 'app.js': 5 } }), 'INVALID_FILE'],
    ['files past the quota', (el) => el.start({ files: { 'big.bin': new Uint8Array(MAX_TOTAL_BYTES + 1) } }), 'FILES_QUOTA_EXCEEDED'],
    ['methods that are not an object', (el) => el.start(app(), { methods: save }), 'TypeError'],
    ['a method that is not a function', (el) => el.start(app(), { methods: { save: 'save' } }), 'TypeError'],
    ['a reserved method name', (el) => el.start(app(), { methods: { 'sandbox:write': save } }), 'TypeError'],
    ['a method name longer than 256 characters', (el) => el.start(app(), { methods: { ['m'.repeat(257)]: save } }), 'TypeError'],
    ['a bad file after valid options and methods', (el) => el.start({ ...app(), files: { 'app.js': APP_JS, 'b ad.js': '' } }, { methods: { save }, guestWrites: true }), 'INVALID_PATH'],
    ['a bad method after valid options and files', (el) => el.start(app(), { guestWrites: true, methods: { save, broken: null } }), 'TypeError'],
];

const kindOf = (error: any) => (error instanceof TypeError ? 'TypeError' : String(error?.code));

describe('start(): every way it throws leaves the element equal to a new one (I2)', () => {
    it.each(REFUSALS)('%s, outside a document', async (_label, call, kind) => {
        const el = newElement();
        let thrown: unknown = null;
        try {
            call(el);
        } catch (error) {
            thrown = error;
        }
        expect(kindOf(thrown)).toBe(kind);
        expect(await snapshot(el)).toEqual(await snapshot(newElement()));
    });

    it.each(REFUSALS)('%s, in a document: nothing is built either', async (_label, call, kind) => {
        const el = newElement();
        const fresh = newElement();
        document.body.append(el, fresh);
        let thrown: unknown = null;
        try {
            call(el);
        } catch (error) {
            thrown = error;
        }
        expect(kindOf(thrown)).toBe(kind);
        expect(await snapshot(el)).toEqual(await snapshot(fresh));
    });

    it('a refused start() leaves the element startable: a corrected app binds', async () => {
        const el = newElement();
        expect(() => el.start({ ...app(), guestWrites: true })).toThrow(TypeError);
        el.start(app(), { guestWrites: true, methods: { save } });
        expect(el.started).toBe(true);
        expect(await guestCall(el, 'save')).toEqual({ ok: 'saved' });
    });

    it('the example of the design: start({ html, guestWrites: true }) throws, and names where the grant belongs', () => {
        expect(() => newElement().start({ html: '<p>x</p>', guestWrites: true })).toThrow(/"guestWrites" belongs to the grants, the second argument/);
    });

    it("an option of the network modes throws with the reason of the networkModesOff termination", () => {
        for (const grants of [{ mode: 'strict' }, { mode: 'cooperative' }, { mode: 'worker' }, { origins: {} }, { fetchBridge: {} }]) {
            expect(() => newElement().start(app(), grants), JSON.stringify(grants)).toThrow(reasonText('networkModesOff'));
        }
    });
});

describe('start(): each argument takes its own keys (I17, CONFIG_SCHEMA `owner`)', () => {
    it('every key of the schema is the app\'s or the embedder\'s, and none is both', () => {
        expect([...APP_OPTIONS, ...EMBEDDER_OPTIONS].sort()).toEqual(Object.keys(CONFIG_SCHEMA).sort());
        expect(APP_OPTIONS.filter(name => EMBEDDER_OPTIONS.includes(name))).toEqual([]);
    });

    it.each(EMBEDDER_OPTIONS)("the app refuses the embedder's %s, before reading any value", (name) => {
        let read = false;
        const given = { html: '<p>x</p>', get [name]() { read = true; return undefined; } };
        expect(() => newElement().start(given)).toThrow(new RegExp(`"${name}" belongs to the grants`));
        expect(read).toBe(false);
    });

    it.each(APP_OPTIONS)("the grants refuse the app's %s, before reading any value", (name) => {
        let read = false;
        const given = { get [name]() { read = true; return undefined; } };
        expect(() => newElement().start({}, given)).toThrow(new RegExp(`"${name}" belongs to the app`));
        expect(read).toBe(false);
    });
});

describe('start(): what it stores', () => {
    it.each(['connectionsAllowed', 'virtualFilesUrl'])("a removed option the schema still knows (%s) is a grant: ignored with today's warning, and the app binds", (name) => {
        const el = newElement();
        el.start(app(), { [name]: 'x' });
        expect(el.started).toBe(true);
        expect(warn.mock.calls.map((args: unknown[]) => String(args[0])).filter((message: string) => message.includes(name))).toHaveLength(1);
    });

    it.each(['hostContentSecurityPolicy', 'scriptUnsafe', 'unsafeCapabilities'])("%s is the embedder's: a grant, and refused in the app", (name) => {
        expect(EMBEDDER_OPTIONS).toContain(name);
        expect(() => newElement().start({ [name]: false })).toThrow(new RegExp(`"${name}" belongs to the grants`));
    });

    it('started is false on a new element, true from the first success on', () => {
        const el = newElement();
        expect(el.started).toBe(false);
        el.start(app());
        expect(el.started).toBe(true);
        el.terminate();
        expect(el.started).toBe(true);
    });

    it("the embedder's objects are not kept: changing them afterwards changes nothing", async () => {
        const el = newElement();
        const given = app();
        const methods: Record<string, () => unknown> = { save };
        const grants = { methods, capabilities: ['allow-orientation-lock'] as string[] };
        el.start(given, grants);
        given.html = '<p>changed</p>';
        given.files['app.js'] = 'changed';
        (given.files as Record<string, string>)['more.js'] = '';
        methods.save = () => 'changed';
        methods.other = () => 'other';
        grants.capabilities.push('allow-scripts');
        expect(el._config.html).toBe('<p>one</p>');
        expect(el._config.capabilities).toEqual(['allow-orientation-lock']);
        expect(el.listFiles().map((file: { path: string }) => file.path)).toEqual(['app.css', 'app.js']);
        expect(await guestCall(el, 'save')).toEqual({ ok: 'saved' });
        expect(await guestCall(el, 'other')).toEqual({ code: 'UNKNOWN_METHOD' });
    });

    it('the methods are reachable, and a name not given is UNKNOWN_METHOD', async () => {
        const el = newElement();
        el.start(app(), { methods: { save } });
        expect(await guestCall(el, 'save')).toEqual({ ok: 'saved' });
        expect(await guestCall(el, 'load')).toEqual({ code: 'UNKNOWN_METHOD' });
    });

    it("an option outside its modes, or a notice, is said once the app is bound, as setConfig() says it", () => {
        const el = newElement();
        el.start(app(), { unsafeCapabilities: ['allow-popups'] as never });
        expect(warn.mock.calls.map((args: unknown[]) => String(args[0]))).toContain('[Sandbox] unsafeCapabilities are not available in sealed mode and were dropped: allow-popups.');
    });
});

describe('start(): the binding is one step (I1)', () => {
    it('a getter of the app that calls start() on the same element: the inner call binds, the outer throws, and the element holds the inner app only', async () => {
        const el = newElement();
        document.body.append(el);
        const outer = {
            entry: 'app.js',
            files: { 'app.js': APP_JS },
            get html() {
                el.start({ html: '<p>inner</p>' }, { methods: { inner: () => 'inner' } });
                return '<p>outer</p>';
            },
        };
        expect(() => el.start(outer, { methods: { outer: () => 'outer' }, guestWrites: true })).toThrow(/already runs its app/);
        expect(el.started).toBe(true);
        expect(el._config.html).toBe('<p>inner</p>');
        expect(el._config.entry).toBeUndefined();
        expect(el._config.guestWrites).toBe(false);
        expect(el.listFiles()).toEqual([]);
        expect(await guestCall(el, 'inner')).toEqual({ ok: 'inner' });
        expect(await guestCall(el, 'outer')).toEqual({ code: 'UNKNOWN_METHOD' });
        expect(el._strictInit.html).toBe('<p>inner</p>'); // the standing build is the inner app's
    });

    it("a Proxy trap of the grants that calls start() on the same element: one app binds, never a mix", async () => {
        const el = newElement();
        const grants = new Proxy({ methods: { outer: () => 'outer' } }, {
            ownKeys(target) {
                el.start({ html: '<p>inner</p>' }, { methods: { inner: () => 'inner' } });
                return Reflect.ownKeys(target);
            },
        });
        expect(() => el.start({ html: '<p>outer</p>' }, grants)).toThrow(/already runs its app/);
        expect(el._config.html).toBe('<p>inner</p>');
        expect(await guestCall(el, 'inner')).toEqual({ ok: 'inner' });
        expect(await guestCall(el, 'outer')).toEqual({ code: 'UNKNOWN_METHOD' });
    });

    it('a getter of a method list that calls start() with an app that is refused: the outer call still binds', async () => {
        const el = newElement();
        let inner: unknown = null;
        const methods = {
            get save() {
                try {
                    el.start({ html: 5 });
                } catch (error) {
                    inner = error;
                }
                return save;
            },
        };
        el.start(app(), { methods });
        expect(inner).toBeInstanceOf(TypeError);
        expect(el.started).toBe(true);
        expect(el._config.html).toBe('<p>one</p>');
        expect(await guestCall(el, 'save')).toEqual({ ok: 'saved' });
    });

    it('a console.warn that calls start() while a bound app\'s notice is said: refused, the first app stays', () => {
        const el = newElement();
        let inner: unknown = null;
        warn.mockImplementation(() => {
            try {
                el.start({ html: '<p>inner</p>' });
            } catch (error) {
                inner = error;
            }
        });
        el.start(app(), { unsafeCapabilities: ['allow-popups'] as never });
        expect(inner).toBeInstanceOf(TypeError);
        expect(el._config.html).toBe('<p>one</p>');
    });
});

describe('start(): a second call throws, whatever the state', () => {
    const STATES: [string, (el: any) => void][] = [
        ['outside a document', () => {}],
        ['loading', (el) => document.body.append(el)],
        ['terminated', (el) => { document.body.append(el); el.terminate(); }],
        ['removed from its document', (el) => { document.body.append(el); el.remove(); }],
    ];
    it.each(STATES)('%s', async (_label, into) => {
        const el = newElement();
        el.start(app(), { methods: { save } });
        into(el);
        const before = await snapshot(el);
        let read = false;
        const second = { get html() { read = true; return '<p>two</p>'; } };
        expect(() => el.start(second, { methods: { other: save } })).toThrow(TypeError);
        expect(read, 'nothing of the second app is read').toBe(false);
        expect(await snapshot(el)).toEqual(before);
    });
});

describe("start(): the app's lifecycle", () => {
    const appFiles = (el: any) => el.listFiles().map((file: { path: string }) => file.path);

    it('outside a document it stores the app and builds nothing; inserted, it builds that app', () => {
        const el = newElement();
        el.start(app('<p>later</p>'));
        expect(el.state).toBe('idle');
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(0);
        document.body.append(el);
        expect(el.state).toBe('loading');
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(1);
        expect(el._strictInit.html).toBe('<p>later</p>');
        expect(el._strictInit.workerSource).toContain(APP_JS);
    });

    it('in a document it builds at once', () => {
        const el = newElement();
        document.body.append(el);
        el.start(app('<p>now</p>'));
        expect(el.state).toBe('loading');
        expect(el._strictInit.html).toBe('<p>now</p>');
    });

    it('removal ends the environment; re-insertion builds the same app again, its methods still reachable', async () => {
        const el = newElement();
        document.body.append(el);
        el.start(app('<p>same</p>'), { methods: { save } });
        const gen = el._lc.gen;
        el.remove();
        expect(el.state).toBe('idle');
        expect(el.started).toBe(true);
        document.body.append(el);
        expect(el.state).toBe('loading');
        expect(el._lc.gen).toBeGreaterThan(gen);
        expect(el._strictInit.html).toBe('<p>same</p>');
        expect(appFiles(el)).toEqual(['app.css', 'app.js']);
        expect(await guestCall(el, 'save')).toEqual({ ok: 'saved' });
    });

    it('reset() rebuilds the same app', async () => {
        const el = newElement();
        document.body.append(el);
        el.start(app('<p>again</p>'), { methods: { save } });
        const gen = el._lc.gen;
        el.reset();
        expect(el.state).toBe('loading');
        expect(el._lc.gen).toBeGreaterThan(gen);
        expect(el._strictInit.html).toBe('<p>again</p>');
        expect(await guestCall(el, 'save')).toEqual({ ok: 'saved' });
    });

    it('terminate() ends it, and a later reset() starts the same app', async () => {
        const el = newElement();
        document.body.append(el);
        el.start(app('<p>back</p>'), { methods: { save } });
        el.terminate();
        expect(el.state).toBe('terminated');
        expect(el.started).toBe(true);
        el.reset();
        expect(el.state).toBe('loading');
        expect(el._strictInit.html).toBe('<p>back</p>');
        expect(appFiles(el)).toEqual(['app.css', 'app.js']);
        expect(await guestCall(el, 'save')).toEqual({ ok: 'saved' });
    });

    it('a refusal of an earlier setConfig() does not stand in the way of the app start() binds', () => {
        const el = newElement();
        document.body.append(el);
        el.setConfig({ mode: 'strict' } as never); // refused in this build: the sandbox terminates
        expect(el.state).toBe('terminated');
        el.start(app());
        expect(el.state).toBe('loading');
    });

    it('what the other members set before is replaced whole: the files and the host methods are the app\'s', async () => {
        const el = newElement();
        el.registerFiles({ 'old.js': '' });
        el.expose('old', () => 'old');
        el.start(app(), { methods: { save } });
        expect(appFiles(el)).toEqual(['app.css', 'app.js']);
        expect(await guestCall(el, 'old')).toEqual({ code: 'UNKNOWN_METHOD' });
        expect(await guestCall(el, 'save')).toEqual({ ok: 'saved' });
    });
});
