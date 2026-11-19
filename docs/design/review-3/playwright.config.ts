// Review 3's e2e probes on the repository's own config and server, apart from the suite (whose testMatch is test/e2e and
// docs/research only). Run from the checkout's root:
//   PLAYWRIGHT_BROWSERS_PATH=/home/user/.cache/pw-project flock /home/user/.cache/web-sandbox-e2e.lock \
//     bunx playwright test -c docs/design/review-3/playwright.config.ts --trace off
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../../playwright.config';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

export default {
    ...base,
    testDir: root,
    testMatch: ['docs/design/review-3/**/*.spec.ts'],
    webServer: { ...(base.webServer as object), cwd: root },
};
