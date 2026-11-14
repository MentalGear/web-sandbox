import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The element's source, for the tests that scan it: its class (src/host.ts), and the methods the network build installs
 * on its prototype (src/lib/network-host.ts, NetworkMethods; ADR-009). A scan of "what the element does" reads both; one
 * of what the default build's element does reads the class alone.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const ELEMENT_CLASS = 'src/host.ts';
export const NETWORK_METHODS = 'src/lib/network-host.ts';
export const ELEMENT_FILES = [ELEMENT_CLASS, NETWORK_METHODS] as const;

const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** The text of the element's class and of the network modes' methods, in that order. */
export const elementSource = (): string => ELEMENT_FILES.map(read).join('\n');

/** The names of the methods the network build installs on the element. */
export const networkMethodNames = (): string[] => {
    const text = read(NETWORK_METHODS);
    const body = text.slice(text.indexOf('\nexport class NetworkMethods '));
    return [...body.matchAll(/^ {4}(?:private )?(\w+)\(/gm)].map(match => match[1]!);
};
