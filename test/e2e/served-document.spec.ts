import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, ORIGIN } from './fixture';
import { pageDocumentUrl } from './library';

/**
 * The e2e server serves each build's sealed-document.html as the static file it is (vite.config.ts, SERVED_DOCUMENTS):
 * the bytes the build wrote into its output directory, with a content type and no header that sets a policy on it.
 * Research 32 found that most dev servers do not serve an .html file unchanged (Vite's dev server inserts its client's
 * script ahead of the file's policy), so the view every sealed-mode spec runs in is shown here to be the shipped file,
 * byte for byte, as the browser receives it.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const onDisk = (build: 'default' | 'network') => readFileSync(path.join(ROOT, pageDocumentUrl(build).slice(1)));

test.describe('the served document, as the e2e server answers it', () => {
    for (const build of ['default', 'network'] as const) {
        test(`${build} build: the bytes are the file the build wrote, with no policy header and no dev client`, async ({ page }) => {
            await page.goto(`${ORIGIN}/test/e2e/pixel.png`);
            const answer = await page.evaluate(async (url) => {
                const response = await fetch(url, { cache: 'no-store' });
                const headers: Record<string, string> = {};
                response.headers.forEach((value, name) => { headers[name] = value; });
                return { status: response.status, headers, bytes: [...new Uint8Array(await response.arrayBuffer())] };
            }, pageDocumentUrl(build));
            expect(answer.status).toBe(200);
            expect(answer.headers['content-type']).toBe('text/html');
            for (const name of ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'permissions-policy', 'document-policy']) {
                expect(answer.headers[name], name).toBeUndefined();
            }
            const served = Buffer.from(answer.bytes);
            expect(served.equals(onDisk(build))).toBe(true);
            expect(served.toString('utf8')).not.toContain('/@vite/client');
        });
    }

    test('both builds serve the same bytes (I12)', () => {
        expect(onDisk('default').equals(onDisk('network'))).toBe(true);
    });
});
