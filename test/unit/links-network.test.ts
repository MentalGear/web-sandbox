import '@src/network'; // the network build: this file tests modes the default build does not have (ADR-009)
import { describe, expect, it } from 'vitest';
import { normaliseConfig } from '@src/lib/config-schema';
import { LINK_RULES } from '@src/lib/links';
import { fixedDetail, reasonText } from '@src/lib/reasons';

/**
 * `links` in the build with the network modes (design 02, I6; test/unit/links.test.ts has the rest): strict mode reads it
 * as sealed mode does (the view is the same), the modes with no view ignore it with a warning and keep no list, and a list
 * that breaks a rule refuses the config in every mode, before anything of it is stored.
 */

const HOST = { hostOrigin: 'http://localhost:4444', hostSites: ['http://localhost:4444'] };
const A = 'https://docs.example.com/guide';

describe('links in every mode', () => {
    it('strict mode keeps the list, as sealed mode does', () => {
        for (const mode of ['strict', 'sealed'] as const) {
            const { value, warnings } = normaliseConfig({ mode, links: [A] }, HOST, 'start');
            expect(value!.config.links, mode).toEqual([A]);
            expect(warnings.filter(line => line.includes('"links"'))).toEqual([]);
        }
    });

    it('cooperative and worker mode ignore a valid list, with one warning, and keep none', () => {
        for (const mode of ['cooperative', 'worker'] as const) {
            const { value, warnings } = normaliseConfig({ mode, links: [A] }, HOST, 'start');
            expect(value!.config.links, mode).toEqual([]);
            expect(warnings.filter(line => line.includes('"links" is used only in strict and sealed mode'))).toHaveLength(1);
            expect(normaliseConfig({ mode }, HOST, 'start').warnings.filter(line => line.includes('"links"'))).toEqual([]);
        }
    });

    it('a list that breaks a rule refuses the config in every mode, with its reason', () => {
        for (const mode of ['strict', 'sealed', 'cooperative', 'worker'] as const) {
            const { value, refusal } = normaliseConfig({ mode, links: [A, A] }, HOST, 'start');
            expect(value, mode).toBeNull();
            expect((refusal as Error).message, mode).toBe(reasonText('linksRefused', fixedDetail(LINK_RULES.distinct)));
        }
    });
});
