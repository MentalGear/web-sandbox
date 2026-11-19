// Review 3's unit probes, run apart from the suite (the suite's config includes only src/ and test/unit/):
//   bunx vitest run -c docs/design/review-3/vitest.config.ts
import { configDefaults, defineConfig } from 'vitest/config';
import { join } from 'path';

const root = join(__dirname, '../../..');

export default defineConfig({
    root,
    resolve: { alias: { '@src': join(root, 'src') } },
    test: {
        environment: './test/unit/jsdom-environment.ts',
        include: ['docs/design/review-3/**/*.test.ts'],
        exclude: [...configDefaults.exclude],
    },
});
