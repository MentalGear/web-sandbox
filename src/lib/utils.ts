// Keys a merge never writes: through [[Set]], "__proto__" replaces the prototype of the object written to, and
// "constructor" / "prototype" name the machinery of prototypes rather than data (review A7). A config parsed
// from JSON can carry "__proto__" as an own key.
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Deeply merges two objects.
 * Nested objects are merged recursively; arrays and primitives are overwritten.
 * Only the source's own enumerable keys are read, each once, and the keys in UNSAFE_KEYS are skipped, so the
 * result is plain data whose prototypes are the target's.
 */
export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
    const output = { ...target };
    for (const key of Object.keys(source)) {
        if (UNSAFE_KEYS.includes(key)) continue;
        const sourceValue = (source as Record<string, unknown>)[key];
        const targetValue = Object.hasOwn(target, key) ? (target as Record<string, unknown>)[key] : undefined;

        if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
            (output as any)[key] = deepMerge((targetValue as any) || {}, sourceValue);
        } else if (sourceValue !== undefined) {
            (output as any)[key] = sourceValue;
        }
    }
    return output as T;
}
