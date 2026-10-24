/**
 * The cookies each engine sends with a request of the sandbox: COOKIE_ENGINE_FACTS (src/lib/cookie-facts.ts), as the
 * table of docs/API.md and docs/THREAT-MODEL.md and the sentence of the README. The warning of `origins` reads the same
 * table, so the wording is one.
 */
import { COOKIE_ENGINES, COOKIE_ENGINE_FACTS, cookieSentence, sameSiteValues, withoutCorsCookieSentence, type CookieEngineFacts } from '../../../src/lib/cookie-facts';
import { signatureOf } from '../engine';
import { code, row, table, type Extractor } from './markdown';

const facts = (engine: (typeof COOKIE_ENGINES)[number]): CookieEngineFacts => COOKIE_ENGINE_FACTS[engine];

const factsTable = () => table(
    ['Engine', 'To an origin on the host page\'s site', 'To an origin on another site', 'Narrower with', 'Found by'],
    COOKIE_ENGINES.map(engine => {
        const entry = facts(engine);
        return row([
            `${entry.name}${entry.credentialless ? ' (the sandbox\'s frame is credentialless)' : ''}`,
            sameSiteValues(entry.sends.sameSite, code),
            sameSiteValues(entry.sends.crossSite, code),
            entry.protectedBy ? `${entry.protectedBy.configuration}${entry.protectedBy.measured ? '' : ' (not measured)'}: ${sameSiteValues(entry.protectedBy.sends.sameSite, code)} to the host page's site, ${sameSiteValues(entry.protectedBy.sends.crossSite, code)} to another` : '—',
            entry.measured,
        ]);
    }),
);

export const cookieFacts: Extractor = {
    items: () => [
        // the values per engine and reach, and whether the engine honours the attribute: prose that states them follows these
        { id: 'cookie-facts', signature: signatureOf(COOKIE_ENGINES.map(engine => [engine, facts(engine).credentialless, facts(engine).sends, facts(engine).protectedBy?.sends ?? null])), render: () => '' },
    ],
    regions: {
        'cookie-facts': factsTable,
        'cookie-sentence': () => cookieSentence(code),
        'without-cors-cost': () => withoutCorsCookieSentence(code),
    },
};
