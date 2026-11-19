# Research 33: raw results

The output of each browser run of [research 33](../README.md), one JSON line per trial, written by
[`probe.mjs`](../probe.mjs) (`<configuration>[-headed][-real][-context|-proxy]-<plan>.jsonl`). The first line of a file
is `r33.run` (configuration, engine version, headed or not, real input or not, how the browser reaches the recorder,
the launch switches and prefs added, the date and the load average); each `r33` line is one trial in a fresh browser
with a fresh profile: its phases with their start times, `listed` (every connection to a listed host, filed under the
phase in whose window it was accepted, with its offset `at` in ms, its SNI or `CONNECT` target, and each HTTP request in
it with the phase it was sent in), `bare` (connections that never sent a byte that names a host), `pages` (requests to
the fixture's own host other than H and F), the popups, `diag` (what reached the link, per phase), `notes` (whether the
Tab and the script focused the link, the XTest offset, navigations) and the console lines that name a policy or a
preload. `node docs/research/33_link_href/summarize.mjs --table <files>` prints the compact view the README's tables
were read from (one line per configuration, layout and case); without `--table`, one line per trial.

`*-dns.jsonl` is the probe's output of a DNS pass and `*-dns.dns.jsonl` what [`dns.mjs`](../dns.mjs) filed from strace:
per trial, the DNS datagrams for that trial's listed name per phase, and connections to a resolver's port 853 or 443
(DNS over TLS or HTTPS; none were seen); its last line names the resolvers and the queries that named no trial.

All of it on 2026-11-19 with Playwright 1.65.1: Chromium 159.0.8154.6, Firefox 159.0, WebKit 27.2.

| Set | Plan | What it is |
| :--- | :--- | :--- |
| [`2026-11-19_pw-1.65.1/`](2026-11-19_pw-1.65.1/) `chromium-on-full`, `chromium-shell-full`, `firefox-on-full`, `webkit-full` | `full` | every case: `view` 8 trials per link form and 3 per guest or header case, `open` 2, `nometa` 1 |
| `chromium-full-lite`, `chromium-on-context-lite`, `chromium-on-proxy-lite`, `firefox-lite`, `firefox-on-nopreview-lite`, `firefox-on-proxy-lite` | `lite` | `plain`, `blank`, `inert`, `nohref` 3 each and `preconnect`, `prefetch`, `hdr-preconnect` 1 each in `view`; `plain`, `inert`, `preconnect` 1 each in `open`: Playwright's own arguments or prefs, an off-the-record context, the recorder as a proxy, Firefox's link preview off |
| `chromium-on-headed-lite`, `firefox-on-headed-lite`, `webkit-headed-lite` | `lite` | the same, headed under Xvfb |
| `chromium-on-headed-real`, `firefox-on-headed-real`, `webkit-headed-real` | `real` | `plain`, `blank`, `inert` 3 each in `view`, headed, hover, press, drag and click as X server events (XTest). In Chromium's and WebKit's every phase ran, but the real click after the context menu phase did not reach the link (the native menu took the press), so `*-real-press` repeats them with render, scroll, press, drag and the click only (`--only=press`) |
| `chromium-on-guards`, `firefox-on-guards`, `webkit-guards` | `guards` | the view's possible guards (`*-nopress`, `*-undraggable`) with `plain` and `inert`: 5 each in `view`, 1 in `open` |
| `firefox-hold300`, `firefox-hold2500` | `--only=press --hold=…` | Playwright's Firefox prefs, `plain`, `blank`, `inert` 3 each in `view`: the press held 300 ms and 2500 ms before the pointer moves away |
| `chromium-on-dns`, `firefox-on-dns`, `webkit-dns` | `dns` | the DNS pass under strace: `plain`, `blank`, `inert`, `preconnect`, `dnsprefetch`, `prefetch`, `hdr-preconnect`, `hdr-dnsprefetch` 2 each in `view` and 1 in `open`, on `listed.example` |
| `firefox-dns` | `dns`, `--cases=plain,blank,inert` | the same on Playwright's Firefox prefs, `plain`, `blank`, `inert`, 2 each in `view` and in `open` |
