/**
 * The cookies each engine sends with a request of the sandbox: COOKIE_ENGINE_FACTS (src/lib/cookie-facts.ts), as the
 * table of docs/API.md and docs/THREAT-MODEL.md and the sentence of the README. The warning of `origins` reads the same
 * table, so the wording is one.
 */
import { carrierModes, COOKIE_CARRIERS, COOKIE_CARRIER_IDS, COOKIE_ENGINES, COOKIE_ENGINE_FACTS, cookieSentence, hostSiteSentence, reachedEntries, sameSiteValues, withCode, type CookieEngineFacts } from '../../../src/lib/cookie-facts';
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

// where each engine takes the host page's site from, and whether a framed host page can read its ancestors' origins
const hostSiteTable = () => `${hostSiteSentence(code)}

${table(
    ['Engine', "A request's site is decided from", 'A host page framed by another origin', 'Found by'],
    COOKIE_ENGINES.map(engine => {
        const entry = facts(engine);
        return row([
            entry.name,
            withCode(entry.siteFrom, code),
            entry.hasAncestorOrigins ? `decided: its ancestors' origins come from ${code('location.ancestorOrigins')} (an opaque one leaves it undecided)` : `undecided (no ${code('location.ancestorOrigins')}): dropped as well, ${(['worker', 'cooperative'] as const).map(mode => `${reachedEntries(mode, code)} in ${mode} mode`).join(', ')}`,
            withCode(entry.siteMeasured, code),
        ]);
    }),
)}`;

const carriersTable = () => table(
    ['Request', 'Where', 'Why the library cannot strip it'],
    COOKIE_CARRIER_IDS.map(id => {
        const carrier = COOKIE_CARRIERS[id];
        return row([carrier.request, carrierModes(carrier), carrier.unsentBy.length === 0 ? carrier.why : `${carrier.why} (${carrier.unsentBy.map(engine => facts(engine).name).join(', ')} sends none)`]);
    }),
);

export const cookieFacts: Extractor = {
    items: () => [
        // the values per engine and reach, and whether the engine honours the attribute: prose that states them follows these
        { id: 'cookie-facts', signature: signatureOf(COOKIE_ENGINES.map(engine => [engine, facts(engine).credentialless, facts(engine).sends, facts(engine).protectedBy?.sends ?? null, facts(engine).siteFrom, facts(engine).hasAncestorOrigins])), render: () => '' },
        // the requests that carry them
        { id: 'cookie-carriers', signature: signatureOf(COOKIE_CARRIER_IDS.map(id => [id, COOKIE_CARRIERS[id].modes, COOKIE_CARRIERS[id].unsentBy, COOKIE_CARRIERS[id].reaches])), render: () => '' },
    ],
    regions: {
        'cookie-facts': factsTable,
        'cookie-carriers': carriersTable,
        'host-site-facts': hostSiteTable,
        'cookie-sentence': () => cookieSentence(code),
    },
};
