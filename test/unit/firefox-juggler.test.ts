// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { JUGGLER_CHANNEL_SHARED, JUGGLER_CHANNEL_UNIQUE, withUniqueChannel } from '../e2e/firefox-juggler';

/**
 * The e2e runs' global setup gives the installed Firefox's Juggler a channel name per channel (S86,
 * test/e2e/firefox-juggler.ts): the line Playwright 1.64.0 ships, applied to 1.58.1's build. The rewrite itself is
 * pinned here; the setup re-reads the browser's file after writing it and throws if the line is not there.
 */
const MAIN = (line: string) => `const helper = new Helper();\n  data.frameTree = new FrameTree(browsingContext);\n  data.channel = ${line}\n  data.pageAgent = new PageAgent(data.channel, data.frameTree);\n`;

describe("Firefox's Juggler channel name (S86)", () => {
    it('a channel named per process gets the per-channel name, and nothing else changes', () => {
        const fixed = withUniqueChannel(MAIN(JUGGLER_CHANNEL_SHARED));
        expect(fixed).toBe(MAIN(JUGGLER_CHANNEL_UNIQUE));
    });

    it('a build that already names each channel is left as it is (Playwright 1.64.0 and later)', () => {
        const source = MAIN(JUGGLER_CHANNEL_UNIQUE);
        expect(withUniqueChannel(source)).toBe(source);
    });

    it('a source with neither form is refused, not left unfixed in silence', () => {
        expect(() => withUniqueChannel(MAIN(`new SimpleChannel('', 'tab-' + id);`))).toThrow(/neither way this fix knows/);
        expect(() => withUniqueChannel(MAIN(JUGGLER_CHANNEL_SHARED) + MAIN(JUGGLER_CHANNEL_SHARED))).toThrow(/neither way this fix knows/);
    });
});
