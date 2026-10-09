import { UNSAFE_CAPABILITIES } from "@src/csp-directives";

/**
 * Keeps only the requested capabilities that appear in `allowed`, warning about each one dropped.
 * Returns undefined when nothing was requested, so a config merge keeps its default.
 */
export function filterCapabilities<T extends string>(
    requested: readonly string[] | undefined,
    allowed: readonly T[],
    field: string
): T[] | undefined {

    if (!requested) return undefined;

    const kept: T[] = [];
    for (const capability of requested) {
        if ((allowed as readonly string[]).includes(capability)) {
            kept.push(capability as T);
            continue;
        }

        const isUnsafe = (UNSAFE_CAPABILITIES as readonly string[]).includes(capability);
        const hint = isUnsafe ? ` It reaches outside the sandbox; opt in via "unsafeCapabilities" if you really need it.` : '';
        console.warn(`[Sandbox] "${capability}" is not allowed in "${field}" and was dropped.${hint}`);
    }

    return kept;
}
