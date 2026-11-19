# 01 · One element runs one app, given once

**Status: steps 1.0 to 1.6 and 1.8 of [the build order](05-build-order.md#step-1--startapp-grants) are built**:
`start(app, grants)` and `started` in both builds, the six members gone from both, `execute()` in the build with the
network modes only, `APP_SURFACE` (I1, I3) and `CONFIG_SCHEMA`'s owners (I17) with their tests, an element with no app
that builds nothing (the lifecycle's rows below), and the events that carry guest data not bubbling (`ELEMENT_EVENTS`,
I5; the network build's `fetch` is held to the same rule). Not built yet: commits by identity
(1.7), which waits for the owner. The code as it is:
[API.md](../API.md). [The folder's index](README.md) has the invariants (I1 to I5 and I17 are this file's) and what
[review 1](REVIEW-1.md) and [review 2](REVIEW-2.md) changed here.

## The root

Today an app is assembled on the element in several calls: `registerFiles()`, `expose()`, `setConfig()`, `load()`. Each
call changes one part, and the element runs whatever the parts add up to when it next builds. What one app left behind
(its host methods, its files, its pending writes, a call still in flight) is there for the next one, unless the embedder
remembered to take each away. The review board's findings of this kind (`BD5:DOC-3`, `BD6:LIM-2`, `BD6:CHL-3`) were
each a path by which one app's data or authority reached another on the same element, and each fix was a rule about
when to clean up.

The construction: there is no "next app" on an element. An app is handed to one method, once.

```ts
const sandbox = document.createElement('web-sandbox');
sandbox.start(
    { entry: 'app.js', html, files },                 // the app: what its author wrote
    { methods: { save }, guestWrites: true },         // the grants: what this embedder allows it
);
container.append(sandbox);
await sandbox.call('load', state);
// a second start() on this element throws; another app is another element
```

## `start(app, grants)`

```ts
start(app: SandboxApp, grants?: SandboxGrants): void

interface SandboxApp {                       // the app's own content; may come from data
    readonly html?: string;
    readonly entry?: string;
    readonly files?: Readonly<Record<string, FileEntry>>;
}

interface SandboxGrants {                    // the embedder's; never part of an app
    readonly methods?: Readonly<Record<string, HostMethod>>;
    readonly links?: readonly string[];
    readonly guestWrites?: boolean;
    readonly capabilities?: readonly SafeCapability[];
    // and the embedder's other options of today's config: allowAnimations, allowAutoplay, autoResize, callLimits,
    // watchdogTimeout, workerExecutionTimeout; in the build with the network modes, mode and its options
}

type HostMethod = (...args: unknown[]) => unknown;
```

**The app and the grants are two arguments.** An
embedder that runs other people's apps stores each as one value, and that value is naturally the first argument. If the
grants were fields of it, an app's author could ship their own `links` or `guestWrites` with the bundle. With two
arguments, an app read from data carries no grant unless a line of the embedder's moves it there.
`CONFIG_SCHEMA` classifies every option as the app's or the embedder's, the ones no longer accepted included
(`html` and `entry` are the app's; everything else is the embedder's); the two types are derived from it; and each
argument's schema refuses a key that belongs to the other, so `start({ html, links })` throws (I17).

What this is and is not: it keeps an app read from data from carrying a grant by accident. A grant is whatever the
embedder passes as the second argument. An embedder that stores a manifest of what each app asks for, and passes it as
the grants, has granted it.

- **It validates everything before it stores anything.** The app and the grants are each read once by their schema, the
  files are checked as one batch by the file store's rules, and the methods are read: own enumerable string keys, each
  value a function, each name by the rule `expose()` has today. Validation returns the values that are stored: the
  normalised options, a file store, and a frozen record of the methods with no prototype. The objects the embedder
  passed are not kept, so changing them afterwards changes nothing.
- **What it decides, and what it leaves to the build.** `start()` throws for everything the host page can decide
  without parsing guest text: the shape and type of each option, each path, the quota over the bytes given, an `entry`
  that names no file given or one that is not JavaScript. What needs a parse of guest text (an `import()` in the entry,
  what a module's rewrite or a stylesheet's references add) is decided where the parse runs
  ([03](03-served-document.md#a-thinner-host)) and ends the build with a termination reason, as a build failure does
  today.
- **An unusable app throws** a `TypeError` (the options, the methods, a key in the wrong argument) or a `FileError` (the
  files), and leaves the element exactly as it was: still without an app, so a corrected one can be started on it.
- **The binding is one step.** Reading the arguments runs the embedder's code (a getter, a Proxy), and that code could
  call `start()` on the same element. So nothing is stored while the arguments are read; when validation has returned,
  the element checks that it has no app and stores the validated values, with no code of the embedder's between the
  check and the store. Of two calls that overlap this way, the one that finishes validating first binds, and the other
  throws.
- **A second call throws a `TypeError`** and changes nothing, whatever the element's state: loading, ready, terminated,
  removed from the document.
- **It builds at once if the element is in a document**, otherwise when it is inserted.
- **An option of the other build throws.** In the default build a network mode's option throws with the reason
  `networkModesOff`. Today `setConfig()` never throws and ends the sandbox with that reason instead; that promise ends.

The name: `start`, the owner's choice over `run`. It says what happens once and pairs with the lifecycle's other verbs,
`reset()` (the same app again) and `terminate()`.

## What leaves the element

Both builds lose these members, so there is one element API and one lifecycle model.

| Member | Becomes | What can no longer be built |
| :--- | :--- | :--- |
| `setConfig(config)` | the two arguments of `start()` | Reconfiguring a used element into a different app |
| `load(html)` | `app.html` | New content on an element that keeps the old methods and files |
| `registerFiles(files)` | `app.files`, validated as one batch | Files registered for one app that the next one reads |
| `unregisterFiles(paths?)` | nothing: an app's files change only through its own committed writes | A clean-up step the embedder can forget |
| `expose(name, fn)` | `grants.methods`, copied and frozen at `start()`. A name not listed is `UNKNOWN_METHOD` for the element's whole life | A host method that outlives the app it was exposed for |
| `unexpose(names?)` | nothing: removing the element ends its methods | The same forgotten clean-up |
| `execute(code)` | removed from the default build only; it stays in the build with the network modes | A public method that can never run anything in sealed mode |

**What this closes, and what it does not.** It closes the paths by which the next app on an element reaches the last
one's methods, files, pending writes or late calls (`BD5:DOC-3`'s first path, `BD6:LIM-2`, `BD6:CHL-3`). It does not
close what goes through the embedder's own store: a storage key shared by the page's apps (`BD5:CHL-1`), or a handler of
a terminated app that is still running and writes again (`BD5:DOC-3`'s second path). Those stay the embedder's.

## The lifecycle

`state` keeps its four values: `'idle'`, `'loading'`, `'ready'`, `'terminated'`. A new read-only member says whether the
element has its app:

```ts
readonly started: boolean     // true once a start() has succeeded, for the rest of the element's life
```

`state` alone cannot say it: a new element and a bound one outside its document both read `'idle'`.

| Case | Today | In this design |
| :--- | :--- | :--- |
| An element with no app is inserted | builds an empty sandbox | stays `'idle'`; nothing is built, and no frame exists |
| `start()` on an element in a document | (several calls) | builds: `'loading'`, then `'ready'` or `'terminated'` |
| `start()` on an element outside a document | | stores the app; builds on insertion |
| `reset()` | rebuilds | rebuilds the same app, with its files as they are now, committed writes included; does nothing on an element with no app |
| `terminate(reason?)` | ends | unchanged; a later `reset()` restarts the same app. On an element with no app it does nothing, so such an element is never `'terminated'` |
| The element is removed from its document | the environment ends, pending calls reject with `TERMINATED`, no `terminated` event | unchanged; the app stays bound |
| The element is inserted again | builds a fresh environment | builds the same app again |
| The element is adopted into another document | ends, stays `'idle'` there with one warning | unchanged; the app stays bound, and moved back it builds again |
| Every build (the first, a `reset()`, a re-insertion) | pending guest writes are discarded | unchanged, and the write values listed before it can no longer be committed ([below](#files-and-commits)) |
| `call()` before the element is ready, or with no app | queued or refused by today's rules | unchanged; on an element with no app it is refused as it is today on one that is `'idle'` |

The lifecycle model (research 17, `LC_INPUTS`) loses the inputs for `setConfig`, `load` and changed files (a commit
changed only a count that `setConfig()`'s no-op rule read), gains the `start` input, and gains one rule: no input builds
an environment on an element with no app.

**Frameworks.** One element per app means the code that starts an app also makes its element, and removes it:

```ts
useEffect(() => {
    const el = document.createElement('web-sandbox');
    el.start(app, grants);
    box.current.append(el);
    return () => el.remove();
}, [app, grants]);
```

A set-up that runs twice (React's development StrictMode runs an effect, its clean-up, and the effect again) makes two
elements and removes one; another app is another element. An element the framework keeps and reuses must not be
restarted for another app. Two patterns are wrong for it, and the docs show neither: catching and ignoring the second
`start()`'s error, and `if (el.started) el.reset(); else el.start(app, grants)`. Both leave the first app running under
the second app's name, and the embedder's next `call()` hands it the second app's data (review 2, finding 2).
`started` says what the element is; it is not a way to reuse one.

**What stays the embedder's.** Its own storage keys, a closure two elements share, and relaying one app's data to
another element are the embedder's code. A host method still running after its app ended can go on writing to the
embedder's store; the design has no per-app abort signal.

## Calls

```ts
call(method: string, ...args: unknown[]): Promise<unknown>
callWithTimeout(timeoutMs: number, method: string, ...args: unknown[]): Promise<unknown>
```

A call can only reach this element's one app. The type parameter goes ([02](02-what-an-app-hands-over.md)): the result
is the guest's data.

## Files and commits

`listFiles()` and `listGuestWrites()` list this app's files and pending writes.

```ts
commitGuestWrites(writes: readonly GuestWrite[], options?: { code?: boolean }): boolean
```

Today `commitGuestWrites(paths)` commits whatever is pending for each path at the moment of the call. An embedder that
lists the writes, inspects their bytes and then commits by path commits bytes it never saw if the guest wrote again in
between (`BD5:DOC-6`). In this design the commit takes the write values themselves:

- A `GuestWrite` is a frozen value the library minted, and the library knows the ones it minted (by identity, in a
  `WeakMap` to the pending entry it was made from). Nothing is compared by content, and a copy of a value is not the
  value.
- Every value of the list is checked first. A value this element did not mint throws a `TypeError`, and nothing is
  committed.
- **A value can commit only while its entry is its path's current pending entry**, by identity. A value whose path has
  a newer pending write, one whose entry was already committed, and one listed before a build discarded the pending
  writes are all stale. So an older write the embedder was still checking cannot overwrite a newer one that was
  committed meanwhile.
- **All or none** (waits for the owner; [index](README.md#waits-for-the-owner), 2). If every value of the list is
  current, all are committed and the method returns `true`. If any is stale, nothing is committed and it returns
  `false`: the embedder lists again and checks again. An embedder that checked two files as a pair never has one of them
  committed without the other, and always knows which happened (review 2, finding 10).
- `options.code` keeps its meaning: a write of a type that can run needs it.
- `fileschanged` fires only when a commit changed the files, since nothing else can.

## Events

| Event | Bubbles today | In this design |
| :--- | :--- | :--- |
| `sandbox-log` | yes | does not bubble |
| `violation` | yes | does not bubble |
| `fileswritten` | yes | does not bubble |
| `fileschanged` | no | no |
| `ready`, `terminated` | no | no |

The three carry guest data. A bubbling listener on a shared ancestor, the usual way to delegate events, sees every
app's events today; with events that do not bubble it sees none. **A capture listener on an ancestor still receives
them**: the capture phase runs down the whole path whatever `bubbles` says (review 1, finding 5, run on three engines).
So this is not a construction: it removes the mixing an embedder gets by accident, and leaves the one they write on
purpose.

The construction would be to hand guest data to handlers given with the grants, so that no event object travels the
tree. Not chosen ([index](README.md#decided-after-review-1), 5): events are how an element reports, `ready` and
`terminated` stay events either way, and a page-wide capture listener named `sandbox-log` is a deliberate act.

## What it costs

- A breaking change in both builds: six members go (seven in the default build), two arrive, and the promise that
  `setConfig()` never throws ends.
- No live update of a running app's files from the host. A new version of an app is a new element.
- Cooperative mode loses quick re-runs on one element.
- A large test migration: `setConfig` appears in 84 files of `test/`, about 400 times, and the playground and the
  example app change with it.
- Less code in the library: roughly 350 lines out and 150 in under `src/`. The lifecycle model loses the inputs of
  `setConfig`, `load` and changed files.

## Considered and not chosen

| Shape | Why not |
| :--- | :--- |
| An `App` handle returned by `load()`, which owns the methods, files and writes and dies with the next load | It closes the same findings only if the events move to the handle too. It adds a second clock to the lifecycle (an app generation over the environment generation), a stale handle the embedder can keep, and about 400 lines |
| Per-load scoping inside today's method names | It needs a comparison to decide what counts as different content, which is a check. Methods and files set before the first build still go to whichever app builds next |
| Binding in the constructor only, `new WebSandbox(app)` | One rung stronger on paper: a second binding could not be written. But markup and frameworks create the element by its tag with no arguments, so an element without an app exists either way and needs a method to bind it. `start()` once, refused before anything is stored, gives the same guarantee for every way an element comes to exist |
| One value, `start({ config, files, methods })` | The first shape of this design. The grants sat in the value an app bundle is stored as (review 1, finding 6) |
| The name `run` | The owner found `start` clearer |
