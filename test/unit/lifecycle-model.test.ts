import { describe, expect, it } from 'vitest';
import { Divergence, LifecycleModel, unknownModeReason, type Cmd, type ConfigDesc, type Observation } from '../model/lifecycle-model';
import { generate, mulberry32, shrink } from '../model/generator';

/**
 * The lifecycle model itself (test/model/lifecycle-model.ts), on hand-written traces of the findings of R4 and R5: for each
 * finding, the trace of the element's behaviour with the defect is a divergence, and the trace of the fixed element is
 * not. Every expectation here is one the element meets.
 */

const valid = (mode: 'strict' | 'cooperative' | 'worker', extra: Partial<Extract<ConfigDesc, { kind: 'valid' }>> = {}): ConfigDesc => ({
    kind: 'valid', mode, scriptUnsafe: true, guestWrites: false, watchdog: undefined, execTimeout: undefined, html: 'agent', fetch: false, limits: 'none', variant: 0,
    ...(mode === 'strict' ? { entry: 'agent.js' as const } : {}),
    ...extra,
});

// An observed event: from a task unless `depth` says otherwise; frozen; the element's state as the model expects it.
function seen(model: LifecycleModel, type: string, detail: unknown, more: Partial<Observation> = {}): Observation {
    return { type, detail, depth: 0, inDom: false, state: type === 'ready' ? 'ready' : type === 'terminated' ? 'terminated' : model.state, frozen: true, now: 0, ...more };
}

// One operation with nothing dispatched inside it but what `inside` dispatches.
function op(model: LifecycleModel, cmd: Cmd, inside: () => void = () => {}, now = 0) {
    const frame = model.begin(cmd, now);
    inside();
    model.end(frame, { threw: frame.expectThrow, warned: frame.expectWarn ? 1 : 0, state: model.state });
    return frame;
}

function standing(mode: 'strict' | 'cooperative' | 'worker', config: ConfigDesc = valid(mode)): LifecycleModel {
    const model = new LifecycleModel(mode);
    op(model, { op: 'register', files: { 'agent.js': 'AGENT', 'data.txt': 'data' } }, () => model.event(seen(model, 'fileschanged', { paths: ['agent.js', 'data.txt'] }, { depth: 1 })));
    op(model, { op: 'setConfig', cfg: config });
    op(model, { op: 'insert' });
    expect(model.state).toBe('loading');
    return model;
}

