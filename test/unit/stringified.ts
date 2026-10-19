import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanned, STRINGIFIED, type StringifiedName } from '@src/lib/realms';

/**
 * The stringified functions a scan of the realms registry applies to (src/lib/realms.ts, STRINGIFIED), each with the
 * function itself, imported from the module the registry names: the scans read the text its toString() gives, the
 * compiled JavaScript a realm receives.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function stringifiedFor(scan: 'capture' | 'readOnce' | 'typeofRead'): Promise<[StringifiedName, (...args: any[]) => unknown][]> {
    const out: [StringifiedName, (...args: any[]) => unknown][] = [];
    for (const name of scanned(scan)) {
        const module = await import(path.join(ROOT, STRINGIFIED[name].module));
        const fn = module[name];
        if (typeof fn !== 'function') throw new Error(`${STRINGIFIED[name].module} exports no function ${name}`);
        out.push([name, fn]);
    }
    return out;
}
