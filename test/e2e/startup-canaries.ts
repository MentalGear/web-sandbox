import { GATE_CANARIES } from '@src/lib/startup-gates';
import { CANARY_DOMAIN, POLICY_CANARY_VALUES } from '@src/lib/policy-check';
import { servedFilePolicy } from './served-file';

/**
 * The browser's console lines of sealed mode's start-up gates (design 03, "The start-up gates"; src/lib/startup-gates.ts):
 * each gate that provokes the file's policy has its canary refused, and every engine logs that refusal to the developer
 * console, which no page script can read or silence. A spec that holds a clean sealed start to a quiet console takes
 * these lines out, and only these: each is recognised by what only a canary of the library's names (the gate's fixed
 * image and base URL, a connection to a `blob:` URL of the view's own, a code-from-string or inline style refusal under
 * the served file's own policy), as each engine words it; and the policy check's canaries (src/lib/policy-check.ts), each
 * by the reserved host it names, its `data:` worker, and its admitted font's family.
 */
const IMAGE = GATE_CANARIES.gateImage.slice(0, 40); // Firefox cuts the URL in its line
const policySource = (directive: string) => {
    const found = new RegExp(`${directive} ([^;]*)`).exec(servedFilePolicy())![1]!;
    return found.split(' ')[0]!; // the directive's first source, a hash of the file's own
};

export function isStartupCanaryLine(line: string): boolean {
    // the policy check's refused canaries (policy-check.ts): each names its host on the reserved name, or is the data: worker
    if (line.includes(`.${CANARY_DOMAIN}`)) return true;
    // its admitted font, the first bytes of a font file from a blob: URL, which Firefox's sanitizer rejects, by its family
    if (line.includes(`font-family: "${POLICY_CANARY_VALUES.family}"`)) return true;
    if (line.includes(POLICY_CANARY_VALUES.dataWorker.slice(0, 20)) || (/worker/i.test(line) && /\bdata:/.test(line) && line.includes(policySource('script-src')))) return true;
    if (line.includes(GATE_CANARIES.gateBase) && /base/i.test(line)) return true;
    if (/document's base URI to '' violates .*base-uri 'none'/.test(line)) return true; // Chromium, as the canary's <base> leaves
    if (line.includes(IMAGE)) return true;
    if (/blob:null\/[0-9a-f-]{36}/.test(line) && /connect/i.test(line)) return true;
    if (/inline style|stylesheet/i.test(line) && (line.includes(policySource('style-src')) || /^Refused to apply a stylesheet because its hash/.test(line))) return true;
    return /eval/i.test(line) && line.includes(policySource('script-src'));
}

/** `lines` without the start-up gates' canaries' own lines. */
export const withoutStartupCanaries = (lines: readonly string[]): string[] => lines.filter(line => !isStartupCanaryLine(line));
