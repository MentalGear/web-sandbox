# 04 · Forms and the browser's autofill

**Status: built**, and described where the code is: [API.md](../API.md#forms-and-the-browsers-autofill), the `autofill`
row of [the threat model](../THREAT-MODEL.md#the-host-pages-context), and
[research 29](../research/29_autofill/README.md). This file says why the design depends on it and what is still owed.
Invariant I16 of [the folder's index](README.md).

## Why it is part of this design

A browser keeps the user's data for every site (the history of what they typed, keyed by a field's name; their
addresses, cards and logins) and fills form fields from it. Research 29 measured, with a seeded profile on Chromium 159
and Firefox 159:

| Store | Today's view, before the value model | In a served document, before the value model |
| :--- | :--- | :--- |
| History of what the user typed | reached the guest, after the user picked the suggestion | the same |
| Saved passwords | never filled or offered | never filled or offered |
| Saved addresses and cards (Chromium) | not offered, only because of how Chromium treats a frame inside a shadow root | **filled at Chromium's defaults**: the whole address or card after one choice, fields moved off-screen included |

The served document ([03](03-served-document.md)) gives the view an `http(s)` URL, which is what turns the last row on.
So the value model had to exist before the served document does.

## What is built

The invariant: the guest receives from a control only what the user entered into that control.

| Layer | What it does | Rung |
| :--- | :--- | :--- |
| The view owns `name` | every control gets a name the view drew; the guest sees its own names in what is forwarded | by construction: no store of the browser holds anything under that name |
| `autocomplete` is the view's | off the guest's allowlist, and `off` on every form and field | by construction, for the browsers that honour it |
| The value model | a control's value is accepted only from a trusted event on the control the user is in; any other change is undone before anything is forwarded | a model in the view, independent of any one browser's rules |

What remains by design: a value written into the field the user is in, while they are in it, is taken as theirs (one
suggestion they pick for that field, or text an extension inserts where they type).

## What is still owed

| Owed | When |
| :--- | :--- |
| The research 29 harness run against the library **in the served document**, framed as the element frames it (with `allow-forms`: research 29's served case had no such flag on the file's frame), at Chromium's defaults: one choice gives the guest the chosen field and nothing else | when the served document is built, before it is released |
| Safari, with the checklist of research 29 | before the docs promise it there |
| Firefox's saved addresses and cards | the same |
| A password manager's extension, with the checklist of research 29 | the same |
