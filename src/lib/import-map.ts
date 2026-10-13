import { VIRTUAL_ROOT } from './module-specifiers';

/**
 * The guest's own import maps (ADR-004, PR3). Host-only.
 *
 * When JavaScript files are registered, the bootstrap registers the document's one import map
 * (inSandboxImportMap, in-sandbox-files.ts). Firefox honours only the first import map of a document,
 * Chromium and WebKit merge later ones, so a guest `<script type="importmap">` left in the markup would
 * be ignored in one engine and merged in the others. Instead, the host takes the guest's inline maps
 * out of the markup (markup-references.ts) and merges them here; the bootstrap adds our entries to the
 * result. The outcome is one map, the same in every engine.
 *
 * Rules:
 *   - each map must be valid JSON in the shape the import maps standard requires: an object whose
 *     `imports`, `scopes` (an object of objects) and `integrity`, when present, are objects. Anything
 *     else is left out whole, with a warning, as a browser would reject it;
 *   - several maps merge in document order; on a conflict the earlier entry stays, as the standard's
 *     merge does for a later map;
 *   - ours win: every guest entry whose key could match a https://vfs.invalid/ URL is dropped, with a
 *     warning: keys inside that origin, and prefix keys (ending in "/") that the origin starts with,
 *     such as "https://". The virtual origin names registered files, and only the host maps it.
 *   - values and everything else are the guest's: the browser validates them, and the policy decides
 *     what they may load. The result is the guest's own data, handed back to its own document.
 */

export interface GuestImportMap {
    imports?: Record<string, unknown>;
    scopes?: Record<string, Record<string, unknown>>;
    integrity?: Record<string, unknown>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

// The key as the browser normalises a specifier key. A relative key cannot be resolved against the
// guest's about:blank base (frame-documents.ts, S15), so it stays as written, as it does in the guest.
function normaliseKey(key: string): string {
    if (key.startsWith('/') || key.startsWith('./') || key.startsWith('../')) return key;
    try {
        return new URL(key).href;
    } catch {
        return key;
    }
}

/** Whether a guest specifier key could match a URL in the virtual origin, which only the host maps. */
export function isVirtualKey(key: string): boolean {
    const normalised = normaliseKey(key);
    return normalised.startsWith(VIRTUAL_ROOT) || (normalised.endsWith('/') && VIRTUAL_ROOT.startsWith(normalised));
}

// A null-prototype object, so a "__proto__" key is an ordinary key and never a prototype.
const dictionary = () => Object.create(null) as Record<string, unknown>;

// Adds `from`'s entries that `into` does not have yet; returns the virtual keys it dropped.
function mergeSpecifierMap(into: Record<string, unknown>, from: Record<string, unknown>, dropVirtual: boolean, dropped: Set<string>) {
    for (const [key, value] of Object.entries(from)) {
        if (dropVirtual && isVirtualKey(key)) {
            dropped.add(key);
            continue;
        }
        if (!Object.hasOwn(into, key)) into[key] = value;
    }
}

/**
 * Merges the texts of the guest's inline import maps, in document order, into one map, or returns
 * null when none is valid. Calls `warn` once per map left out and once when virtual keys were dropped.
 * Returns the map as JSON, ready to travel in the bootstrap literal.
 */
export function mergeGuestImportMaps(texts: readonly string[], warn: (message: string) => void): string | null {
    const imports = dictionary();
    const scopes = dictionary() as Record<string, Record<string, unknown>>;
    const integrity = dictionary();
    const dropped = new Set<string>();
    let valid = 0;

    texts.forEach((text, index) => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = undefined;
        }
        const ok = isPlainObject(parsed)
            && (parsed.imports === undefined || isPlainObject(parsed.imports))
            && (parsed.integrity === undefined || isPlainObject(parsed.integrity))
            && (parsed.scopes === undefined || (isPlainObject(parsed.scopes) && Object.values(parsed.scopes).every(isPlainObject)));
        if (!ok) {
            warn(`[Sandbox] the guest's import map #${index + 1} is not a valid import map (JSON object with object "imports", "scopes" and "integrity"), so it was left out.`);
            return;
        }
        valid++;
        const map = parsed as GuestImportMap;
        if (map.imports) mergeSpecifierMap(imports, map.imports, true, dropped);
        if (map.integrity) mergeSpecifierMap(integrity, map.integrity, false, dropped);
        for (const [scope, entries] of Object.entries(map.scopes ?? {})) {
            if (!Object.hasOwn(scopes, scope)) scopes[scope] = dictionary();
            mergeSpecifierMap(scopes[scope]!, entries, true, dropped);
        }
    });

    if (dropped.size > 0) {
        warn(`[Sandbox] the guest's import map entries for ${[...dropped].slice(0, 5).map(key => JSON.stringify(key)).join(', ')}${dropped.size > 5 ? ', …' : ''} were left out: keys that can match ${VIRTUAL_ROOT} name registered files, and only the sandbox maps them.`);
    }
    if (valid === 0) return null;

    const merged: GuestImportMap = { imports };
    if (Object.keys(scopes).length > 0) merged.scopes = scopes;
    if (Object.keys(integrity).length > 0) merged.integrity = integrity;
    return JSON.stringify(merged);
}
