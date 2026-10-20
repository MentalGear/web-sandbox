/**
 * Filtering of the capabilities an embedder lists: the allowed ones are kept, every other one dropped with a warning.
 */
import { UNSAFE_CAPABILITIES } from "../csp-directives";
import { shown } from "./csp/origins";

/**
 * Keeps only the requested capabilities that appear in `allowed`, warning about each one dropped (through `warn`; the
 * config schema passes the element's once-per-message warning).
 * Returns undefined when nothing was requested, so a config merge keeps its default. A value that is not a list is
 * dropped as a whole, with a warning, and the default stays (review round 1, R1-3: `capabilities: 5` or `{}` threw
 * here, and the whole config was refused).
 */
export function filterCapabilities<T extends string>(
    requested: unknown,
    allowed: readonly T[],
    field: string,
    warn: (message: string) => void = (message) => console.warn(message)
): T[] | undefined {

    if (requested === undefined || requested === null) return undefined;
    if (!Array.isArray(requested)) {
        warn(`[Sandbox] "${field}" must be a list; ${shown(requested)} was dropped.`);
        return undefined;
    }

    const kept: T[] = [];
    for (const capability of requested as unknown[]) {
        if ((allowed as readonly unknown[]).includes(capability)) {
            kept.push(capability as T);
            continue;
        }

        const isUnsafe = (UNSAFE_CAPABILITIES as readonly unknown[]).includes(capability);
        const hint = isUnsafe ? ` It reaches outside the sandbox; opt in via "unsafeCapabilities" if you really need it.` : '';
        warn(`[Sandbox] ${shown(capability)} is not allowed in "${field}" and was dropped.${hint}`);
    }

    return kept;
}
