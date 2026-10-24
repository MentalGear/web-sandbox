import type { Page } from '@playwright/test';
import { test, expect } from '../../../test/e2e/fixture';
import { inView } from '../../../test/e2e/strict-view';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COOKIES, HOSTS_LINE, PNG, hostsResolve, listener, wav, type Acao } from './server';

/**
 * Research 21, the real strict view: the library's own renderer and policy, with the one change the research is about.
 * `forced` rewrites the view's source in flight (page.route, as research 16's measure.spec.ts does; src/ is not touched) so
 * that the renderer's `clean()` sets crossorigin="anonymous" on every img, video, audio and link it keeps, after its
 * attribute loop and before the element is moved into the document. `baseline` is the renderer as it is.
 *
 *   echo '127.0.0.1 app.wsprobe.test cdn.wsprobe.test cross.wsprobe2.test' >> /etc/hosts
 *   bunx playwright test docs/research/21_crossorigin_loads/view.spec.ts --project=chromium   # then firefox, webkit
 *
 * The guest lists the listener's X origin (cross.wsprobe2.test, another site from the harness page) for images, media,
 * styles and fonts, and renders one of every load the renderer lets through. Results: results/<engine>-view.json.
 */

test.use({ ignoreHTTPSErrors: true });
for (const name of ['NO_PROXY', 'no_proxy']) process.env[name] = `${process.env[name] ?? ''},.test`;

const here = path.dirname(fileURLToPath(import.meta.url));

/** The renderer sets the attribute on the elements that load through an attribute of their own or their children's. */
// (the dev server serves the module as esbuild prints it: double quotes)
const FORCE = `if (html && (name === "img" || name === "video" || name === "audio" || name === "link")) set(element, "crossorigin", "anonymous");`;
const ANCHOR = `if (rules.referrerElements.indexOf(name) >= 0) set(element, "referrerpolicy", "no-referrer");`;

async function rewriteView(page: Page) {
    await page.route('**/src/lib/in-sandbox-view.ts**', async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        expect(source).toContain(ANCHOR);
        await route.fulfill({ response, body: source.replace(ANCHOR, `${FORCE}\n${ANCHOR}`) });
    });
}

const markup = (X: string, A: Acao) => {
    const u = (k: string, file: string) => `${X}/${A}/${file}?k=V.${A}.${k}`;
    return `
<img src="${u('img', 'a.png')}" alt="">
<img srcset="${u('srcset', 'a.png')} 1x" alt="">
<picture><source srcset="${u('picsource', 'a.png')}"><img alt="" src="${u('picimg', 'a.png')}"></picture>
<img crossorigin="use-credentials" src="${u('guest-usecred', 'a.png')}" alt="">
<video src="${u('video', 'e.wav')}" poster="${u('poster', 'a.png')}" preload="auto"><track default kind="subtitles" src="${u('track', 'g.vtt')}"></video>
<video preload="auto"><source src="${u('sourcevideo', 'e.wav')}" type="audio/wav"><track default kind="subtitles" src="${u('track2', 'g.vtt')}"></video>
<audio src="${u('audio', 'e.wav')}" preload="auto"></audio>
<audio preload="auto"><source src="${u('sourceaudio', 'e.wav')}" type="audio/wav"></audio>
<div style="width:5px;height:5px;background-image:url('${u('styleattr', 'a.png')}')"></div>
<style>@import url("${u('import', 's.css')}"); .bg{width:5px;height:5px;background:url("${u('stylebg', 'a.png')}")} @font-face{font-family:P;src:url("${u('font', 'f.ttf')}")} .f{font-family:P}</style>
<div class="bg"></div><p class="f">font</p>
<img id="own-img" src="pic.png" alt=""><audio id="own-audio" preload="auto" src="tone.wav"></audio>
<link rel="stylesheet" href="own.css"><div class="own" id="own-css">x</div>`;
};

for (const variant of ['baseline', 'forced'] as const) {
    test(`strict view, ${variant}`, async ({ sandbox, page, context, browserName }) => {
        test.setTimeout(240000);
        test.skip(!(await hostsResolve()), `add this line to /etc/hosts: ${HOSTS_LINE}`);
        const srv = await listener();
        const out: Record<string, unknown> = { engine: browserName, variant };
        try {
            await context.addCookies(COOKIES);
            if (variant === 'forced') await rewriteView(page);
            await sandbox.open();
            const X = srv.origin('X');
            for (const A of ['cors', 'nocors'] as Acao[]) {
                srv.hits.length = 0;
                await sandbox.clearViolations();
                await sandbox.registerFiles({
                    [`main-${A}.js`]: `sandboxView.render(${JSON.stringify(markup(X, A))});`,
                    'pic.png': { base64: PNG.toString('base64'), type: 'image/png' }, 'tone.wav': { base64: wav(1).toString('base64'), type: 'audio/wav' }, 'own.css': '.own{width:9px}',
                });
                const origins = { images: [X], styles: [X], fonts: [X], media: [X] };
                expect(await sandbox.mount({ mode: 'strict', entry: `main-${A}.js`, origins })).toBe('ready');
                await page.waitForTimeout(3500);
                const attrs = await inView<string>(page, browserName, `JSON.stringify([...document.querySelectorAll('img,video,audio,source,track,link')].map(e => e.localName + ':' + e.getAttribute('crossorigin')))`);
                const state = await inView<string>(page, browserName, `JSON.stringify([...document.images].map(i => i.naturalWidth))`);
                // the view's own files (minted blob: URLs): they must keep working with the attribute
                const own = await inView<string>(page, browserName, `JSON.stringify({ img: document.getElementById('own-img').naturalWidth, imgSrc: document.getElementById('own-img').src.slice(0, 9), audio: document.getElementById('own-audio').readyState, audioError: document.getElementById('own-audio').error && document.getElementById('own-audio').error.code, css: getComputedStyle(document.getElementById('own-css')).width })`);
                const violations = (await sandbox.violations()).map(v => `${v.directive} ${v.blockedURI.replace(X, 'X')}`);
                out[A] = {
                    crossoriginAttributes: attrs, imageWidths: state, ownFiles: own, violations,
                    hits: srv.hits.map(h => ({ k: h.k.replace(`V.${A}.`, ''), method: h.method, status: h.status, mode: h.mode, dest: h.dest, origin: h.origin, cookies: h.cookies, range: h.range })),
                };
                const carried = srv.hits.filter(h => h.cookies.length > 0);
                console.log(`VIEW ${browserName} ${variant} ${A}: ${srv.hits.length} requests, ${carried.length} with a cookie [${carried.map(h => h.k.replace(`V.${A}.`, '')).join(' ')}], violations ${violations.length}`);
            }
        } finally {
            srv.stop();
        }
        mkdirSync(path.join(here, 'results'), { recursive: true });
        writeFileSync(path.join(here, 'results', `${browserName}-view-${variant}.json`), JSON.stringify(out, null, 1));
    });
}
