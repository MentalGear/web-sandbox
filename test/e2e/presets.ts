import { PRESETS, type Preset, type PresetId, type PresetRules } from '@src/lib/presets';

/**
 * The one way a spec reaches a preset (backlog T4): `fromPreset('id')`, with the id as a string literal, so
 * the coverage test (test/unit/presets.test.ts) can find every preset a spec runs by scanning the spec files.
 * Specs never import PRESETS themselves.
 */
export interface PresetForSpec {
    readonly id: PresetId;
    readonly run: Preset['run'];
    /** The preset's rules, a fresh copy: pass to sandbox.mount(), or spread and extend for a positive control. */
    readonly rules: PresetRules;
    readonly code: string;
    /** `code` first (under the name 'code'), then each variant, in order. */
    readonly payloads: [string, string][];
    readonly files: Record<string, string>;
    /**
     * `payload` (default: `code`) with every occurrence of the preset's target replaced by `target`. Throws when
     * the preset has no target or the payload does not contain it, so a preset edit cannot silently leave a
     * spec aiming at the playground's placeholder instead of the listener.
     */
    aimedAt(target: string, payload?: string): string;
}

export function fromPreset(id: PresetId): PresetForSpec {
    const preset: Preset = PRESETS[id];
    const payloads: [string, string][] = [['code', preset.code], ...Object.entries(preset.variants ?? {})];
    return Object.freeze({
        id,
        run: preset.run,
        rules: structuredClone(preset.rules),
        code: preset.code,
        payloads,
        files: { ...preset.files },
        aimedAt(target: string, payload = preset.code) {
            const placeholder = preset.target;
            if (!placeholder) throw new Error(`preset "${id}" has no target to aim`);
            if (!payload.includes(placeholder)) throw new Error(`preset "${id}": the payload does not contain its target ${placeholder}`);
            return payload.replaceAll(placeholder, target);
        },
    });
}
