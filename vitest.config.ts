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
        exclude: [...configDefaults.exclude, 'packages/template/*'],
    },

})