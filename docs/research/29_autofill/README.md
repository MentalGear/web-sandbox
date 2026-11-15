# Research 29: the browser's autofill in forms a guest renders

**Question.** In sealed mode (the default; [research 24](../24_sealed_mode/README.md), docs/API.md
["Building an app in sealed mode"](../../API.md#building-an-app-in-sealed-mode), [`examples/sealed-app/`](../../../examples/sealed-app/app.js))
the guest's UI is markup that the view's renderer admits into an opaque-origin frame, and the view forwards the user's
input to the guest's worker. The renderer admits form controls with the attributes autofill keys on
([what it admits](#what-the-renderer-admits-and-forwards)). Can the browser's password manager or autofill put the user's saved
data (the credential saved for the embedder's site, an address, a payment card, values typed on the embedder's site)
into a field the guest rendered, so that the guest reads it? Nothing in docs/THREAT-MODEL.md or docs/API.md mentions
autofill or password managers. And if it can: which change to the renderer's allowlist makes the fill impossible rather
than detected, and what does it cost guests?

**Measured on Chromium 159.0.8154.6** (Chrome for Testing, the full build Playwright 1.65.1 installs as `chromium-1255`,
launched with `channel: 'chromium'`: new headless, and once headed under Xvfb), 2026-11-15, with a seeded profile
([Seeding](#seeding-and-the-positive-control)). The library case (e) ran the default build bundled from `9a91584`
(`bun scripts/build-lib.ts --out <scratch>/dist`); the view, its renderer, the frame builders and the element's shadow
root are unchanged at `298811d` (the commits between change the worker's globals). The other cases are plain HTML on
research 27's [`server.mjs`](../27_served_document_headerless/server.mjs), on loopback. Firefox 159.0 (Playwright's
build) ran cases a to e for the login, the address and form history, with its own profile
([Seeding](#seeding-and-the-positive-control)). WebKit and Safari: not measured ([Not measured](#not-measured), with a
checklist for a Mac). Raw output is in [`results/`](results/README.md). Each cell below ran once; nothing here is timing-dependent (every step waits
0.9 to 2 s), and the cells that two sets share (case a to d, e) agree between batch runs made hours apart.

## Answer in brief

- **(Now) The library closes it** in the renderer and the view that strict and sealed mode share: the view names every
  form control itself, forces `autocomplete="off"`, and forwards a control's value only as the user entered it into that
  control ([What this means](#what-this-means-for-sealed-mode)). Measured with the change: no history offered on either
  browser; with Chromium's switch on, an address or card choice reaches the guest only in the field the user chose from,
  and the other fields are undone in the view. The bullets below are what was measured before it.
- **(Leak today) Chromium 159 hands the guest of the library's default mode the user's autocomplete history, after one
  choice in a dropdown.** A value the user typed and submitted into a field named `r29note` on the host page was offered
  in the guest's field of the same name in the library's view (case e): a click in the field showed it, ArrowDown
  previewed it, and when the user picked it with Enter, the guest's worker received it in the `input` and `change`
  details and in the `submit`. The history is keyed by the field's `name` alone, on every site, and the frame tree plays
  no part (filled alike in a, c, cshadow and e). The guest chooses the `name` (`email`, `q`, `address`, …), so it can ask
  for what the user typed into the embedder's own fields of that name. `autocomplete="off"` stopped it in every
  topology; an unknown `autocomplete` token and `type=search` did not; a `name` the guest did not choose did.
- **(Passwords) The saved credential was filled only in documents of the host page's own origin, on Chromium 159 and
  Firefox 159.** In the host page (a) and a same-origin frame (d), both browsers filled the username and password on
  load, without a gesture. Chromium withheld both from script until the user's first click (script read `""` with
  `:autofill` true on load, the values after the click); Firefox did not (script read both on load). In every
  opaque-origin frame (b, c, cc, and the same inside a shadow root) and in the library (e) neither browser filled,
  previewed or offered the password.
- **(Addresses, cards) Chromium 159 fills an opaque-origin frame's form with the saved address or card once the user
  picks the suggestion, and script in that frame reads every value.** Today's topology without the library (b), the
  planned served file (c) and its `srcdoc` child (cc): a click in the first field offered the profile, ArrowDown
  previewed it (script read `""`, `:autofill` true), Enter filled every field (name, street, city, state, ZIP, email,
  phone; on HTTPS the card's holder, number, expiry and security code), with trusted `input` and `change` events carrying
  the values. Nothing was filled without that choice. The login form's email field got the address's email the same
  way.
- **(Library today: addresses and cards) In the library's view no address or card was offered, because of how Chromium
  159 walks the frame tree, not because of anything the library does.** chrome://autofill-internals lists the view's
  form with its fields classified (`NAME_FULL`, `ADDRESS_HOME_STREET_ADDRESS`, …), then drops it: "Ignoring form because
  the source url has no allowed scheme". The element puts its wrapper frame in its shadow root (`src/host.ts`,
  `attachShadow`); Chromium 159 does not join a frame inside a shadow root to the forms of the page around it, so the
  form's tree is rooted at the wrapper, an opaque `about:srcdoc` document, whose URL autofill refuses. A plain sandboxed
  `srcdoc` frame in a shadow root (bshadow) behaves the same.
- **(One switch) With Chromium's own `AutofillExtractShadowDomIframes` feature on (in this build, off by default), the
  guest's worker received the address, the card and the address email**, through the `input`, `change`,
  `focusin`/`focusout` and `submit` details of its `sandboxView.on` handlers.
- **(Served topology) The planned served document gets addresses and cards at Chromium's defaults.** The served file
  framed with `sandbox="allow-scripts"` inside a shadow root (cshadow), and its `srcdoc` child (ccshadow), were filled
  with the address and the card after the user's choice, readable by script: their tree is rooted at a document with an
  `http(s)` URL, which autofill admits.
- **(More than the user sees)** With only the first field in view and the others moved off-screen by an inline style
  (the renderer admits `style`), picking the suggestion for "Full name" filled all seven fields (c, cshadow, and e with
  the switch, where the worker received them all); the card's number was filled off-screen the same way.
- **(`allow`) `allow="shared-autofill"` changed nothing measured** (b and c filled with and without it; bshadow with
  neither). The library's frames carry no `allow` attribute unless the embedder delegates a feature (`frame-documents.ts`).
- **(What Chromium honours in the markup)** `autocomplete="off"`: honoured for history and the login email, ignored for
  addresses and cards. An unknown token: honoured for addresses and the login email, ignored for cards and history.
  `name` and `id` rewritten, labels kept: addresses and cards still filled (the labels suffice), history not offered.
  `type=search`: no address, card or login email, history still offered. **`type=search` with `autocomplete="off"` on
  every text field stopped all four kinds**, in cshadow and in e with the switch, and so did the change this note
  recommends ([below](#what-this-means-for-sealed-mode)).
- **(Firefox 159) Form history leaks into the library's view too.** Values typed and submitted on the host page into
  fields named `email` and `name` were offered in the guest's fields of those names in case e (and in b, c, cshadow),
  and after the user picked one the guest's worker received it. `autocomplete="off"` and a `name` the guest did not
  choose stopped it; an unknown token and `type=search` did not. The saved login was filled only in a and d (on load,
  readable by script without a gesture), never in an opaque frame or in e. Firefox's address and card autofill: not
  measured (the control offered no saved address; cards not seeded).
- **(WebKit, Safari) Not measured:** Playwright's WebKit has no Keychain autofill and Safari does not run on Linux; a
  [checklist](#safari-checklist) for a Mac is below.

## What the renderer admits and forwards

From `src/lib/in-sandbox-view.ts` (`RENDER_ELEMENTS`, `RENDER_ATTRIBUTES`) at `298811d`, what the measurements below ran
against (the renderer and the view have changed since: [What this means](#what-this-means-for-sealed-mode)):

| Element | Attributes admitted (besides the global `id`, `class`, `style`, `title`, `lang`, `dir`, `hidden`, `tabindex`, `role`, `translate`, `inert`, `spellcheck`, `inputmode`, `enterkeyhint`, `autocapitalize`, `data-*`, `aria-*`) |
| :--- | :--- |
| `form` | `name`, `autocomplete`, `novalidate` (no `action`, `method` or `target`) |
| `input` | `type`, `name`, `value`, `checked`, `disabled`, `readonly`, `required`, `placeholder`, `min`, `max`, `step`, `minlength`, `maxlength`, `pattern`, `size`, `multiple`, `accept`, `autocomplete`, `list`, `form`, `dirname`, `alt` |
| `select` | `name`, `multiple`, `size`, `disabled`, `required`, `form`, `autocomplete` |
| `textarea` | `name`, `rows`, `cols`, `placeholder`, `disabled`, `readonly`, `required`, `maxlength`, `minlength`, `wrap`, `form`, `autocomplete`, `dirname` |
| `label` | `for` |
| `button` | `type`, `name`, `value`, `disabled`, `form` |
| `option` | `value`, `selected`, `disabled`, `label` |
| `optgroup` | `label`, `disabled` |
| `fieldset` | `name`, `disabled`, `form` |
| `output` | `for`, `name`, `form` |
| `datalist`, `legend` | none of their own |

Every input type is admitted, `password`, `email` and `tel` included, and every `autocomplete` token. `sealed-reach.ts`
classifies `input@autocomplete` and the rest as presentation.

What reaches the worker: the view forwards each trusted event of a type the guest subscribed to with `sandboxView.on`
(`click`, `input`, `change`, `submit`, `keydown`, the pointer types, `wheel`, `scroll`, `focusin`, `focusout`;
`VIEW_EVENT_TYPES`), and its detail carries the target's `value` (`describe()` in `inSandboxView`), and for `submit`
every field of the form (`FormData`). Chromium's autofill fires trusted `input` and `change` events, so a fill is
forwarded as it happens, and every later event on a filled field carries its value. The guest cannot read a field
without an event, but it needs none of its own: the fill is one.

## Method

- **Seeding and the positive control** are described [below](#seeding-and-the-positive-control).
- **The forms** ([`forms.mjs`](forms.mjs)): a login form (`type=email` + `type=password`), an address form (name, street,
  city, state, ZIP, email, phone), a card form (holder, number, expiry month and year, security code) and a one-field
  history form (`name="r29note"`), each in variants: `ac` (autocomplete tokens, semantic names and ids, labels), `noac`
  (no `autocomplete`), `off` (`autocomplete="off"` on the form and every field), `junk` (an unknown token, `x-r29`, on
  every field), `bare` (names and ids `f1`…, no labels), `bare-text` (also every input `type=text`), `bare-text-off`,
  `bare-text-junk`, `renamed` (names and ids `f1`…, labels kept), `renamed-junk`, `search` (every input
  `type=search`), `search-junk`, `search-off`, `hidden` (`ac`, every field but the first moved off-screen by an inline
  style) and `fix` (the change this note first proposed: ids and labels kept, `name` replaced, text-like inputs `type=search`,
  `autocomplete="off"`).
- **Cases a to d** ([`run-plain.mjs`](run-plain.mjs)), one page load per case, form and variant, on
  `http://127.0.0.1:18929` (and `https://127.0.0.1:18943` for cards, [below](#https)): (a) the form in the host page;
  (b) `iframe sandbox="allow-scripts" srcdoc` (today's topology without the library); (c) the served file
  `/served` framed with `sandbox="allow-scripts"`, the form in it; (cc) the form in that file's own
  `iframe sandbox="allow-scripts" srcdoc`; (d) the served file framed without `sandbox`. The `…shadow` cases put the same
  frame in an open shadow root, as the element does. Every document runs a reporter that posts to `top`, for every
  `input`, `change`, `focusin`, `focusout` and `keydown`, its `isTrusted` and what script reads of every field (`value`
  and `:autofill`), and answers a snapshot request at each step.
- **The user's sequence**, the same in every case: load and wait 2 s; a click in the first field (Playwright's mouse,
  through CDP); ArrowDown (on Firefox twice: its popup opens on the first and selects on the second); Enter; Tab through
  the fields; in case e, a click on Submit. Keys are sent as a keyboard sends
  them on Linux (`rawKeyDown`, `char`, `keyUp`, through CDP `Input.dispatchKeyEvent`): Playwright's `keyboard.press`
  sends a key with text as one `keyDown`, which Chromium's suggestion popup does not take as Enter (it previewed on
  ArrowDown and never accepted; [`lib.mjs`](lib.mjs) `pressKey`).
- **No gesture from the harness.** Playwright's `evaluate` runs with a user gesture, which would hand a frame the
  activation Chromium waits for before it shows script an autofilled password. The snapshots are asked for and read
  through CDP `Runtime.evaluate` with `userGesture: false`, in `top` only, and no locator touches the form's frame before
  the click.
- **Case e** ([`run-library.mjs`](run-library.mjs)): the host page on the same origin registers `<web-sandbox>`
  (`defineWebSandbox()`), registers `app.js` and calls `setConfig({ entry: 'app.js', html: <the form> })`, nothing else
  (sealed mode, default configuration, as `examples/sealed-app/host.js` does). The guest subscribes to `input`,
  `change`, `submit`, `keydown`, `focusin`, `focusout` and `click` on the form and reports every detail to the host with
  `bridge.call('report', detail)`; the host records each with the step it arrived in, and scans it for the seeded strings.
- **Diagnosis of e.** chrome://autofill-internals open in a second tab during a case (`--internals`), and plain cases
  that each add one property of the view to case b (its `allow-forms` flag, its policy with `form-action 'none'`, a
  `default-src 'none'` policy, its `@layer` style, a `<base href="about:blank">`, the form inserted by script from a
  `<template>`, a `srcdoc` in a `srcdoc`): every one of them filled, so none is the cause; putting the frame in a shadow
  root is ([table](#case-e-and-the-shadow-root-chromium-159)).
- [`summarize.mjs`](summarize.mjs) prints the compact view the tables were read from.

### Seeding and the positive control

- **Chromium.** [`seed-chromium.mjs`](seed-chromium.mjs) creates a fresh profile and saves the dummies through the
  browser's own settings pages: chrome://password-manager "Add" (site, username, password), chrome://settings/addresses
  "Add", chrome://settings/payments "Add" (number, expiry, security code, holder). Playwright passes
  `--password-store=basic`, so nothing depends on a keyring. The read-back is from the profile's databases once the
  browser is closed ([`results/…/seed.txt`](results/2026-11-15_chromium-159.0.8154.6/seed.txt)): one `logins` row each for
  `http://127.0.0.1:18929/` and `https://127.0.0.1:18943/`, one address with its tokens, one card. The password
  manager's dialog refuses `localhost` as a site ("Not a valid web address"), so the host page is `127.0.0.1`, which is a
  secure context too.
- **The values** are dummies made to be unambiguous in a log: user `r29-user@example.test`, password
  `r29-secret-PW-7Q4X`, address "Rtwonine Leakcheck, 29 Autofill Lane, Probeville CA 94029", `r29-address@example.test`,
  phone 415 555 0129, card holder "Rtwonine Cardholder", number `5555555555554444`, 12/2031, code 929. No profile,
  database or key is in the repository.
- **Autocomplete history (Chromium)**: before the cases, the host page's own form with a field `name="r29note"` is
  typed into with real keys (`r29-typed-note`) and submitted (`--seed-history`; [`lib.mjs`](lib.mjs) `seedHistory`).
- **Firefox.** [`seed-firefox.mjs`](seed-firefox.mjs), with the prefs Playwright's Firefox turns off turned back on
  ([`firefox-prefs.mjs`](firefox-prefs.mjs): `signon.rememberSignons`, `signon.autofillForms`,
  `extensions.formautofill.*`, `browser.formfill.enable`): the login through about:logins "Create New Login"; form
  history by typing the dummies into the host page's own fields named `email`, `name`, `address`, `city`, `zip`, `phone`
  and submitting; the address written to `autofill-profiles.json` while the browser is closed. Read back
  ([`results/2026-11-15_firefox/seed.txt`](results/2026-11-15_firefox/seed.txt)): one row in `logins.db` for
  `http://127.0.0.1:18929`, the eight form-history rows. A first attempt wrote `logins.json`, encrypted through the
  browser's own NSS with the profile's `key4.db`: Firefox 159 keeps logins in `logins.db` and never read it (the control
  filled nothing).
- **The controls.** Chromium: case a filled the login on load, the address and the card (HTTPS) after the choice, and the
  history value after the choice; every value readable by script after the click. Firefox: case a filled the login on
  load and the form-history values after the choice; **no saved address was ever offered, in the host page either**
  (only the form-history value of the one field), so Firefox's address autofill is not measured.

### HTTPS

Chromium offered no card on `http://127.0.0.1` (no suggestion, no preview, in the host page itself), and offered it on
HTTPS. The HTTPS cases run behind a TLS front on port 18943 ([`lib.mjs`](lib.mjs) `startTlsFront`) whose self-signed
certificate (made in the scratch directory) Chromium takes as valid with `--ignore-certificate-errors-spki-list`: the
page has no certificate error, and the card control filled.

## Results

"Filled" means script in the form's document read the seeded value after that step (case e: the guest's worker
received it); "offered" means the suggestion showed and ArrowDown previewed it (Chromium: `:autofill` true, value `""`
to script). Every fill came with trusted `input` and `change` events carrying the values. Nothing in any case was
filled before the user's choice, except the credential in a and d.

### Credentials (saved for the host page's origin)

| Case | Chromium 159 | Firefox 159 |
| :--- | :--- | :--- |
| a: host page | filled on load, no gesture; script read `""` (`:autofill` true) until the first click, then both | filled on load, no gesture; script read both on load |
| d: same-origin frame, no `sandbox` | as a | as a |
| b, c, cc and their shadow-root forms: opaque-origin frames | password never filled, previewed or offered | password never filled or offered (b, c, cc, cshadow) |
| e: the library | nothing | nothing |

Firefox filled the login in a with `autocomplete="off"`, with renamed fields and with `fix` too; it never filled one in
an opaque-origin frame, so that does not reach the guest.

### Autocomplete history and form history (typed on the host page; keyed by the field's name)

| Case | Chromium 159 (`r29note`) | Firefox 159 (`email`, `name`) |
| :--- | :--- | :--- |
| a: host page | offered; filled after the choice | the one field filled after the choice |
| c, cshadow (Chromium); b, c, cshadow (Firefox) | offered; filled, readable | filled, readable |
| **e: the library** | **offered; the worker received `r29-typed-note`** in `input`, `change` and `submit` | **offered; the worker received `r29-user@example.test` (field `email`) and `Rtwonine Leakcheck` (field `name`)** |

| Variant | Chromium 159 (where) | Firefox 159 (where) |
| :--- | :--- | :--- |
| `noac` | filled (a, c, cshadow, e; e with the switch) | filled (e, b, c, cshadow) |
| `off` | not offered (a, c, cshadow, e, e with the switch) | not offered (e, a, c) |
| `junk` (unknown token) | filled (a, c, cshadow, e with the switch) | filled (e) |
| `search` | filled (cshadow, e) | filled (e) |
| `search-off` | not offered (cshadow) | not measured |
| `renamed` (a `name` and id the host page never used) | not offered (cshadow) | not offered (e, a, c) |
| `fix` | not offered (cshadow; e with and without the switch) | not offered (e, a, c) |

### Addresses and cards (the user picks the suggestion)

| Case | Address (`ac`, `noac`) | Card (`ac`, HTTPS) | Login form's email field |
| :--- | :--- | :--- | :--- |
| a: host page | offered; all 7 filled after Enter, readable | offered; holder, number, expiry, code filled, readable | the address email |
| b: sandboxed `srcdoc` | offered; all filled, readable | offered; filled, readable | the address email |
| c: served file, `sandbox="allow-scripts"` | offered; all filled, readable | offered; filled, readable | the address email |
| cc: its `srcdoc` child | offered; all filled, readable | offered; filled, readable | the address email |
| d: served file, no `sandbox` | offered; all filled, readable | offered; filled, readable | the address email |
| bshadow: b in a shadow root | **not offered** | **not offered** | the address email |
| cshadow, ccshadow: c and cc in a shadow root | offered; all filled, readable | offered; filled, readable | the address email |
| dshadow | offered; all filled, readable | offered; filled, readable | the address email |
| **e: the library** | **not offered; nothing reached the worker** | **not offered; nothing reached the worker** | **nothing** |
| e, headed under Xvfb | not offered | not measured | not measured |
| Firefox 159, every case | not measured: no saved address offered in the control | not measured: not seeded | the form-history value (above) |

### Case e and the shadow root (Chromium 159)

| Case | Address | Card | chrome://autofill-internals |
| :--- | :--- | :--- | :--- |
| b, and b with each one property of the view: `allow-forms`, `form-action 'none'`, `default-src 'none'`, the view's `@layer` style, `<base href="about:blank">`, the form inserted from a `<template>`, a `srcdoc` in a `srcdoc` | filled | filled (b) | the subframe's own form is dropped ("no allowed scheme"); the fields are filled through the main frame's form, URL `http://127.0.0.1:18929/` |
| bshadow; a `srcdoc` in a `srcdoc` in a shadow root | not offered | not offered (bshadow) | dropped: "Ignoring form because the source url has no allowed scheme", URL "Invalid URL", origin `null` |
| e: the library | not offered | not offered | the view's form parsed and classified, then dropped as above |
| the same three with `--enable-features=AutofillExtractShadowDomIframes` | **filled** | **filled** (e) | |
| `allow="shared-autofill"` on b, c, bshadow | as without it | as without it (b, bshadow) | |

### What the worker received in case e with the switch on (Chromium 159)

| Form (variant) | Received by the guest's worker |
| :--- | :--- |
| address (`ac`, `noac`, `off`) | name, street, city, ZIP, email, phone: in 12 of the 21 details from Enter on (`input`, `change`, `focusin`, `focusout`), 15 of 18 while tabbing, and in the `submit` |
| address (`hidden`: one field in view) | the same, from six fields the user never saw |
| card (`ac`, `off`, `junk`, `renamed`, `renamed-junk`, `hidden`; HTTPS) | holder and number in `input`/`change` details and the `submit`; the view showed expiry `12`/`2031` and code `929` filled |
| login (`ac`, `noac`, `hidden`) | the address email in the email field |
| every form in `junk` (but the card), `bare`, `bare-text`, `bare-text-off`, `bare-text-junk`, `fix`; login in `off`; card in `search-junk` | nothing |

### What the markup changes, where Chromium fills (addresses, cards, login email)

Measured in c and cshadow (plain, readable by script) and in e with the switch on (what the worker received); where two
of them ran a variant, they agree.

| Variant | Address | Card (HTTPS) | Login email |
| :--- | :--- | :--- | :--- |
| `ac`, `noac` | filled | filled | filled |
| `off` (form and fields) | **filled** | **filled** | not offered |
| `junk` (unknown token) | not offered | **filled** | not offered |
| `renamed` (names and ids, labels kept) | **filled** | **filled** | **filled** |
| `renamed-junk` | not offered | **filled** | not offered |
| `bare` (renamed, no labels), `bare-text`, `bare-text-off`, `bare-text-junk` | not offered | not offered | not offered |
| `search`, `search-junk`, `search-off` | not offered | not offered | not offered |
| `fix` | not offered | not offered | not offered |
| `hidden` | **all 7 filled**, 6 of them off-screen | **filled**, the number off-screen | filled |

## What this means for sealed mode

**What leaked, measured above against the renderer as it was at `298811d`.** On Chromium 159 and Firefox 159, a guest
that rendered a text field with a `name` the user had typed into anywhere (`email`, `name`, `q`, …) was handed what the
user typed there, as soon as the user picked the browser's suggestion in the guest's field; the view forwarded the
browser's trusted `input` event with the value. With Chromium's `AutofillExtractShadowDomIframes` on (and, for the plain
documents, in the served topology at Chromium's defaults), one choice in one field filled every field of the guest's form
with the saved address or card, fields the user never saw included, and the worker received all of them. A data leak in
the review board's sense, at a user gesture; class A of [research 18](../18_finding_classes/README.md): a store of the
user's that the browser offers in every document's fields.

**What the library does now** (the `autofill` row of `INHERITED_CONTEXT`, `src/lib/inherited-context.ts`, and its column
of `SEALED_REACH`; docs/API.md, [Forms and the browser's autofill](../../API.md#forms-and-the-browsers-autofill)). The
invariant: the guest receives from a control only what the user entered into that control. Three layers, in the renderer
and the view that strict and sealed mode share:

1. **The view owns `name`** (by construction). The renderer gives every listed form control it keeps
   (`RENDER_NAMED_CONTROLS`: `input`, `select`, `textarea`, `button`, `fieldset`, `output`) a name of the view's: a prefix of
   18 random digits drawn when the view starts, then the guest's name as five decimal digits per UTF-16 code unit (one view
   name per distinct guest name, so radio groups, `form` association and `FormData` keep their shape, and no word of the
   guest's for a field heuristic to read), and a nameless control `prefix_n` of its own (so no two nameless radios form a
   group, and the id is never the key). The view maps it back in `target.name` and in a submit's fields
   (`viewControlNames`); a nameless control's field is dropped, as the browser would not have submitted it. Both browsers key
   the history by the name, and by the id only for a nameless field (measured below), so nothing typed anywhere matches a
   control of the view.
2. **`autocomplete` is the view's** (by construction). It is on no allowlist, and every `form`, `input`, `select` and
   `textarea` gets `autocomplete="off"` (`RENDER_FORCED_ATTRIBUTES`): neither browser offers or saves history there, and
   Chromium offers no login email.
3. **The view's value model** (by construction in the view, on every engine, whatever a browser fills by heuristics). The
   view keeps the state it accepted per control and changes it only after the guest's own operations (a flush that renders,
   writes text, or sets a value or checkedness accepts what it leaves, having undone anything else first), a form's reset
   (the guest's defaults), or the user's entry in a trusted `input` or `change` event of that control, by its kind
   (`VIEW_VALUE_KINDS`): a text field when it is focused and the user's latest pointer press, key (`KeyboardEvent`
   `keydown`/`keyup`), composition or drop was on it; a select, range, colour, date or time input when the user's latest press
   was on it, or their key with it focused; a checkbox or radio by the trusted click on it that is not cancelled (accepted in
   the click, which the browser dispatches after it has toggled the control). A file input is not modelled: only the user's
   choice sets one. Anything else is undone where it is seen: in the `input` or `change` event it raised, at the user's next
   press, key, composition, drop or `beforeinput` on the control (so a user's edit applies to what the view accepted), and at
   every read the view forwards (`describe()`, a submit's fields): the one chokepoint. A flush of `set()`s visits only their
   targets (a radio with its group); a render or a text() every control of the view, linear in them.

Not adopted: text-like inputs rendered as `type=search` (part of the `fix` variant above) and `:autofill` as a backstop. The value
model is browser-independent and stops every fill into a control the user is not in, so a heuristic Chromium honours today
(no address in a search field) adds nothing to it, at the cost of the control's role, its validation and its keyboard; and
`:autofill` is weaker than the model (Firefox sets no such state on a form-history fill) and would only decide what the
model already decides.

What the model takes as the user's: a value written into the field the user is in, while they are in it, with a trusted
`input` event. That is one suggestion of the browser's the user picks for that field (the invariant: the user entering one
value), or text an extension inserts where the user is typing (`execCommand('insertText')`, which raises trusted events
indistinguishable from an input method's). It is the row's residual (`userField`), pinned by `test/e2e/view-values.spec.ts`.
No allowlist of `inputType` is part of the rule: a user's spellcheck, autocorrect and datalist choices arrive as
`insertReplacementText`, which Firefox's form history uses too, so an allowlist could not stop the one without losing the
others, and the history is closed by points 1 and 2.

Whether a guest should receive values of fields the user cannot see at all is a separate question (a guest can lay out a
field off-screen, or under another element, and the user can still Tab into it and type): the user's own entry there is
what the user entered, and the model forwards it; what the user sees of the view is the guest's (out of scope in
docs/THREAT-MODEL.md: UI spoofing inside the element's box). This fix does not change it.

### The editing matrix (no profile; Chromium 159, Firefox 159, WebKit 27.2)

[`probe-editing.mjs`](probe-editing.mjs), in a top-level document and in an opaque sandboxed `srcdoc` frame inside a shadow
root as the view is (both agree on every engine); raw output in [`results/2026-11-15_editing/`](results/2026-11-15_editing/),
`bun summarize-editing.mjs <file>`. "Focused" is `document.activeElement` at the value event. Every user edit is trusted.

| Way | What the document sees (all three engines unless named) | The model |
| :--- | :--- | :--- |
| typing, Backspace, Delete | `keydown`, `beforeinput` and `input` (`InputEvent`, `insertText`, `deleteContentBackward`, `deleteContentForward`), focused | accepted |
| paste (keyboard), cut | `paste`/`cut`, then `beforeinput` and `input` (`insertFromPaste`, `deleteByCut`), focused | accepted |
| undo, redo (Control+Z, Control+Shift+Z, Control+Y) | `beforeinput` and `input` (`historyUndo`, `historyRedo`), focused | accepted |
| an input method's commit (`keyboard.insertText`) | Chromium, WebKit: `beforeinput` and `input` (`insertText`); Firefox: `compositionstart`, `insertCompositionText`, `compositionend`; focused | accepted |
| IME composition (CDP `Input.imeSetComposition`, Chromium) | `compositionstart`, `beforeinput` and `input` (`insertCompositionText`) per update, focused | accepted |
| a drop of text, into the focused field or another | `drop` while the field is not yet focused, then `focusin`, `beforeinput` and `input` (`insertFromDrop`), focused | accepted (the drop makes it the user's control) |
| a value set by script, with no event; `setRangeText()` | nothing | undone at the next read |
| a value set by script with a synthetic `input` | an untrusted `input` | undone at once |
| `execCommand('insertText')` into the focused field | a trusted `input` (`insertText`; WebKit also `beforeinput`), focused | accepted only where the user's latest press or key was (the residual); undone after a script's `focus()` |
| checkbox: click, Space, its label clicked | a trusted `click` on the checkbox (on the label, then the checkbox), then `input` and `change` (`Event`); WebKit does not focus it on a label's click | accepted at the click |
| checkbox: a script's `click()` | an untrusted `click`, then **trusted** `input` and `change` | undone |
| radio: click, arrow keys | a trusted `click` on the radio, `input`, `change` | accepted, with its group |
| select: ArrowDown while focused | `keydown`, `input`, `change`, focused | accepted |
| select: Playwright's `selectOption` (script) | untrusted `input` and `change` | undone |
| range: a click on its track | `pointerdown`, then `input` **before** `focusin`, then `change` | accepted (a pointer's press) |
| range: arrow key | `keydown`, `input`, `change`, focused | accepted |
| date: typed | Firefox: `input` and `change` once complete, focused; Chromium and WebKit headless: no `input` in the probe | accepted where raised |
| reset button | `reset` at the form; the values change after it | the guest's defaults |
| spellcheck replacement, paste from the context menu | browser UI: not drivable here (not measured); they arrive on the focused field after the user's press on it | accepted (inferred) |

### What a fill looks like to the document (the seeded profile; case a)

[`probe-events.mjs`](probe-events.mjs); raw output `results/…/events*.json`, `bun summarize-events.mjs <file>`.

| Fill | Chromium 159 | Firefox 159 |
| :--- | :--- | :--- |
| history, the field chosen from | trusted `keydown`, `input`, `change`, `keyup`, each a plain `Event` (no key, no `inputType`), on the focused field, `:autofill` | trusted `beforeinput` and `input` (`InputEvent`, `insertReplacementText`) on the focused field, no `:autofill` |
| address, card: the field chosen from | as history | not measured (no saved address offered in the control) |
| address, card: every other field | the same four plain `Event`s on each field, **not focused**, `:autofill` | not measured |
| login, on load (host page's origin only) | the four plain `Event`s on each field, none focused | `beforeinput`, `input` (`insertReplacementText`), `change` on each, none focused |
| the history's key | a nameless field with id `r29note` is offered the history of name `r29note`; a field with a name of the view's and that id is offered nothing (with and without `autocomplete="off"`) | the same for id `email`: a nameless field offered, a named one not |

### Measured with the fix (case e: the library's default build with this change)

`results/2026-11-15_chromium-159.0.8154.6/library-fixed-*.txt`, `results/2026-11-15_firefox/library-fixed.txt`; the
before is the tables above (and `library-history.txt`, `library-flag-*.txt`, `library-two-arrows.txt`).

| Case | Before | With the fix |
| :--- | :--- | :--- |
| Chromium, history (`noac`, `ac`, `off`) | offered; the worker received `r29-typed-note` | not offered; nothing received |
| Firefox, form history (login and address forms, `noac`, `ac`) | offered; the worker received the email and the name | not offered; nothing received |
| Chromium at its defaults, address and login | not offered (the shadow root) | not offered; nothing received |
| Chromium with the switch, address (`ac`, `noac`, `hidden`) | all seven fields received, six of them off-screen in `hidden` | offered; the user's choice filled the field they were in, which the worker received (`Rtwonine Leakcheck`); the six others were undone in the view and never received |
| Chromium with the switch, card (HTTPS; `ac`, `hidden`) | holder and number received | only the holder, the field chosen from; the number, expiry and code undone, never received |
| Chromium with the switch, login form | the address email | not offered (`autocomplete="off"`) |

The served topology (cshadow, ccshadow) is not the library yet (D8); its documents will run the same renderer and view,
so the same layers apply there, but nothing of it was measured with the library.

**What it costs guests.** No browser autofill or autocomplete in a guest's form (a guest's `autocomplete` tokens,
`one-time-code` and `new-password` included, have no effect); a guest stylesheet's `[name=…]` selector matches nothing;
text inserted into a field the guest focused with `set({ focus })` before the user pressed or keyed anything in it (some
dictation) is undone; a hidden field named `_charset_` keeps the guest's value. Nothing of how a user edits a field
changed (the matrix; `test/e2e/view-values.spec.ts` on all three engines). The model's own cost, measured 2026-11-15 on a
view of 12 000 inputs, the median of 12 operations, the host page's longest stall (`test/e2e/host-share.ts`): a `set()` as
before (1 to 4 ms on each engine, its target alone visited); a render of one element 12, 13 and 20 ms (Chromium, Firefox,
WebKit) against 5, 2 and 5 ms before (every control visited twice, about 1 µs each); a keystroke the same as before (one control). All of it is
charged to the view's time budget, so the bound on the host page is unchanged.

## Not measured

- **WebKit and Safari.** Playwright's WebKit build has no Keychain or AutoFill integration, and Safari does not run on
  Linux. The checklist below is for a person with a Mac.
- **Firefox's address and card autofill.** No saved address was offered in the host page's own form (the control
  failed), with the address written to `autofill-profiles.json` and the formautofill prefs on; Firefox's save prompt is
  browser UI that Playwright does not drive, and cards need the OS key store. Not measured; nothing is concluded about
  them.
- **Chromium's password manager across sites** (affiliated sites, a credential saved for the served file's own origin,
  passkeys and WebAuthn conditional UI): not measured. Only the host page's own origin was saved.
- **`textarea` and `select` as the field the user clicks**, and a `select` among filled fields (country, expiry month):
  not measured with a profile. The value model treats them as it treats every control (a `select` filled while the user is
  in another field is undone); `test/e2e/view-values.spec.ts` covers a `select`, a range and a `textarea` set by script.
- **Safari.** The model's rules for a checkbox, a radio and a `select` do not depend on focus because Safari on macOS does
  not focus them on a click; that was chosen from WebKit's behaviour on Linux (a checkbox not focused by its label's
  click), not measured on Safari.
- **Autofill on typing** (Chromium's suggestions after the first characters typed, `AutofillAddressSuggestionsOnTyping`)
  and suggestions on a guest's programmatic focus (`sandboxView.set(id, { focus: true })`): not measured; every case
  here began with a click.
- **A real HTTPS origin with a certificate from a public CA**, other channels of Chromium (stable, beta), Android
  WebView, and a real user profile with sync: not measured. HTTPS here is the TLS front with a certificate Chromium
  takes as valid by its SPKI hash.
- **Repeats.** Each cell ran once per batch; the cells that two batches share (cases a to e on Chromium, a on Firefox)
  agree.

### Safari checklist

On a Mac with this checkout, Bun and Safari (Settings, AutoFill: "Using information from my contacts", "User names and
passwords", "Credit cards" on):

1. Build the default bundle outside the repository and serve case e and the plain cases without a browser:
   `bun scripts/build-lib.ts --out ../r29/dist`, then in this folder
   `R29_SCRATCH=/abs/path/r29 bun run-library.mjs --serve-only` (case e) or `R29_SCRATCH=/abs/path/r29 bun run-plain.mjs --serve-only`
   (cases a to d and their shadow forms, `…/host?case=<case>&kind=<kind>&variant=<variant>`). Both listen on
   `http://127.0.0.1:18929`, a secure context; Safari offers cards only on HTTPS, so for cards put a TLS proxy the Mac
   trusts in front.
2. Save a password for `http://127.0.0.1:18929` in the Passwords app, give your own contact card an address, email and
   phone, and save a test card in Safari's AutoFill settings (dummies, as in [Seeding](#seeding-and-the-positive-control)).
3. In the host page, type a value into a field named `email` and submit it once (`/host?case=a&kind=login&variant=noac`
   is enough): the history.
4. The control first: `/host?case=a&kind=login&variant=ac`, `kind=address`, `kind=card`. Is anything filled on load;
   does clicking the first field show a suggestion or the AutoFill key; after choosing it, is the value in the field?
   Without a working control, a negative below means nothing.
5. Then `/lib-host?kind=login&variant=noac` (its first field is named `email`: the history, and the login),
   `kind=address&variant=ac` and `kind=card&variant=ac`: the same questions, and what the host page's `window.__guestLog`
   (the guest's reports, in Web Inspector's console) contains after the choice. A bundle of this checkout applies the
   view's names, `autocomplete="off"` and its value model to every variant.
6. The same for `case=b`, `c` and `cshadow`, where script in the frame reads the value (its reports are in the host
   page's `window.__r29log`).

### A password-manager extension (any browser)

Not measured here either. An extension that reads the page is outside the threat model
([out of scope](../../THREAT-MODEL.md#out-of-scope-and-what-the-embedder-must-do): it can read and change any frame),
and nothing in the library protects the user from one. This checks the other direction only: whether a guest receives
what an extension fills into the view's fields. With the servers of step 1, in Chrome, Firefox or Safari with a
password-manager extension that holds a login for `http://127.0.0.1:18929` and an identity (name, address, email):

1. The control: `/host?case=a&kind=login&variant=ac` and `kind=address`. Does the extension offer or fill?
2. `/lib-host?kind=login&variant=noac` and `kind=address&variant=ac`: does the extension show its icon or menu in the
   view's fields, does it fill them (on load, on a click, from its own menu), and what does the host page's
   `window.__guestLog` contain afterwards?

An extension sets a field's value from script of its own, so the browser's `autocomplete`, `name` and `type` rules
do not bind it; the view's value model does: what it writes into a field the user is not in is undone before the guest
hears of it, and what it inserts where the user is typing is the `autofill` row's residual.
