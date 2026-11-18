# 01 · One element runs one app, given once

**Status: a design, not built.** [The folder's index](README.md) has the invariants (I1 to I5 are this file's).

## The root

Today an app is assembled on the element in several calls: `registerFiles()`, `expose()`, `setConfig()`, `load()`. Each
call changes one part, and the element runs whatever the parts add up to when it next builds. What one app left behind
(its host methods, its files, its pending writes, a call still in flight) is there for the next one, unless the embedder
remembered to take each away. The review board's findings of this kind (`BD5:DOC-3`, `BD5:CHL-1`, `BD6:LIM-2`,
`BD6:CHL-3`) were each a path by which one app's data or authority reached another on the same element, and each fix
was a rule about when to clean up.

The construction: there is no "next app" on an element. An app is one value, handed to one method, once.

```ts
const sandbox = document.createElement('web-sandbox');
sandbox.start({
    config: { entry: 'app.js', html, guestWrites: true },
    files,
    methods: { save },
});
container.append(sandbox);
await sandbox.call('load', state);
// a second start() on this element throws; another app is another element
```

## `start(app)`

```ts
start(app: SandboxApp): void

interface SandboxApp {
    readonly config: SandboxConfig;
    readonly files?: Readonly<Record<string, FileEntry>>;
    readonly methods?: Readonly<Record<string, HostMethod>>;
}

type HostMethod = (...args: unknown[]) => unknown;
```

- **It validates everything before it stores anything.** The config is normalised by the schema (`CONFIG_SCHEMA`), the
  files are checked as one batch by the file store's rules (paths, types, the quota), and the methods are read: own
  enumerable string keys, each value a function, each name by the rule `expose()` has today. Validation returns the
  values that are stored: a normalised config, a file store, and a frozen record of the methods with no prototype. The
  app object the embedder passed is not kept, so changing it afterwards changes nothing.
- **An unusable app throws** a `TypeError` (the config, the methods, the shape of the app) or a `FileError` (the files),
  and leaves the element exactly as it was: still without an app, so a corrected app can be started on it.
- **A second call throws a `TypeError`** and changes nothing, whatever the element's state: loading, ready, terminated,
  removed from the document. The first successful call binds the element for its life.
- **It builds at once if the element is in a document**, otherwise when it is inserted.
- **A config of the other build throws.** In the default build a network mode's config throws with the reason
  `networkModesOff`. Today `setConfig()` never throws and ends the sandbox with that reason instead; that promise ends.

The name: `start`, the owner's choice over `run`. It says what happens once and pairs with the lifecycle's other verbs,
`reset()` (the same app again) and `terminate()`.

## What leaves the element

Both builds lose these members, so there is one element API and one lifecycle model.

| Member | Becomes | What can no longer be built |
| :--- | :--- | :--- |
| `setConfig(config)` | `app.config` | Reconfiguring a used element into a different app |
| `load(html)` | `app.config.html` | New content on an element that keeps the old methods and files |
| `registerFiles(files)` | `app.files`, validated as one batch | Files registered for one app that the next one reads |
| `unregisterFiles(paths?)` | nothing: an app's files change only through its own committed writes | A clean-up step the embedder can forget |
| `expose(name, fn)` | `app.methods`, copied and frozen at `start()`. A name not listed is `UNKNOWN_METHOD` for the element's whole life | A host method that outlives the app it was exposed for |
| `unexpose(names?)` | nothing: removing the element ends its methods | The same forgotten clean-up |
| `execute(code)` | removed from the default build only; it stays in the build with the network modes | A public method that can never run anything in sealed mode |

## The lifecycle

`state` keeps its four values: `'idle'`, `'loading'`, `'ready'`, `'terminated'`.

| Case | Today | In this design |
| :--- | :--- | :--- |
| An element with no app is inserted | builds an empty sandbox | stays `'idle'`; nothing is built, and no frame exists |
| `start(app)` on an element in a document | (several calls) | builds: `'loading'`, then `'ready'` or `'terminated'` |
| `start(app)` on an element outside a document | | stores the app; builds on insertion |
| `reset()` | rebuilds | rebuilds the same app, with its files as they are now, committed writes included; does nothing on an element with no app |
| `terminate(reason?)` | ends | unchanged; a later `reset()` restarts the same app |
| The element is removed from its document | the environment ends, pending calls reject with `TERMINATED`, no `terminated` event | unchanged; the app stays bound |
| The element is inserted again | builds a fresh environment | builds the same app again |
| The element is adopted into another document | ends, stays `'idle'` there with one warning | unchanged; the app stays bound, and moved back it builds again |
| `call()` before the element is ready, or with no app | queued or refused by today's rules | unchanged; on an element with no app it is refused as it is today on one that is `'idle'` |

The lifecycle model (research 17, `LC_INPUTS`) loses the inputs for `setConfig`, `load` and the file and method
changes, and gains one rule: no input builds an environment on an element with no app.

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
commitGuestWrites(writes: readonly GuestWrite[], options?: { code?: boolean }): void
```

Today `commitGuestWrites(paths)` commits whatever is pending for each path at the moment of the call. An embedder that
lists the writes, inspects their bytes and then commits by path commits bytes it never saw if the guest wrote again in
between (`BD5:DOC-6`). In this design the commit takes the write values themselves:

- A `GuestWrite` is a frozen value the library minted, and the library knows the ones it minted (by identity, in a
  `WeakMap` to the pending entry it was made from). Nothing is compared by content.
- Every value of the list is checked first. A value this element did not mint throws a `TypeError`, and nothing is
  committed.
- A value whose path has a newer pending write is skipped: its bytes are no longer what is pending, and the path stays
  pending with the newer write. `listGuestWrites()` shows what is still pending.
- `options.code` keeps its meaning: a write of a type that can run needs it.
- `fileschanged` fires only when a commit changed the files, since nothing else can.

## Events

| Event | Bubbles today | In this design | Why |
| :--- | :--- | :--- | :--- |
| `sandbox-log` | yes | does not bubble | It carries guest data. A listener on a shared ancestor sees every app's events today; listening per element makes mixing apps a deliberate act |
| `violation` | yes | does not bubble | the same |
| `fileswritten` | yes | does not bubble | the same |
| `fileschanged` | no | no | |
| `ready`, `terminated` | no | no | |

## What it costs

- A breaking change in both builds: six members go (seven in the default build), one arrives, and the promise that
  `setConfig()` never throws ends.
- No live update of a running app's files from the host. A new version of an app is a new element.
- Cooperative mode loses quick re-runs on one element.
- A large test migration: `setConfig` appears in 73 test files at about 660 call sites, and the playground and the
  example app change with it.
- Less code in the library: roughly 350 lines out and 150 in under `src/`, and the lifecycle model loses three inputs.

## Considered and not chosen

| Shape | Why not |
| :--- | :--- |
| An `App` handle returned by `load()`, which owns the methods, files and writes and dies with the next load | It closes the same findings only if the events move to the handle too. It adds a second clock to the lifecycle (an app generation over the environment generation), a stale handle the embedder can keep, and about 400 lines |
| Per-load scoping inside today's method names | It needs a comparison to decide what counts as different content, which is a check. Methods and files set before the first build still go to whichever app builds next |
| Binding in the constructor only, `new WebSandbox(app)` | One rung stronger on paper: a second binding could not be written. But markup and frameworks create the element by its tag with no arguments, so an element without an app exists either way and needs a method to bind it. `start()` once, refused before anything is stored, gives the same guarantee for every way an element comes to exist |
| The name `run` | The owner found `start` clearer |
