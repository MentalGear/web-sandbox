# Research 34: raw results

The output of each run of [research 34](../README.md), one file per run, written by `run.mjs`. Each line is a tag and
one JSON object: `<tag>.run` (engine, version, date), then `.host`, `.controls`, `.check`, `.case`, `.console` and
`.library` lines per host page (`r34` the browsers, `r34e` the extension profile, `r34x` Electron, `r34l` the extension
load probe). `summarize.mjs <file>` prints the compact view the README's tables were read from.

| Set | Engines | What it is |
| :--- | :--- | :--- |
| [`2026-11-19_pw-1.65.1/`](2026-11-19_pw-1.65.1/) | Playwright 1.65.1: Chromium 159.0.8154.6 (headless shell; `-full` the full build in new headless mode; `-allowfile` with `--allow-file-access-from-files`), Firefox 159.0 (`-fileorigin` with `security.fileuri.strict_origin_policy` off), WebKit 27.2; Electron 45.4.1 (Chromium 156.0.8078.100) under Xvfb | `http-<engine>` the baseline, `file-<engine>` the `file:` host page, `extension-chromium` the five extension variants and an `http` page in the same profile, `extension-hash-load` the `hash` variant alone, `electron` Electron's `file:`, `app:` and `http` host pages. The two `file-firefox*` runs are from after the library pages moved to a fresh page each (`drive.mjs`, `runLibrary`): before it, Firefox's goto from the host page to the `file:` module page never committed; the other runs navigated the host page's own tab to the library pages. |
