// The probe forms of research 29 and the reporter every plain document (cases a to d) runs. A form is markup only, so the
// same string goes into a plain document and, in case e, through the library's renderer (sandboxView.render).

/** The fields of each form kind: id, the autocomplete token, the semantic name, the input type. */
export const FIELDS = {
    login: [
        { id: 'u', token: 'username', name: 'email', type: 'email' },
        { id: 'p', token: 'current-password', name: 'password', type: 'password' },
    ],
    address: [
        { id: 'name', token: 'name', name: 'name', type: 'text' },
        { id: 'street', token: 'street-address', name: 'address', type: 'text' },
        { id: 'city', token: 'address-level2', name: 'city', type: 'text' },
        { id: 'state', token: 'address-level1', name: 'state', type: 'text' },
        { id: 'zip', token: 'postal-code', name: 'zip', type: 'text' },
        { id: 'email', token: 'email', name: 'email', type: 'email' },
        { id: 'tel', token: 'tel', name: 'phone', type: 'tel' },
    ],
    // one free-text field whose name the host page's own form also has: Chromium's autocomplete history (values typed
    // and submitted before, keyed by the field's name on every site)
    history: [{ id: 'note', token: 'on', name: 'r29note', type: 'text' }],
    card: [
        { id: 'ccname', token: 'cc-name', name: 'ccname', type: 'text' },
        { id: 'ccnum', token: 'cc-number', name: 'cardnumber', type: 'text' },
        { id: 'ccmonth', token: 'cc-exp-month', name: 'exp-month', type: 'text' },
        { id: 'ccyear', token: 'cc-exp-year', name: 'exp-year', type: 'text' },
        { id: 'cccsc', token: 'cc-csc', name: 'cvc', type: 'text' },
    ],
};

/**
 * The variants of a form's markup:
 * - `ac`: autocomplete tokens, semantic names and ids, labels (what a well-written form has);
 * - `noac`: no autocomplete attribute, semantic names, ids and labels (the browser's heuristics alone);
 * - `off`: `autocomplete="off"` on the form and on every field, semantic names, ids and labels;
 * - `bare`: no autocomplete, no label, names and ids `f1`, `f2`, ... (only the input types are left: a rewrite of
 *   `name` and `id` and no labels);
 * - `bare-text`: as `bare`, and every input `type=text` (also refusing `type=password` and `type=email`/`tel`);
 * - `bare-text-off`: as `bare-text`, with `autocomplete="off"` on the form and every field;
 * - `junk`: as `noac`, with an autocomplete token no browser knows (`x-r29`) on every field;
 * - `bare-text-junk`: as `bare-text`, with that token on every field;
 * - `hidden`: as `ac`, with every field but the first moved out of view by an inline style (the guest shows one field
 *   and collects the rest of the profile in fields the user does not see);
 * - `renamed`: names and ids `f1`, `f2`, ... as `bare`, but the labels kept (what a renderer that rewrites `name` and
 *   `id` leaves: it cannot take the text of the page away); `renamed-junk`: with the unknown token too;
 * - `search`: as `noac`, every input `type=search`; `search-junk`: with the unknown token too; `search-off`: with
 *   `autocomplete="off"` on the form and every field;
 * - `fix`: the renderer change this note measures: ids and labels as the guest wrote them, every `name` replaced by one
 *   the guest did not choose (`n1`, `n2`, ...), every text-like input `type=search` (a password stays a password), and
 *   `autocomplete="off"` on the form and every field.
 */
export const VARIANTS = ['ac', 'noac', 'off', 'junk', 'bare', 'bare-text', 'bare-text-off', 'bare-text-junk', 'hidden', 'renamed', 'renamed-junk', 'search', 'search-junk', 'search-off', 'fix'];

const LABELS = {
    u: 'Email', p: 'Password', name: 'Full name', street: 'Street address', city: 'City', state: 'State', zip: 'ZIP code',
    email: 'Email', tel: 'Phone', ccname: 'Name on card', ccnum: 'Card number', ccmonth: 'Expiry month', ccyear: 'Expiry year',
    cccsc: 'Security code', note: 'Note',
};

/** The DOM id a field has in a variant (the `bare` variants rename them). */
export function fieldId(kind, variant, index) {
    return variant.startsWith('bare') || variant.startsWith('renamed') ? `f${index + 1}` : FIELDS[kind][index].id;
}

/** One form's markup. The ids are the reporter's handles; the form's own id is `form`. */
export function formMarkup(kind, variant) {
    const bare = variant.startsWith('bare');
    const renamed = bare || variant.startsWith('renamed');
    const off = variant === 'off' || variant === 'bare-text-off' || variant === 'search-off' || variant === 'fix';
    const fields = FIELDS[kind];
    let rows = '';
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const id = fieldId(kind, variant, i);
        let type = variant.startsWith('bare-text') ? 'text' : f.type;
        if (variant.startsWith('search')) type = 'search';
        if (variant === 'fix' && type !== 'password') type = 'search';
        let name = renamed ? id : f.name;
        if (variant === 'fix') name = `n${i + 1}`;
        let attrs = `type="${type}" id="${id}" name="${name}"`;
        if (variant === 'ac' || variant === 'hidden') attrs += ` autocomplete="${f.token}"`;
        if (variant === 'hidden' && i > 0) attrs += ' style="position:absolute;left:-10000px"';
        if (off) attrs += ' autocomplete="off"';
        if (variant.endsWith('junk')) attrs += ' autocomplete="x-r29"';
        const label = bare ? '' : `<label for="${id}">${LABELS[f.id]}</label> `;
        rows += `<p>${label}<input ${attrs}></p>`;
    }
    const formAttrs = off ? ' autocomplete="off"' : '';
    return `<form id="form" method="post" action="/submitted"${formAttrs}>${rows}<p><button id="go" type="submit">Submit</button></p></form>`;
}

/**
 * The reporter of a plain document: it posts to `top` what script in this document can read of every input, on every
 * event of the fields (with isTrusted) and when asked (a `{ r29snap: step }` message from top, which it also relays to
 * its own frames), and whether the field matches
 * `:autofill` (the browser's own autofilled or previewed state, one bit script can read).
 */
export function reporterScript(label) {
    return `(() => {
  const label = ${JSON.stringify(label)};
  const fields = () => [...document.querySelectorAll('input')];
  const state = (el) => { let a = null; try { a = el.matches(':autofill'); } catch { try { a = el.matches(':-webkit-autofill'); } catch {} } return { id: el.id, value: el.value, autofill: a }; };
  const post = (what, extra) => top.postMessage({ r29: true, label, what, t: Math.round(performance.now()), origin: self.origin, fields: fields().map(state), ...extra }, '*');
  for (const type of ['input', 'change', 'focusin', 'focusout', 'keydown']) {
    document.addEventListener(type, (e) => post('event', { type, trusted: e.isTrusted, target: e.target && e.target.id, key: e.key }), true);
  }
  document.addEventListener('submit', (e) => { e.preventDefault(); post('submit', { form: [...new FormData(e.target)] }); }, true);
  // a snap request from top: answered here and relayed to this document's own frames (case cc's child)
  addEventListener('message', (e) => {
    if (!e.data || typeof e.data.r29snap !== 'string') return;
    post('snap', { step: e.data.r29snap });
    for (let i = 0; i < frames.length; i++) frames[i].postMessage(e.data, '*');
  });
  addEventListener('load', () => post('load'));
  post('start');
})();`;
}
