import { describe, it, expect, vi, afterEach } from 'vitest';
import { filterCapabilities } from './capabilities';
import { ALLOWED_CAPABILITIES, SAFE_CAPABILITIES, UNSAFE_CAPABILITIES } from '@src/csp-directives';

describe('capability tiers', () => {
    it('keeps safe and unsafe capabilities disjoint', () => {
        const overlap = SAFE_CAPABILITIES.filter(c => (UNSAFE_CAPABILITIES as readonly string[]).includes(c));
        expect(overlap).toEqual([]);
    });

    it.each(['allow-popups', 'allow-modals', 'allow-downloads', 'allow-presentation', 'fullscreen'])('treats %s as unsafe', (capability) => {
        expect(SAFE_CAPABILITIES as readonly string[]).not.toContain(capability);
        expect(UNSAFE_CAPABILITIES as readonly string[]).toContain(capability);
    });

    it('keeps permissions (fullscreen) out of the sandbox attribute values', () => {
        expect(ALLOWED_CAPABILITIES as readonly string[]).not.toContain('fullscreen');
    });
});

describe('filterCapabilities', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('returns undefined when nothing was requested, so the default applies', () => {
        expect(filterCapabilities(undefined, SAFE_CAPABILITIES, 'capabilities')).toBeUndefined();
    });

    it('keeps allowed values and drops the rest with a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const kept = filterCapabilities(['allow-scripts', 'allow-same-origin', 'allow-popups'], SAFE_CAPABILITIES, 'capabilities');

        expect(kept).toEqual(['allow-scripts']);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[1]?.[0]).toContain('unsafeCapabilities');
    });
});
