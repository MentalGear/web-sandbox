/**
 * This repository's docs generator: the engine (engine.ts) with the extractors of extractors/. Run by
 * `bun run docs:gen` (write), `bun run docs:check` (--check) and `bun run docs:gen --accept`.
 */
import path from 'node:path';
import type { Plugin } from './engine';
import { run } from './run';
import { api } from './extractors/api';
import { budgets } from './extractors/budgets';
import { config } from './extractors/config';
import { connectFacts } from './extractors/connect-facts';
import { cookieFacts } from './extractors/cookie-facts';
import { csp } from './extractors/csp';
import { engineLedger } from './extractors/engine-ledger';
import { frames } from './extractors/frames';
import { inheritedContext } from './extractors/inherited-context';
import { lifecycle } from './extractors/lifecycle';
import { limits } from './extractors/limits';
import type { Extractor } from './extractors/markdown';
import { modules } from './extractors/modules';
import { reasons } from './extractors/reasons';
import { surface } from './extractors/surface';

export const EXTRACTORS: readonly Extractor[] = [api, budgets, config, connectFacts, cookieFacts, csp, engineLedger, frames, inheritedContext, lifecycle, limits, modules, reasons, surface];

export const plugin: Plugin = {
    extractors: {},
    regions: Object.assign({}, ...EXTRACTORS.map(extractor => extractor.regions)),
    describes: () => EXTRACTORS.flatMap(extractor => extractor.items()),
};

if (import.meta.main) process.exit(run(path.resolve(import.meta.dirname, '../..'), plugin, process.argv.slice(2)).exitCode);
