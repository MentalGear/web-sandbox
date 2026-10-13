import type { CSPDirectives } from "../../csp-directives";

/**
 * Generates a CSP string from a JSON object of directives.
 *
 * An empty array (after blank strings are dropped) means "deny" for EVERY directive and is emitted as
 * 'none' (backlog S16). It is never omitted: an omitted fetch directive falls back to default-src, an
 * omitted base-uri / form-action is unrestricted, and an empty default-src used to replace the
 * built-in 'none' and leave every unset fetch directive unrestricted. Emitting 'none' is the narrowest
 * value a directive can have, so no config can be broader than the same config with that directive
 * left out. To get the default-src fallback, leave the directive out.
 */
export function generateCSP(directives: CSPDirectives): string {

    if (!directives || typeof directives !== 'object') throw new Error("directives must be provided as a key/value pair (object)");
    // ensure there are no duplicate directives
    if (Object.keys(directives).length !== new Set(Object.keys(directives)).size) throw new Error("duplicate directive names found");

    // for security we always at least add `default-src 'none'`
    // even though that contradicts our approach to not transform the input,
    // this is a special case for security. I'd rather have more security in the library than it being "pure"
    // and a fallback where `default-src: 'none'` is added is better than just placing all bets on 1 single upstream config file
    // ideally, this makes it 2x secure defaults backed by 2x tests
    const directivesWithDefault = { 'default-src': [`'none'`], ...directives };

    const cspDirectivesList: string[] = [];

    for (const [name, values] of Object.entries(directivesWithDefault)) {
        cspDirectivesList.push(formatDirective(name, values));
    }

    // place default-src first
    const defaultSrcDirectiveIndex = cspDirectivesList.findIndex(p => p.startsWith('default-src'));
    // cspDirectivesList.unshift(defaultSrcString);
    if (defaultSrcDirectiveIndex > -1) {
        const [defaultSrcDirective] = cspDirectivesList.splice(defaultSrcDirectiveIndex, 1);
        if (defaultSrcDirective) cspDirectivesList.unshift(defaultSrcDirective);
    }

    const cspPolicyString = cspDirectivesList.join('; ') + ';'; // add closing ;
    // const cspPolicyString = `${cspPolicy.join('; ')};`

    return cspPolicyString;
}

/**
 * Formats a single CSP directive.
 * throws error if a wrong input format is used, as we don't want any ambiguousness
 * we want json input to be correct, and shouldn't rely on us cleaning it
 */
function formatDirective(directiveName: string, directiveValues: unknown): string {

    // special case: directives of type boolean. Present with any value means on: it only ever upgrades
    // requests, so emitting it can never widen the policy.
    if (directiveName === "upgrade-insecure-requests") { return `${directiveName}` }

    if (!Array.isArray(directiveValues)) throw new Error("value type must be array");

    const sanitizedValues = [];

    // Filter out duplicates, empty strings, and null/undefined values
    const uniqueDirectiveValues = [...new Set(directiveValues)];
    for (const directiveValue of uniqueDirectiveValues) {
        if (typeof directiveValue !== 'string') throw new Error("value type must be string");

        const trimmed = directiveValue.trim();
        if (trimmed === '') continue;

        sanitizedValues.push(trimmed);
    }

    // empty means deny, for every directive: see generateCSP
    if (sanitizedValues.length === 0) return `${directiveName} 'none'`;

    return `${directiveName} ${sanitizedValues.join(' ')}`;
}
