import '@src/network'; // the network build: this file tests modes and options the default build does not have (ADR-009)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineWebSandbox } from '@src/host';
import { reasonText } from '@src/lib/reasons';

/**
 * `start(app, grants)` in the build with the network modes (design 01, "start(app, grants)"): the network modes and their
 * options are grants like any other, read by the same schema, and what the schema refuses throws, leaving the element as
 * a new one. The default build's part is test/unit/start.test.ts.
 */

defineWebSandbox();

const newElement = () => document.createElement('web-sandbox') as any;
const snapshot = (el: any) => ({ state: el.state, started: el.started, files: el.listFiles(), config: structuredClone(el._config), origins: el._origins, fetchPolicy: el._fetchPolicy, gen: el._lc.gen });

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const APP = { entry: 'app.js', files: { 'app.js': 'bridge.expose("ping", () => "pong");' } };

describe('start() with the network modes', () => {
    it('binds a strict app with its origins, and builds it in a document', () => {
        const el = newElement();
        document.body.append(el);
        el.start(APP, { mode: 'strict', origins: { images: ['https://cdn.example'] }, hostContentSecurityPolicy: false });
        expect(el.started).toBe(true);
        expect(el._config.mode).toBe('strict');
        expect(el._origins.images).toEqual(['https://cdn.example']);
        expect(el.state).toBe('loading');
    });

    it("a mode that does not run an entry ignores the app's entry, with the schema's warning, and does not look for its file", () => {
        const el = newElement();
        el.start({ entry: 'missing.js' }, { mode: 'worker' });
        expect(el.started).toBe(true);
        expect(el._config.entry).toBeUndefined();
    });

    const REFUSALS: [string, object, RegExp | string][] = [
        ['origins that are not an object', { mode: 'strict', origins: 5 }, /origins/],
        ['a sealed config that names origins', { origins: { images: ['https://cdn.example'] } }, reasonText('sealedNetwork')],
        ['a sealed config that names fetchBridge', { mode: 'sealed', fetchBridge: { allow: ['https://api.example'] } }, reasonText('sealedNetwork')],
        ['a mode that is no mode', { mode: 'iframe' }, /unknown mode: .*'iframe' was renamed 'cooperative'/],
    ];
    it.each(REFUSALS)('%s throws a TypeError, and leaves the element as a new one', (_label, grants, message) => {
        const el = newElement();
        expect(() => el.start(APP, grants)).toThrow(TypeError);
        expect(() => el.start(APP, grants)).toThrow(message);
        expect(snapshot(el)).toEqual(snapshot(newElement()));
    });

    it("a network option in the app is the grants' key, refused before anything is read", () => {
        expect(() => newElement().start({ ...APP, origins: {} })).toThrow(/"origins" belongs to the grants/);
        expect(() => newElement().start({ ...APP, mode: 'strict' })).toThrow(/"mode" belongs to the grants/);
    });
});
