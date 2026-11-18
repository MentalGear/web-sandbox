// Writes results/summary.md, one row per results/<id>.json: node summarize.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), 'results');
const TOOL_OF = { cdn: null, vite: 'vite', webpack: 'webpack', rollup: 'rollup', esbuild: 'esbuild', bun: 'bun', parcel: 'parcel', next: 'next' };

function yesNo(value) {
  return value === undefined ? 'n/a' : value ? 'yes' : 'NO';
}

function pathOf(result) {
  if (!result.url) return result.error ?? '';
  if (!result.url.startsWith('http')) return result.url.slice(0, 40);
  return new URL(result.url).pathname;
}

function rowOf(result) {
  const tool = TOOL_OF[result.app];
  const version = tool ? (result.versions?.[tool] ?? '') : '';
  const type = `${result.status ?? '-'} ${(result.contentType ?? '').split(';')[0]}`.trim();
  return `| ${result.id} | ${version} | \`${pathOf(result)}\` | ${type} | ${yesNo(result.bytesEqual)} | ${yesNo(result.iframe?.bytesEqual)} | ${yesNo(result.sameOrigin)} |`;
}

const files = readdirSync(RESULTS).filter((name) => name.endsWith('.json'));
const results = [];
for (const name of files) results.push(JSON.parse(readFileSync(join(RESULTS, name), 'utf8')));
results.sort((a, b) => a.id.localeCompare(b.id));
const rows = [];
for (const result of results) rows.push(rowOf(result));
const header = ['| case | tool version | URL path at run time | answer | bytes equal (fetch) | bytes equal (iframe navigation) | same origin as the app |', '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |'];
writeFileSync(join(RESULTS, 'summary.md'), `${[...header, ...rows].join('\n')}\n`);
console.log(`${rows.length} rows`);
