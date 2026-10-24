import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_CREDENTIALLESS, FRAME_REFERRER_POLICY, setWrapperFrameIsolation } from '@src/lib/frame-documents';
import { prepareBridgeFrame } from '@src/lib/bridge-frame';

/**
 * Every frame the library makes for a sandbox is isolated the same way (BD3:NEW-5, class A: the host page's context a
 * sandbox document inherits, `INHERITED_CONTEXT.cookies`). `setWrapperFrameIsolation` (frame-documents.ts) is the one
 * place that sets the referrer policy and `credentialless`; the docs say "every wrapper frame is credentialless", and a
 * frame made some other way (the fetch bridge's was) makes the sentence false without any test noticing.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sources = (directory: string): string[] => readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sources(file) : /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [file] : [];
});

/** Frames made in `src/` that are not a sandbox's, with why: the helper does not apply to them. */
const NOT_A_SANDBOX_FRAME: Readonly<Record<string, string>> = {
    'src/lib/host-csp.ts': "the frame that reads the host page's policy: an empty document with no guest and no request of the sandbox's",
    'src/lib/presets.ts': "the playground's preset: guest code, run inside a sandbox, makes the frame",
};

describe('every frame of a sandbox goes through setWrapperFrameIsolation', () => {
    it('each file of src/ that makes an iframe calls the helper for each, but the frames that are not a sandbox\'s', () => {
        const made: Record<string, { frames: number; isolated: number }> = {};
        for (const file of sources('src')) {
            const text = readFileSync(path.join(ROOT, file), 'utf8');
            const frames = [...text.matchAll(/createElement\(\s*(['"])iframe\1\s*\)/g)].length;
            if (frames > 0) made[file] = { frames, isolated: [...text.matchAll(/\bsetWrapperFrameIsolation\(/g)].length };
        }
        const sandbox = Object.entries(made).filter(([file]) => !(file in NOT_A_SANDBOX_FRAME));
        // the element's two wrapper frames and the bridge's frame: the scan sees them (a positive control)
        expect(sandbox.map(([file, counts]) => [file, counts.frames])).toEqual([['src/host.ts', 2], ['src/lib/bridge-frame.ts', 1]]);
        for (const [file, counts] of sandbox) expect(counts.isolated, file).toBeGreaterThanOrEqual(counts.frames);
        for (const file of Object.keys(NOT_A_SANDBOX_FRAME)) expect(Object.keys(made), `${file} still makes a frame, or leaves the list`).toContain(file);
    });

    it('the helper sets the referrer policy and the attribute, and the bridge\'s frame has both', () => {
        const plain = document.createElement('iframe');
        setWrapperFrameIsolation(plain);
        expect([plain.getAttribute('referrerpolicy'), plain.getAttribute(FRAME_CREDENTIALLESS)]).toEqual([FRAME_REFERRER_POLICY, '']);
        const bridge = prepareBridgeFrame([]);
        expect([bridge.getAttribute('referrerpolicy'), bridge.getAttribute(FRAME_CREDENTIALLESS)]).toEqual([FRAME_REFERRER_POLICY, '']);
        expect(bridge.getAttribute('sandbox')).toBe('allow-scripts');
    });
});
