# 02 · What an app hands to the host page

**Status: a design, not built.** [The folder's index](README.md) has the invariants (I6 to I10 are this file's) and
what [review 1](REVIEW-1.md) and [review 2](REVIEW-2.md) changed here.

## The root

Every value from the guest is copied, measured and rate-limited, then arrives in the host page as ordinary data with
nothing that marks where it came from. Four findings of the review board's passes 5 and 6 are the same step: the host
page turns guest data into something with the page's authority.

| Finding | The step |
| :--- | :--- |
| `BD5:NEW-1` | a URL the app asks to open becomes a navigation |
| `BD5:CHL-2` | bytes the app wrote become a `blob:` URL of the host page's origin, with a type the app chose |
| `BD5:DOC-7` | a write's name and the type the app claims for it disagree |
| `BD5:DOC-5` | a WebAssembly module the app supplies is run by the host page |

The documented recipes for that step were wrong in five review passes in a row, and one fix needed a fix of its own.
The construction: guest data stays data, and the steps that carry authority are the library's.

## `links`: the user's click on a listed link opens it

```ts
grants.links?: readonly string[]     // exact https: URLs, at most MAX_LINKS (32)
```

`links` is a grant: it is the embedder's argument of `start()`, never part of the app
([01](01-one-element-one-app.md#startapp-grants)).

The app writes an ordinary link in its markup:

```html
<a href="https://docs.example.com/guide">Read the guide</a>
```

- **The embedder lists the URLs.** Each is a string that parses as a URL, has the scheme `https:`, has no user name or
  password, and is equal to its own serialisation (`new URL(s).href === s`), so that "the same URL" has one spelling.
  At most `MAX_LINKS`, no two equal. The schema refuses a list that breaks a rule, and `start()` throws. The default is
  no list: no link opens, as today.
- **The view marks a link whose `href` is a listed URL, character for character.** The comparison is of strings, with no
  parsing and no normalising of what the guest wrote. Any other `href` is inert, as today (`INERT_HREF`). A link is an
  HTML `a` element; an `area`, an SVG `a` and a MathML element with `href` are never marked.
- **The click is the request.** On a trusted `click` whose target is a marked link or inside one, and not on a form
  control inside it, the view sends the host page one message: the link's index in the list, an integer. Pressing Enter on a focused link is such a click; an
  `auxclick` (the middle button) sends nothing. The view still cancels the click's default, as it does for every link.
  The app's worker has nothing to call, and no method of the guest's opens a link.
- **The host page opens its own copy.** It checks that the index is an integer within the element's list and calls
  `window.open(links[index], '_blank', 'noopener,noreferrer')` in the task of that message. The URL it opens is the
  string the embedder listed; nothing of the guest's is part of it.
- **What the link shows.** The marked link's `href` in the view's document stays the inert one, so the browser's status
  bar and "copy link address" do not show the listed URL. Whether the listed URL can be the `href` itself without
  giving the browser something to fetch on hover is measured before that changes ([05](05-build-order.md)).

**Why not a call.** The first shape of this option was a call from the app's worker, `sandboxView.open(name)`.
[Research 30](../research/30_links_popup/README.md) measured the popup blocker with it on Chromium 159 and Firefox
159: the tab opens for 5 seconds after a click anywhere on the host page or in the view, not only a click on the link.
With a call, the app picks the moment and the link within those 5 seconds, whatever the user clicked. With the click
on a link as the request, the user's click on that link is the moment, and the app picks only which listed URL the
link carries.

**Measured** (research 30, popup blocker verifiably on, Chromium 159 and Firefox 159): a host page's `window.open` opened
the tab in every run after a click in the view, across the ports and the worker, and in the library as it is today with
the request as a call from the worker; one tab per click; no tab without a click. **Not measured:** this design's shape
(the view's own message, in the served file); Safari and any WebKit with a popup blocker (Playwright's WebKit has
none); touch and keyboard activation.

**What it leaves.**

- The app chooses which listed links it shows and how they look, so it can dress one up as something else, or cover its
  whole box with one.
- The moment is as strong as the view. An intact view asks only in the user's click on a marked link. A view that ran
  guest script (a renderer bug) could send any index of the list within the browser's 5 seconds of any click: any
  listed URL, never another one.
- A listed URL on a server the app's author reads is a signal, sent when the user clicks: which link, and when. The
  app can change a link's `href` before every click, so each click carries a choice among the listed URLs: log₂(n) bits
  for n links, 5 bits at `MAX_LINKS`, and the time. The egress table's row for `links` states it.
- The host page cannot see that the browser blocked a tab: with `noopener`, `window.open` returns `null` either way.
- It is sealed mode's first way out that is not the embedder's own code, so it gets a row in the egress table and a
  budget (`CHANNEL_BUDGETS`).

## No `Blob` or `File` crosses from the guest

A `Blob` carries a type, and a `blob:` URL made from it in the host page is a document of the host page's origin. The
measure of a guest value refuses `Blob` and `File` before the value is handed to any code of the embedder's (the
browser has deserialised it in the host page by then; nothing of the embedder's sees it), wherever a guest value
arrives: a host method's arguments, the result
of `call()`, a log line's arguments. The guest sends bytes (`Uint8Array`, `ArrayBuffer`) and the host page decides what
they are. A changed promise: an app that returned a `Blob` must return its bytes.

## A guest write's type comes from its path

Today the guest gives a type beside a write's content. In this design it gives a path and bytes, and the type is the one
the library's table has for the path's extension, or `application/octet-stream` for one it does not know. A write to
`evil.html` is `text/html`, whatever the app would have claimed, and needs `{ code: true }` to commit. A changed promise:
an app that gave a write its own type can no longer.

## `GuestBytes`

```ts
type GuestWrite =
    | { readonly path: string; readonly change: 'write'; readonly type: string; readonly size: number; readonly content: GuestBytes }
    | { readonly path: string; readonly change: 'remove' };

interface GuestBytes {
    readonly size: number;
    bytes(): Uint8Array;      // a copy; the one raw way out
    text(): string;           // decoded as UTF-8
    image(): Blob | null;     // a Blob of one of GUEST_IMAGE_TYPES, or null
    save(): void;             // the browser saves the bytes, under a name the library chose
}

const GUEST_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const;
```

A write's content is a value with four named ways out, in place of a `Uint8Array`.

- `image()` answers a `Blob` only for bytes that begin with the signature of one of `GUEST_IMAGE_TYPES`, typed as that
  one. SVG is not among them: an SVG document opened from a `blob:` URL runs script as the host page. For anything else
  it answers `null`.
- `save()` has the browser save the bytes, and names the file itself (waits for the owner;
  [index](README.md#waits-for-the-owner), 1). The library makes a `Blob` typed `application/octet-stream`, which a
  browser saves and does not render, puts its URL on a link whose `download` attribute is the library's name, clicks it
  and revokes the URL. The name is the last segment of the write's path when its extension is one of the library's
  inert types (the table that decides which writes need `{ code: true }`); otherwise that segment with `.download`
  added, so that `invoice.pdf.exe` and `report.html` are saved as files that nothing opens by a double click.
  The embedder names nothing. A `File` with that name, handed to the embedder, does not do this: Chromium and WebKit
  ignore a `File`'s name when saving it, so the embedder's own `download` attribute, naturally the guest's path, would
  name the file (review 2, finding 3, run on three engines).
- `bytes()` hands out the raw bytes. `new Blob([w.content.bytes()], { type: w.type })` still runs an SVG as the host
  page: the two common needs have a safe name, and the unsafe one is a step the embedder writes out. That makes this
  part a check, one named step away, and not a construction.

**This reverses the owner's decision of 2026-11-06** ("docs only, no helper"). Without it, `content` stays a
`Uint8Array` and the `blob:` case stays a documented limit.

## `unknown` for guest values

`HostMethod` takes `unknown[]`, and `call()` and `callWithTimeout()` return `Promise<unknown>`, with no type parameter.
A guest value typed by a type argument nothing checks reads as trusted in the embedder's code. A check, for TypeScript
users only.

## One registry of guest values

`GUEST_VALUES` (`src/lib/guest-values.ts`) classifies every value the public API hands the embedder: the library's, the
embedder's own, or the guest's. A unit test enumerates the API report against it, so a new member without a row fails,
and the docs' lists of guest-chosen text are generated from it. The list of such entry points was kept by hand, and four
review passes each found a member missing from it.

## Stays a documented limit

- Running the app's own WebAssembly module in the host page (`BD5:DOC-5`). The module is in the bundle the embedder
  already holds, so no boundary of the library's reaches it.
- A host method is the embedder's code with the page's rights.
- Strings and typed arrays from calls are raw. An SVG sent as a string and typed by the embedder is the same problem
  again.

## Considered and not chosen

| Shape | Why not |
| :--- | :--- |
| Wrapping every guest value in a branded type | Every handler would unwrap by reflex, and it is only a check |
| Mandatory schemas on methods | A string schema passes the same bad URL. It can be added later without a break |
| Docs and tested examples only, as now | It pins the example, not the embedder's code |
| `links` as a map of names, opened by `sandboxView.open(name)` | The app would pick the link and the moment within 5 seconds of any click (research 30) |
| URL patterns in `links` | A pattern's path is where the data would go |
| `links` as an option beside the app's `html` and `entry` | An app stored as one value would carry its own links (review 1, finding 6) |
