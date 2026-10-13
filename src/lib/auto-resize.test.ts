import { describe, it, expect } from 'vitest';
import { AUTO_RESIZE_MAX_HEIGHT, AUTO_RESIZE_MAX_UPDATES_PER_SECOND, startAutoResize, toResizeHeight, type ResizeScheduler } from './auto-resize';

// A clock with frames every 16 ms and timers, advanced by hand.
function fakeScheduler() {
    let now = 0;
    let nextHandle = 1;
    const frames = new Map<number, () => void>();
    const timers = new Map<number, { at: number; callback: () => void }>();
    const scheduler: ResizeScheduler = {
        now: () => now,
        requestFrame: (callback) => { const handle = nextHandle++; frames.set(handle, callback); return handle; },
        cancelFrame: (handle) => { frames.delete(handle); },
        setTimer: (callback, ms) => { const handle = nextHandle++; timers.set(handle, { at: now + ms, callback }); return handle as any; },
        clearTimer: (handle) => { timers.delete(handle as any); },
    };
    // Runs the frame boundary at the current time: due timers first, then every frame callback requested so far.
    const frame = () => {
        for (const [handle, timer] of [...timers]) {
            if (timer.at > now) continue;
            timers.delete(handle);
            timer.callback();
        }
        const due = [...frames.values()];
        frames.clear();
        for (const callback of due) callback();
    };
    const advance = (ms: number, onFrame?: (index: number) => void) => {
        const end = now + ms;
        let index = 0;
        while (now + 16 <= end) {
            now += 16;
            onFrame?.(index++);
            frame();
        }
        now = end;
    };
    return { scheduler, frame, advance, pending: () => frames.size + timers.size };
}

describe('toResizeHeight (B6): only a finite, non-negative number is a report', () => {
    it('drops anything else, rounds fractions up and clamps to the maximum', () => {
        for (const height of [-1, -0.5, NaN, Infinity, -Infinity, '100', null, undefined, {}, [100], true, 10n]) {
            expect(toResizeHeight({ type: 'RESIZE', height }), String(height)).toBeNull();
        }
        for (const frame of [null, undefined, 'RESIZE', 42, {}]) expect(toResizeHeight(frame)).toBeNull();
        expect(toResizeHeight({ height: 0 })).toBe(0);
        expect(toResizeHeight({ height: -0 })).toBe(0);
        expect(toResizeHeight({ height: 12.01 })).toBe(13);
        expect(toResizeHeight({ height: AUTO_RESIZE_MAX_HEIGHT })).toBe(AUTO_RESIZE_MAX_HEIGHT);
        expect(toResizeHeight({ height: AUTO_RESIZE_MAX_HEIGHT + 0.5 })).toBe(AUTO_RESIZE_MAX_HEIGHT);
        expect(toResizeHeight({ height: Number.MAX_VALUE })).toBe(AUTO_RESIZE_MAX_HEIGHT);
    });

    it('pins the limits', () => {
        expect(AUTO_RESIZE_MAX_HEIGHT).toBe(100000);
        expect(AUTO_RESIZE_MAX_UPDATES_PER_SECOND).toBe(30);
    });
});

describe('startAutoResize (B6)', () => {
    it('writes only at a frame, once per frame, with the newest report', () => {
        const clock = fakeScheduler();
        const applied: number[] = [];
        const resizer = startAutoResize(height => applied.push(height), clock.scheduler);

        resizer.report({ height: 100 });
        resizer.report({ height: 200 });
        resizer.report({ height: 300 });
        expect(applied).toEqual([]);
        clock.advance(16);
        expect(applied).toEqual([300]);
    });

    it('never writes the same height twice in a row, and ignores malformed reports', () => {
        const clock = fakeScheduler();
        const applied: number[] = [];
        const resizer = startAutoResize(height => applied.push(height), clock.scheduler);

        resizer.report({ height: 100 });
        clock.advance(100);
        resizer.report({ height: 100 });
        resizer.report({ height: NaN });
        resizer.report({ height: -5 });
        clock.advance(100);
        expect(applied).toEqual([100]);
    });

    it('a report every frame for ten seconds costs at most 30 writes per second, and the last report is written', () => {
        const clock = fakeScheduler();
        const applied: { height: number; at: number }[] = [];
        const resizer = startAutoResize(height => applied.push({ height, at: clock.scheduler.now() }), clock.scheduler);

        // an oscillating guest: a different height before every frame, and a burst of 50 in some frames
        clock.advance(10000, index => {
            const bursts = index % 7 === 0 ? 50 : 1;
            for (let i = 0; i < bursts; i++) resizer.report({ height: index % 2 ? 100 + i : 5000 + i });
        });
        resizer.report({ height: 777 });
        clock.advance(1000);

        expect(applied.length).toBeGreaterThan(100); // it did keep up, within the cap
        expect(applied.length).toBeLessThanOrEqual(10 * AUTO_RESIZE_MAX_UPDATES_PER_SECOND + 1);
        for (let i = 1; i < applied.length; i++) {
            expect(applied[i]!.at - applied[i - 1]!.at).toBeGreaterThanOrEqual(1000 / AUTO_RESIZE_MAX_UPDATES_PER_SECOND);
        }
        expect(applied.at(-1)!.height).toBe(777);
    });

    it('stop() cancels what is scheduled and ignores later reports', () => {
        const clock = fakeScheduler();
        const applied: number[] = [];
        const resizer = startAutoResize(height => applied.push(height), clock.scheduler);

        resizer.report({ height: 100 });
        clock.advance(16);
        resizer.report({ height: 200 }); // waits for the rate cap: a timer
        expect(clock.pending()).toBe(1);
        resizer.stop();
        expect(clock.pending()).toBe(0);
        resizer.report({ height: 300 });
        resizer.stop();
        clock.advance(1000);
        expect(applied).toEqual([100]);
    });
});