describe('the lifecycle model on the round reports', () => {
    describe("round 4, L-1: a frame's load completed a build inside the embedder's appendChild() or remove()", () => {
        it('before the fix: `ready` inside the DOM operation is a divergence', () => {
            const model = standing('cooperative', valid('cooperative', { noScripts: true, html: 'plain' }));
            expect(() => op(model, { op: 'insert' }, () => model.event(seen(model, 'ready', null, { depth: 1, inDom: true })))).toThrow(Divergence);
        });
        it('after it: `ready` comes from a task, after the move', () => {
            const model = standing('cooperative', valid('cooperative', { noScripts: true, html: 'plain' }));
            op(model, { op: 'insert' });
            model.event(seen(model, 'ready', null));
            expect(model.state).toBe('ready');
            expect(() => model.event(seen(model, 'ready', null))).toThrow(/already ready/);
        });
    });

    describe('round 4, L-3: the no-repeat rule holds for every `terminated`, not only a build\'s', () => {
        const reason = unknownModeReason('Strict');
        function trace(model: LifecycleModel) {
            // terminate(reason) from ready; its listener sets a config refused with that very reason
            op(model, { op: 'terminate', reason }, () => {
                model.event(seen(model, 'terminated', { reason }, { depth: 1 }));
                op(model, { op: 'setConfig', cfg: { kind: 'unknownMode', mode: 'Strict' } });
                model.eventEnd('terminated');
            });
        }
        it('before the fix: a second `terminated` with the reason is a divergence', () => {
            const model = standing('strict');
            model.event(seen(model, 'ready', null));
            trace(model);
            expect(model.pendingTermination).toBeNull();
            expect(() => model.event(seen(model, 'terminated', { reason }))).toThrow(/unexpected terminated/);
        });
        it('after it: the rebuild ends `terminated` and dispatches nothing', () => {
            const model = standing('strict');
            model.event(seen(model, 'ready', null));
            trace(model);
            expect(model.state).toBe('terminated');
            expect(model.quiet).toBe(true);
            model.finish();
        });
        it('a refusal with another reason is dispatched, in a task', () => {
            const model = standing('strict');
            model.event(seen(model, 'ready', null));
            op(model, { op: 'terminate', reason: 'bye' }, () => {
                model.event(seen(model, 'terminated', { reason: 'bye' }, { depth: 1 }));
                op(model, { op: 'setConfig', cfg: { kind: 'unknownMode', mode: 'Strict' } });
                model.eventEnd('terminated');
            });
            expect(model.pendingTermination).toEqual({ reason, gen: model.gen });
            model.event(seen(model, 'terminated', { reason }));
            expect(model.quiet).toBe(true);
        });
    });

    describe('round 5, L-1: a call made while loading that timed out before `ready` still ran', () => {
        function trace(model: LifecycleModel) {
            const frame = op(model, { op: 'call', method: 'act', spec: { k: 'mark' }, timeout: 20 }, () => {}, 0);
            const id = frame.callId!;
            model.settled(id, { status: 'rejected', code: 'TIMEOUT' }, 25); // still loading
            model.event(seen(model, 'ready', null, { now: 40 }));
            return id;
        }
        it('before the fix: its line after `ready` is a divergence', () => {
            const model = standing('strict');
            const id = trace(model);
            expect(() => model.event(seen(model, 'sandbox-log', { type: 'LOG', level: 'log', args: [`[env:${model.env!.id}] mark ${id}`], source: 'guest' }))).toThrow(/timed out before ready and ran anyway/);
        });
        it('after it: the call never runs, and a call after `ready` does', () => {
            const model = standing('strict');
            trace(model);
            const after = op(model, { op: 'call', method: 'act', spec: { k: 'mark' } }).callId!;
            model.event(seen(model, 'sandbox-log', { type: 'LOG', level: 'log', args: [`[env:${model.env!.id}] mark ${after}`], source: 'guest' }));
            model.settled(after, { status: 'resolved', value: after }, 60);
            model.finish();
        });
        it('a TIMEOUT before the timeout has passed is a divergence', () => {
            const model = standing('strict');
            const id = op(model, { op: 'call', method: 'act', spec: { k: 'mark' }, timeout: 20 }, () => {}, 0).callId!;
            expect(() => model.settled(id, { status: 'rejected', code: 'TIMEOUT' }, 5)).toThrow(/TIMEOUT after 5 ms/);
        });
    });

    describe('round 5, L-3: `terminated` and `fileschanged` details were not frozen', () => {
        it('before the fix: a detail that is not frozen is a divergence', () => {
            const model = standing('strict');
            expect(() => op(model, { op: 'terminate', reason: 'x' }, () => model.event(seen(model, 'terminated', { reason: 'x' }, { depth: 1, frozen: false })))).toThrow(/not frozen/);
        });
        it('after it: frozen details pass, and a terminated event is synchronous with terminate()', () => {
            const model = standing('strict');
            op(model, { op: 'terminate', reason: 'x' }, () => {
                model.event(seen(model, 'terminated', { reason: 'x' }, { depth: 1 }));
                model.eventEnd('terminated');
            });
            expect(() => op(model, { op: 'terminate', reason: 'y' })).not.toThrow(); // a no-op while terminated
            expect(() => op(model, { op: 'reset' }, () => {})).not.toThrow();
            const model2 = standing('strict');
            expect(() => op(model2, { op: 'terminate', reason: 'x' })).toThrow(/expected .*terminated.* not dispatched/);
        });
    });

    describe('round 5, L-2 and N-4/L-4: the byte budget and one diff for guest writes', () => {
        it('a guest call heavier than maxBytesPerSecond is ARGS_NOT_TRANSFERABLE, never BUSY', () => {
            const model = standing('strict', valid('strict', { limits: 'tinyBytes' }));
            model.event(seen(model, 'ready', null));
            const busy = op(model, { op: 'call', method: 'act', spec: { k: 'callHost' } }).callId!;
            expect(() => model.settled(busy, { status: 'resolved', value: 'code:BUSY' }, 1)).toThrow(/ARGS_NOT_TRANSFERABLE/);
            const fine = op(model, { op: 'call', method: 'act', spec: { k: 'callHost' } }).callId!;
            model.settled(fine, { status: 'resolved', value: 'code:ARGS_NOT_TRANSFERABLE' }, 1);
        });
        it('a withdrawn write is announced once, with nothing listed', () => {
            const model = standing('cooperative', valid('cooperative', { guestWrites: true }));
            model.event(seen(model, 'ready', null));
            const write = op(model, { op: 'call', method: 'act', spec: { k: 'write', path: 'w/a.txt', text: 'v1' } }).callId!;
            model.event(seen(model, 'fileswritten', { paths: ['w/a.txt'] }));
            model.settled(write, { status: 'resolved', value: 'ok' }, 1);
            const remove = op(model, { op: 'call', method: 'act', spec: { k: 'remove', path: 'w/a.txt' } }).callId!;
            model.event(seen(model, 'fileswritten', { paths: ['w/a.txt'] }));
            model.settled(remove, { status: 'resolved', value: 'ok' }, 2);
            const frame = model.begin({ op: 'listWrites' }, 3);
            model.end(frame, { threw: null, warned: 0, state: 'ready', listed: [] });
            // the same bytes again: not announced
            const again = op(model, { op: 'call', method: 'act', spec: { k: 'write', path: 'data.txt', text: 'v2' } }).callId!;
            model.event(seen(model, 'fileswritten', { paths: ['data.txt'] }));
            model.settled(again, { status: 'resolved', value: 'ok' }, 4);
            op(model, { op: 'call', method: 'act', spec: { k: 'write', path: 'data.txt', text: 'v2' } });
            expect(() => model.event(seen(model, 'fileswritten', { paths: ['data.txt'] }))).toThrow(/changes nothing listed/);
        });
        it('a change is applied at its announcement: a listener that terminates leaves it listed and committable', () => {
            const model = standing('cooperative', valid('cooperative', { guestWrites: true }));
            model.event(seen(model, 'ready', null));
            const write = op(model, { op: 'call', method: 'act', spec: { k: 'write', path: 'w/a.txt', text: 'v1' } }).callId!;
            model.event(seen(model, 'fileswritten', { paths: ['w/a.txt'] }));
            op(model, { op: 'terminate', reason: 'from a listener' }, () => {
                model.event(seen(model, 'terminated', { reason: 'from a listener' }, { depth: 2 }));
                model.eventEnd('terminated');
            });
            model.eventEnd('fileswritten');
            model.settled(write, { status: 'rejected', code: 'TERMINATED' }, 1);
            const list = model.begin({ op: 'listWrites' }, 2);
            model.end(list, { threw: null, warned: 0, state: 'terminated', listed: [{ path: 'w/a.txt', change: 'write', text: 'v1' }] });
            op(model, { op: 'commit', paths: ['w/a.txt', 'w/a.txt'], code: false }, () => model.event(seen(model, 'fileschanged', { paths: ['w/a.txt'] }, { depth: 1 })));
            expect(model.files['w/a.txt']).toBe('v1');
        });
    });
});

