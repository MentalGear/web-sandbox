/**
 * Deeply merges two objects. 
 * Nested objects are merged recursively; arrays and primitives are overwritten.
 */
export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
    const output = { ...target };
    for (const key in source) {
        const sourceValue = source[key];
        const targetValue = target[key as keyof T];

        if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
            (output as any)[key] = deepMerge((targetValue as any) || {}, sourceValue);
        } else if (sourceValue !== undefined) {
            (output as any)[key] = sourceValue;
        }
    }
    return output as T;
}