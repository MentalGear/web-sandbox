import type { CSPDirectives } from "../../csp-directives";
import { defineData } from "../utils";
import { addEvalSource, directiveOf as own } from "./effective-directive";

/**
 * The policy of the strict-mode view (ADR-005), which its worker inherits exactly.
 *
 * The embedder's config goes through the same pipeline as every guest policy (drop-meta-ignored, the
 * grammar, drop-eval, then the passed-through subset (strictPassedThrough), file sources without scripts,
 * drop-self), and this is the last step. It is built from an allowlist: only
 * the directives in PASSED_THROUGH come from the config; every directive that decides what can run or
 * navigate is fixed here, and anything else the config names is not emitted at all. So no configuration can
 * add a script source, a worker source, a frame, a plugin, a base URL or a form target to the view:
 *
 *   default-src <config, 'none' by default>
 *   script-src 'sha256-<bootstrap>' ['unsafe-eval' with scriptUnsafe]   the bootstrap only (and eval in the worker)
 *   script-src-attr 'none'                                             no handler attribute, no javascript: URL
 *   style-src <config>                                                 rendered <style> and style="" ('unsafe-inline' by default)
 *   base-uri 'none'; form-action 'none'                                no <base>, no form submission anywhere
 *   worker-src blob:                                                   the one worker the bootstrap spawns
 *   frame-src 'none'; object-src 'none'                                nothing fetched into a frame or plugin
 *   upgrade-insecure-requests
 *   connect-src, img-src, font-src, media-src, manifest-src, prefetch-src <config>
 *
 * One exception inside a passed-through directive (broad review 2026-10-14, ST1): images never load from data:. A
 * user can open an image in a new tab, where a data: SVG is a document that runs its script outside the sandbox, so
 * `data:` is dropped from the directive that governs images (img-src, else default-src, from which img-src is then
 * made), with one warning (strictPolicyOverrides). The renderer keeps no data: URL in markup either; this covers CSS.
 */

/** Directives taken from the config as they are. Everything else is fixed or dropped. */
export const STRICT_PASSED_THROUGH = ['default-src', 'style-src', 'connect-src', 'img-src', 'font-src', 'media-src', 'manifest-src', 'prefetch-src'] as const;

/** Directives strict mode sets itself, whatever the config says. */
export const STRICT_FIXED = ['script-src', 'script-src-attr', 'base-uri', 'form-action', 'worker-src', 'frame-src', 'object-src'] as const;

/**
 * Only the directives the view takes from the config (STRICT_PASSED_THROUGH). The host keeps this subset before
 * it adds file sources, so every step that asks which directive governs a load (effective-directive.ts) sees
 * the directives the view policy will hold: a configured style-src-elem, which the view never emits, cannot
 * take the `blob:` a registered stylesheet needs away from the view's style-src.
 */
export function strictPassedThrough(configured: CSPDirectives): CSPDirectives {
    const source = configured;
    const kept: Record<string, unknown> = {};
    for (const name of STRICT_PASSED_THROUGH) {
        if (own(source, name) !== undefined) defineData(kept, name, own(source, name));
    }
    return kept as CSPDirectives;
}

const isData = (token: unknown) => typeof token === 'string' && token.toLowerCase() === 'data:';

/**
 * The sources of the directive that governs images in `source` without `data:`, and that directive's name, or null
 * when it holds no `data:` (or nothing governs images: then they load from nowhere).
 */
function imageSourcesWithoutData(source: CSPDirectives): { from: 'img-src' | 'default-src'; sources: unknown[] } | null {
    const from = own(source, 'img-src') !== undefined ? 'img-src' : own(source, 'default-src') !== undefined ? 'default-src' : null;
    if (from === null) return null;
    const values = own(source, from);
    if (!Array.isArray(values)) return null; // a bad value generateCSP rejects
    const tokens: unknown[] = [];
    for (const value of values) {
        if (typeof value === 'string') tokens.push(...value.trim().split(/\s+/).filter(token => token !== ''));
        else tokens.push(value);
    }
    return tokens.some(isData) ? { from, sources: tokens.filter(token => !isData(token)) } : null;
}

/** The view policy's directives, in emission order (generateCSP keeps it, with default-src first). */
export function strictViewDirectives(configured: CSPDirectives, bootstrapHash: string, scriptUnsafe: boolean): CSPDirectives {
    const source = configured;
    const directives: Record<string, unknown> = {};
    if (own(source, 'default-src') !== undefined) defineData(directives, 'default-src', own(source, 'default-src'));
    directives['script-src'] = [bootstrapHash];
    directives['script-src-attr'] = [];
    if (own(source, 'style-src') !== undefined) defineData(directives, 'style-src', own(source, 'style-src'));
    directives['base-uri'] = [];
    directives['form-action'] = [];
    directives['worker-src'] = ['blob:'];
    directives['frame-src'] = [];
    directives['object-src'] = [];
    directives['upgrade-insecure-requests'] = true;
    for (const name of STRICT_PASSED_THROUGH) {
        if (name === 'default-src' || name === 'style-src') continue;
        if (own(source, name) !== undefined) defineData(directives, name, own(source, name));
    }
    // no image from data: (ST1): the governing directive's sources without it, as img-src
    const images = imageSourcesWithoutData(source);
    if (images) defineData(directives, 'img-src', images.sources);
    // 'unsafe-eval' only with scriptUnsafe, through the one helper that writes it (effective-directive.ts, F5)
    return scriptUnsafe ? addEvalSource(directives as CSPDirectives) : directives as CSPDirectives;
}

/**
 * What a config asks for that strict mode will not do, one message per directive: a fixed directive set to
 * something other than the shipping default (`defaults`), or a directive strict mode does not emit. The
 * caller warns once per message per instance.
 */
export function strictPolicyOverrides(configured: CSPDirectives, defaults: CSPDirectives): string[] {
    const messages: string[] = [];
    const source = configured as Record<string, unknown>;
    const base = defaults as Record<string, unknown>;
    for (const name of Object.keys(source)) {
        if (name === 'upgrade-insecure-requests' || (STRICT_PASSED_THROUGH as readonly string[]).includes(name)) continue;
        if ((STRICT_FIXED as readonly string[]).includes(name)) {
            if (JSON.stringify(source[name]) === JSON.stringify(base[name])) continue;
            messages.push(`[Sandbox] "connectionsAllowed.${name}" is fixed in strict mode and was replaced: the view runs only the library's bootstrap (admitted by its hash), spawns only its own worker, and has no frames, plugins, base URL or form targets (see docs/ADR-005).`);
            continue;
        }
        messages.push(`[Sandbox] "connectionsAllowed.${name}" is not used in strict mode and was dropped: the view policy takes only ${STRICT_PASSED_THROUGH.join(', ')} from the config (see docs/ADR-005).`);
    }
    const images = imageSourcesWithoutData(configured);
    if (images) messages.push(`[Sandbox] "connectionsAllowed.${images.from}" admits data:, which strict mode drops for images (img-src): a user can open an image in a new tab, where a data: document would run outside the sandbox (see docs/ADR-005).`);
    return messages;
}
