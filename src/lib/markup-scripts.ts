import { parseInert } from './trusted-types';

/**
 * Finds whether guest markup asks to run script: a `script` element (any namespace) or an event handler attribute (`on…`,
 * any case, any namespace), anywhere, template contents included. Cooperative mode without `allow-scripts` runs none of
 * it, so the element says so once (host.ts, _warnAboutNoScripts). Strict and sealed mode never call it: their view's
 * renderer notes what it drops (VIEW_INITIAL), and the element warns from that (HOST_PASSES, host-passes.ts; BD7:LIM-1).
 *
 * Read with the host's DOMParser (parseInert, trusted-types.ts): a parsed document has no browsing context, so nothing in
 * it runs or loads; but Chromium checks the host page's policy as it parses (a style attribute, a `<style>`, a `<base>`),
 * which is why only cooperative mode, whose guest document holds the same markup under the same policy, reads it here.
 * Only elements and attribute names are read, so text, comments, raw-text content (`<textarea>`, `<style>`, `<title>`)
 * and attribute values never count, nor do `data-on…` names. Host-side only, never stringified into a guest.
 */
export function scriptInMarkup(html: string): boolean {
    const parsed = parseInert(html);
    return holdsScript(parsed);
}

// An event handler content attribute: `on` and a letter (onclick, ONLOAD, onToggle). Any letter counts, so an
// attribute such as `one` does too: a false positive costs one warning, a missed handler a silent surprise.
const HANDLER_NAME = /^on[a-z]/i;

function holdsScript(root: ParentNode): boolean {
    for (const element of root.querySelectorAll('*')) {
        if (element.localName === 'script') return true;
        for (const name of element.getAttributeNames()) {
            if (HANDLER_NAME.test(name)) return true;
        }
        // a template's content is a fragment of its own (declarative shadow roots stay templates in a parsed document)
        if (element instanceof HTMLTemplateElement && holdsScript(element.content)) return true;
    }
    return false;
}
