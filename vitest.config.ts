import { configDefaults, defineConfig } from 'vitest/config'
import {join} from 'path'

export default defineConfig({
    resolve: {
        alias: {
            '@src': join(__dirname, 'src'),
        }
    },
    test: {
        environment: 'jsdom', // needed for browser env tests
        // unit tests only: the playwright specs (test/e2e, docs/research) run via `bun run test:e2e`
        include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
        exclude: [...configDefaults.exclude, 'packages/template/*'],
    },

})