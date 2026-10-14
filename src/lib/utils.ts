// Every key a merge writes becomes an own data property, defined, never assigned (review A7, follow-up audit
// 2026-10-14). Assignment ([[Set]]) is what made a key dangerous: `output['__proto__'] = value` replaces the
// prototype of the object written to, and a config parsed from JSON can carry "__proto__" as an own key. A
// definition has no such meaning for any key, so no key needs to be singled out: "__proto__", "constructor" and
// "prototype" are kept as the plain data they are, and change no prototype at any depth. (The earlier fix skipped
// a list of keys, which had to be right about every key that is special to [[Set]].)
const defineData = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });

const isPlainRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Deeply merges two objects.
 * Nested objects are merged recursively; arrays and primitives are overwritten.
 * Only the source's own enumerable keys are read, each once, and every key is written as an own data property,
 * so the result is plain data whose prototypes are the target's.
 */
export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
    const output = { ...target };
    for (const key of Object.keys(source)) {
        const sourceValue = (source as Record<string, unknown>)[key];
        const targetValue = Object.hasOwn(target, key) ? (target as Record<string, unknown>)[key] : undefined;

        if (isPlainRecord(sourceValue)) {
            defineData(output, key, deepMerge((targetValue as object) || {}, sourceValue));
        } else if (sourceValue !== undefined) {
            defineData(output, key, sourceValue);
        }
    }
    return output as T;
}
