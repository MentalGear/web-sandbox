/**
 * Narrowing of the guest's values in the specs. `call()` answers `unknown` (design 02, "`unknown` for guest values"): a
 * spec reads what a guest method returned only after one of these checked its shape, and fails with what arrived when
 * it is another. Not a test file itself.
 */

const shown = (value: unknown) => {
    try {
        return JSON.stringify(value)?.slice(0, 200) ?? String(value);
    } catch {
        return String(value);
    }
};

/** `value` as a number, or a throw that says what arrived. */
export function asNumber(value: unknown): number {
    if (typeof value !== 'number') throw new TypeError(`the guest answered ${shown(value)}, not a number`);
    return value;
}

/** `value` as an array of strings, or a throw that says what arrived. */
export function asStrings(value: unknown): string[] {
    if (!Array.isArray(value)) throw new TypeError(`the guest answered ${shown(value)}, not an array`);
    const strings: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') throw new TypeError(`the guest answered an array holding ${shown(item)}, not only strings`);
        strings.push(item);
    }
    return strings;
}

/** `value` as a record of strings, or a throw that says what arrived. */
export function asStringRecord(value: unknown): Record<string, string> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`the guest answered ${shown(value)}, not an object`);
    const record: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') throw new TypeError(`the guest answered ${key}: ${shown(item)}, not a string`);
        record[key] = item;
    }
    return record;
}

/** `value` as an array of objects that each have a string `label` and a `detail`, or a throw that says what arrived. */
export function asLabelled(value: unknown): { label: string; detail: unknown }[] {
    if (!Array.isArray(value)) throw new TypeError(`the guest answered ${shown(value)}, not an array`);
    const entries: { label: string; detail: unknown }[] = [];
    for (const item of value) {
        if (typeof item !== 'object' || item === null || typeof (item as { label?: unknown }).label !== 'string') throw new TypeError(`the guest answered an entry ${shown(item)} without a label`);
        entries.push({ label: (item as { label: string }).label, detail: (item as { detail?: unknown }).detail });
    }
    return entries;
}
