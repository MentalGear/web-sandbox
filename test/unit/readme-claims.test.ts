import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFetchPolicy } from '@src/lib/fetch-bridge';

/**
 * Small claims of the README that the code decides and a sentence once got wrong (S74 board, pass 3; class C, docs of a
 * rule that one place decides). Each claim is held against the code that decides it, and the sentence that said it wrongly
 * is gone.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
const API = readFileSync(path.join(ROOT, 'docs/API.md'), 'utf8').replace(/\s+/g, ' ');

describe('BD3:DOC-9: `fetchBridge.methods` replaces the default list', () => {
    const policy = (methods: unknown) => toFetchPolicy({ allow: ['https://api.example'], methods }, () => {})!;

    it('in the code: `methods: [\'PUT\']` refuses GET; left out, the default is GET, HEAD and POST', () => {
        expect(policy(['PUT']).methods).toEqual(['PUT']);
        expect(toFetchPolicy({ allow: ['https://api.example'] }, () => {})!.methods).toEqual(['GET', 'HEAD', 'POST']);
    });

    it('in the README, as in API.md, and not as an addition to the default', () => {
        expect(README).toContain("`methods` replaces that list (`['PUT']` allows `PUT` alone)");
        expect(README).not.toContain('plus `PUT`, `PATCH`, `DELETE` if listed in `methods`');
        expect(API).toContain('Replaces the default list.');
    });
});

describe('BD3:DOC-2: the strict renderer drops an `http:` URL of a listed `https:` origin', () => {
    // (the renderer's own test is src/lib/in-sandbox-view.test.ts, "URL attributes keep only http(s)…"; no-plaintext.spec.ts runs it on the engines)
    it('the README says it as API.md does, and no longer says the image may name the https origin', () => {
        expect(README).toContain('an `http:` URL of a listed `https:` origin is dropped: no engine admits it');
        expect(README).not.toContain("may name a listed `https:` one");
        expect(API).toContain('an `http:` URL of a listed `https:` origin is refused by every engine, so it is dropped');
    });
});
