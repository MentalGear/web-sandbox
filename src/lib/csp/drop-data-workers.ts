import type { CSPDirectives } from "../../csp-directives";
import { defineData } from "../utils";
import { assertWidensOnly, directiveOf, effectiveDirective } from "./effective-directive";

/**
 * Why a guest worker never loads from a data: URL (broad review 2026-10-14, PD1).
 *
 * WebKit runs a SharedWorker made from a data: URL outside the guest's policy: from it, a fetch, a WebSocket and
 * importScripts() reached a listener the guest policy blocks, and no violation was reported (measured in Playwright's
 * WebKit 26). The library never needs data: for a worker (worker mode and strict mode start theirs from a blob: URL),
 * so it is not admitted for worker loads at all: the default worker-src is `blob:` alone, and this step removes data:
 * from whatever governs worker loads in the configured policy (effective-directive.ts: worker-src, else child-src,
 * else script-src, else default-src), with one warning per directive and instance, like the 'self' drop.
 *
 * When worker-src itself governs, data: is removed from it. When another directive governs (child-src, which also
 * governs frames; script-src, which also governs scripts; default-src), that directive is left as it is and
 * worker-src is created from its sources without data:, so only worker loads change.
 */
const DATA = 'data:';

const isData = (token: unknown) => typeof token === 'string' && token.toLowerCase() === DATA; // schemes are case-insensitive

/** Returns a copy of `directives` whose worker loads admit no data: URL; warns once per directive per instance (`warned`). */
export function dropDataWorkerSources(directives: CSPDirectives, warned: Set<string>): CSPDirectives {
    const output: Record<string, unknown> = { ...directives };
    const governing = effectiveDirective(directives, 'worker-src');
    const values = governing === null ? undefined : directiveOf(directives, governing);
    // runs after the policy grammar (policy-grammar.ts): one token per element; a non-list is generateCSP's to refuse
    if (!Array.isArray(values) || !values.some(isData)) return output as CSPDirectives;

    defineData(output, 'worker-src', values.filter(token => !isData(token))); // defined, never assigned (F4)
    if (!warned.has(governing!)) {
        warned.add(governing!);
        const where = governing === 'worker-src' ? '' : ` (it governs worker loads here, so the guest's worker-src was made from it without data:)`;
        console.warn(`[Sandbox] "data:" is not allowed for workers and was dropped from what "connectionsAllowed.${governing}" admits for them${where}: WebKit runs a data: SharedWorker outside the guest's policy. Workers load from blob: URLs.`);
    }
    return assertWidensOnly(directives, output as CSPDirectives, [], 'dropDataWorkerSources');
}
