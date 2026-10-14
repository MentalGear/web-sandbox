import type { CSPDirectives } from "../../csp-directives";
import { defineData } from "../utils";
import { assertWidensOnly } from "./effective-directive";
import { policyTokens, type PolicyTokens } from "./policy-grammar";

/**
 * 'unsafe-eval' and 'wasm-unsafe-eval' belong to scriptUnsafe (review A5). scriptUnsafe is the one switch for
 * running strings as code in the guest, and the one that warns (S4); the host adds 'unsafe-eval' to the
 * guest's script-src itself when it is on (and strict mode to the view's). A configured eval keyword would be
 * the same grant without the switch or its warning, so it is removed from every directive of the config:
 * with a warning once per directive while scriptUnsafe is off, silently while it is on (the host's own
 * 'unsafe-eval' covers WebAssembly too).
 *
 * Takes only the policy grammar's output (PolicyTokens, policy-grammar.ts), so every element it reads is one token.
 */
const EVAL_KEYWORDS = ["'unsafe-eval'", "'wasm-unsafe-eval'"];

const isEvalKeyword = (token: unknown) => typeof token === 'string' && EVAL_KEYWORDS.includes(token.toLowerCase());

/** Returns a copy of `directives` without eval keywords; warns once per directive per instance (`warned`) unless `scriptUnsafe`. */
export function dropEvalSources(directives: PolicyTokens, scriptUnsafe: boolean, warned: Set<string>): PolicyTokens {
    policyTokens(directives, 'dropEvalSources');
    const output: Record<string, unknown> = { ...directives };
    for (const [name, values] of Object.entries(directives)) {
        if (!Array.isArray(values) || !values.some(isEvalKeyword)) continue;
        defineData(output, name, values.filter(token => !isEvalKeyword(token))); // defined, never assigned (F4)
        if (scriptUnsafe || warned.has(name)) continue;
        warned.add(name);
        console.warn(`[Sandbox] 'unsafe-eval' and 'wasm-unsafe-eval' are not allowed in "connectionsAllowed.${name}" and were dropped: evaluating strings as code is enabled only by scriptUnsafe, which warns about what it costs.`);
    }
    return policyTokens(assertWidensOnly(directives, output as CSPDirectives, [], 'dropEvalSources'), 'dropEvalSources');
}
