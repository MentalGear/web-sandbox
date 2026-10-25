import { parseInert } from './trusted-types';

/**
 * Finds whether guest markup asks to run script: a `script` element (any namespace) or an event handler attribute (`on…`,
 * any case, any namespace), anywhere, template contents included. Strict mode's view, which sealed mode, the default,
 * shares, runs none of it (the renderer drops both, ADR-005), so the element says so once (host.ts, _warnAboutStrictHtml).
 *
 * Read with the host's DOMParser (parseInert, trusted-types.ts): a parsed document has no browsing context, so nothing in it runs or loads. Only
 * elements and attribute names are read, so text, comments, raw-text content (`<textarea>`, `<style>`, `<title>`) and
 * attribute values never count, nor do `data-on…` names. Host-side only, never stringified into a guest.
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
