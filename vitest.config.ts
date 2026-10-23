import { configDefaults, defineConfig } from 'vitest/config'
import {join} from 'path'

export default defineConfig({
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