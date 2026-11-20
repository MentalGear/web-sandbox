import { configDefaults, defineConfig } from 'vitest/config'
import {join} from 'path'
import { servedDocumentDigestPlugin } from './scripts/served-document'

export default defineConfig({
    // the served file's digest in src/lib/document-digest.ts, as the build and the e2e server have it (scripts/served-document.ts)
    plugins: [servedDocumentDigestPlugin()],
    resolve: {
        alias: {
            '@src': join(__dirname, 'src'),
        }
    },
    test: {
        environment: './test/unit/jsdom-environment.ts', // jsdom, whose teardown leaves the request gate's pinned globals (see the file)
        // unit tests only: the playwright specs (test/e2e, docs/research) run via `bun run test:e2e`
        include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
        exclude: [...configDefaults.exclude, 'packages/template/*'],
    },

})