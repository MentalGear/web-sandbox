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

From `src/lib/in-sandbox-view.ts` (`RENDER_ELEMENTS`, `RENDER_ATTRIBUTES`) at `298811d`:

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
  style) and `fix` (the recommended change: ids and labels kept, `name` replaced, text-like inputs `type=search`,
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

**There is a leak today, in the default mode.** On Chromium 159 and on Firefox 159, a guest that renders a text field
with a `name` the embedder's site also uses (`email`, `name`, `q`, `address`, …) is handed what the user once typed
into the embedder's field of that name, as soon as the user clicks the guest's field and picks the browser's suggestion:
the view forwards the browser's trusted `input` event with the value. One click and one choice; the user sees an
ordinary dropdown in what looks like the embedder's page. The values are not the embedder's alone (both browsers key
this history by the name only, on every site), so the guest gets whatever the user typed anywhere under that name. The
renderer admits the guest's `name` and `autocomplete` as they are, and the view forwards the value of every event's
target; nothing else stands in the way. It is a data leak in the review board's sense, at a user gesture, and it fits
class A of [research 18](../18_finding_classes/README.md): context of the host page that the sandbox inherits, here a
store of what the user typed that the browser keeps across sites.

**What does not leak today, and why.** Saved credentials: neither browser fills or offers one in an opaque-origin
document, and the view is one; that holds by construction as long as the view stays opaque. Saved addresses and cards
(Chromium): not offered in the view, only because Chromium 159 does not join a frame inside the element's shadow root to
the page's forms, and the tree it does build is rooted at the wrapper, an `about:srcdoc` document whose URL autofill
refuses. That is not a property of the library: one Chromium feature already in the build turns it into a leak of the
whole address and card (security code included) at the same gesture, and the planned served topology (D8 of
[research 24](../24_sealed_mode/README.md), [research 27](../27_served_document_headerless/README.md)) removes it at
Chromium's defaults, because the served file has an `http(s)` URL. A guest can also lay out one visible field and collect
the rest of the profile in fields the user never sees.

**The recommended change, in the renderer** (measured as the `fix` variant: nothing offered of any kind, in cshadow and
in the library with the switch on, on Chromium 159; nothing of the history on Firefox 159):

1. **The view owns `name`.** The renderer replaces the `name` of every form control with one of its own (one per
   distinct guest name and view, so radio groups and `FormData` keep their shape, never a name a page would use) and maps
   it back in the details it forwards (`target.name`, the `submit` pairs). Both browsers key the history by the field's
   name (by its id only when it has no name), so no value typed outside the view matches a name the view chose, whatever
   the browser honours: this one is by construction. Measured: `renamed` (name and id) not offered on either browser;
   `fix` (name only, with `off`) not offered; that a set name keeps the id out of the key is the browsers' rule,
   inferred, not isolated here. It also takes the names out of Chromium's address and card heuristics, but the labels
   still classify the fields (`renamed`: filled), so it does not close those alone.
2. **`autocomplete` is the view's, not the guest's:** removed from the guest's attributes, and `autocomplete="off"` set
   on every `form`, `input`, `select` and `textarea`. Both browsers honour it for the history and Chromium for the
   login email; Chromium ignores it for addresses and cards (measured).
3. **Text-like inputs render as `type=search`** (`text`, `email`, `tel`, `url`; a password stays a password; the guest's
   `inputmode` keeps the keyboard). Chromium 159 offered no address, card or login email in a search field, in any
   variant (`search`, `search-junk`, `search-off`, `fix`). This is Chromium's choice, honoured today, not a guarantee:
   it is a check the browser makes, and the reason the view should also refuse to forward an autofilled value (next).
4. **A backstop at the view's one chokepoint (not measured; inferred):** `describe()` reads the target's value for every
   forwarded event; if the target matches `:autofill`, the view clears the field and forwards `""`, so a fill the
   renderer did not foresee (a `textarea` or `select` the browser classifies, a new heuristic) never reaches the
   worker. Once the user edits the field the state goes, and what is forwarded is what the user typed. Measured here:
   Chromium 159 set `:autofill` on every fill it made, the history included; **Firefox 159 did not set it on a
   form-history fill** (the fields read without it), so this backstop does not cover Firefox's history, which points 1
   and 2 do.

Points 1 and 2 close what leaks today; 3 and 4 close what leaks under the switch and in the served topology. The cost
to guests: a guest's own form gets no browser autofill or autocomplete (the user types every value, which is what a
legitimate guest form gets in an opaque frame today anyway), `email` and `url` lose the browser's built-in validation
(the guest validates in its worker), search fields may show the engine's clear button (not measured), and
`autocomplete` tokens the guest sets (`one-time-code`, `new-password`) have no effect. `name`, ids, labels, `FormData`
and the details the guest receives keep their shape. Typing into a field with the change applied was not measured;
nothing in it touches how a field is edited (inferred). Each point is a rule of the renderer's allowlist or of
`describe()`, and each needs its e2e spec that fails against today's renderer (a seeded profile, as here, on Chromium
and Firefox) and a row in `INHERITED_CONTEXT` for the browser's autofill stores.

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
  not measured. The recommended `type=search` does not apply to them; point 4 is meant to cover them, unmeasured.
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
   (the guest's reports, in Web Inspector's console) contains after the choice. Repeat with `variant=fix`.
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
   `window.__guestLog` contain afterwards? Repeat with `variant=fix`.

An extension sets a field's value from script of its own, so the browser's `autocomplete`, `name` and `type` rules
(points 1 to 3 above) do not bind it; whatever change the renderer gets should be chosen with this case in mind.