describe("backlog S72: the view's first overrun is a host line the model allows in a standing strict environment", () => {
    const line = (model: LifecycleModel) => seen(model, 'sandbox-log', { type: 'LOG', level: 'warn', args: ['[Sandbox] the view spent more than 2000 ms on one operation; a second such operation within 5 minutes ends the sandbox.'], source: 'host' });
    it('strict, loading or ready: allowed', () => {
        const model = standing('strict');
        model.event(line(model));
        model.event(seen(model, 'ready', null));
        model.event(line(model));
    });
    it('another mode, or no standing environment: a divergence; and the second overrun\'s termination stays one', () => {
        const cooperative = standing('cooperative');
        expect(() => cooperative.event(line(cooperative))).toThrow(/host line not allowed here/);
        const strict = standing('strict');
        strict.event(seen(strict, 'ready', null));
        op(strict, { op: 'terminate', reason: 'bye' }, () => {
            strict.event(seen(strict, 'terminated', { reason: 'bye' }, { depth: 1 }));
            strict.eventEnd('terminated');
        });
        expect(() => strict.event(line(strict))).toThrow(/host line not allowed here/);
        const ended = standing('strict');
        ended.event(seen(ended, 'ready', null));
        expect(() => ended.event(seen(ended, 'terminated', { reason: 'the view spent more than 2000 ms on one operation twice within 5 minutes' }))).toThrow(/unexpected terminated/);
    });
});

describe('the generator', () => {
    it('mulberry32 is deterministic', () => {
        const a = mulberry32(42);
        const b = mulberry32(42);
        expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    });
    it('the same seed gives the same sequence, in its mode', () => {
        expect(generate(7)).toEqual(generate(7));
        expect(generate(3).mode).toBe('strict');
        expect(generate(4).mode).toBe('cooperative');
        expect(generate(5).mode).toBe('worker');
    });
    it('shrinking keeps a failing command and drops the rest', async () => {
        const sequence = generate(11);
        const culprit = sequence.cmds[Math.floor(sequence.cmds.length / 2)]!;
        const minimal = await shrink(sequence, async (candidate) => candidate.cmds.includes(culprit), 200);
        expect(minimal.cmds).toEqual([culprit]);
    });
});
