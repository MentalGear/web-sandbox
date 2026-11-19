/**
 * The reading of `start(app, grants)`'s two arguments (design 01, "start(app, grants)"; I2, I17): everything is
 * validated before anything is stored, and validation returns the values the element stores. Nothing here touches an
 * element, so a reading that throws leaves the element as it was, and the embedder's objects are not kept: each value
 * is read once, the options are copied, the files are copied into a store of their own, and the methods into a frozen
 * record with no prototype.
 *
 * The app and the grants are two arguments, each read by its own keys: the app's are its options in CONFIG_SCHEMA
 * (`owner: 'app'`) and `files`, the grants' the embedder's options and `methods`. A key of the other argument, or one
 * neither knows, is refused before any value is read.
 *
 * What it refuses is what the host page can decide without parsing guest text: the shape and type of each option, each
 * path and the quota over the bytes given (the file store's rules), an `entry` that names no JavaScript file given, and
 * each method. A TypeError for the options, the methods and a key, a FileError for the files.
 *
 * Host-side only, never stringified into the guest.
 */
import type { HostMethod } from '../host';
import { APP_OPTIONS, ConfigRefusal, EMBEDDER_OPTIONS, hasStrictView, normaliseConfig, unknownModeReason, type HostPage, type NormalisedConfig, type OptionName } from './config-schema';
import { shown } from './csp/origin-kinds';
import { fileError, FileStore, isJavaScriptType } from './files';
import { mintUncodedError } from './minted-errors';
import { networkModes } from './network-modes';
import { errorName, fixedDetail, joinDetails, reasonText } from './reasons';
import type { LimitValue } from './limits';
import { RESERVED_METHOD_PREFIX } from './rpc';

/** The app's key besides its options: its files. */
export const APP_FILES_KEY = 'files';
/** The grants' key besides the embedder's options: the host methods. */
export const GRANT_METHODS_KEY = 'methods';

// the broker's longest method name (rpc.ts, MAX_NAME_LENGTH; R3:C-1): a longer one could never be called
const METHOD_NAME_MAX_LENGTH: LimitValue<'MAX_NAME_LENGTH'> = 256;

/** One of start()'s two arguments: its name in a refusal, and the keys it takes. */
interface Argument {
    readonly name: 'app' | 'grants';
    readonly position: 'first' | 'second';
    readonly keys: readonly string[];
}

const APP_ARGUMENT: Argument = Object.freeze({ name: 'app', position: 'first', keys: Object.freeze([...APP_OPTIONS, APP_FILES_KEY]) });
const GRANTS_ARGUMENT: Argument = Object.freeze({ name: 'grants', position: 'second', keys: Object.freeze([...EMBEDDER_OPTIONS, GRANT_METHODS_KEY]) });

/** What start() stores: the normalised options, the app's files, its host methods, and the warnings to say once bound. */
export interface StartValues {
    readonly normalised: NormalisedConfig;
    readonly files: FileStore;
    readonly methods: Readonly<Record<string, HostMethod>>;
    readonly warnings: readonly string[];
}

/** An argument's own values, by key, each read once. */
type Fields = Readonly<Record<string, unknown>>;

const NO_FIELDS: Fields = Object.freeze(Object.create(null));

const START_PREFIX = '[Sandbox] start(): ';
const refusal = (message: string) => mintUncodedError(TypeError, `${START_PREFIX}${message}`);

/**
 * Reads start()'s arguments into the values the element stores, or throws a TypeError or a FileError. Runs the
 * embedder's code (a getter or a Proxy trap of the arguments) and nothing of the element's.
 */
export function readStart(app: unknown, grants: unknown, hostPage: HostPage): StartValues {
    const appFields = readArgument(app, APP_ARGUMENT, GRANTS_ARGUMENT);
    const grantFields = grants === undefined ? NO_FIELDS : readArgument(grants, GRANTS_ARGUMENT, APP_ARGUMENT);
    const { normalised, warnings } = readOptions(appFields, grantFields, hostPage);
    const files = readFiles(appFields[APP_FILES_KEY]);
    checkEntry(normalised, files);
    const methods = readMethods(grantFields[GRANT_METHODS_KEY]);
    return { normalised, files, methods, warnings };
}

/**
 * One argument's own enumerable string keys, each checked before any value is read, then each value read once. A
 * value left `undefined` is an option left out.
 */
function readArgument(value: unknown, own: Argument, other: Argument): Fields {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw refusal(`the ${own.name} (the ${own.position} argument) must be an object, not ${shown(value)}.`);
    const keys = Object.keys(value);
    for (const key of keys) checkKey(key, own, other);
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
        const field = (value as Record<string, unknown>)[key];
        if (field !== undefined) fields[key] = field;
    }
    return fields;
}

function checkKey(key: string, own: Argument, other: Argument) {
    if (own.keys.includes(key)) return;
    if (other.keys.includes(key)) throw refusal(`${shown(key)} belongs to the ${other.name}, the ${other.position} argument, not to the ${own.name}.`);
    throw refusal(`the ${own.name} has no key ${shown(key)}; it takes ${own.keys.join(', ')}.`);
}

/**
 * The options of both arguments, copied one by one (structured clone) and normalised by the schema as start() reads
 * it: a value an option cannot take, a refusal of the schema's own (a network mode in a build without them, a sealed
 * config that opens the network or runs strings as code, an `html` longer than one render) and a mode that is no mode
 * each throw.
 */
function readOptions(appFields: Fields, grantFields: Fields, hostPage: HostPage): { normalised: NormalisedConfig; warnings: readonly string[] } {
    const copy = copiedOptions(appFields, grantFields);
    const { value, warnings, refusal: refused } = normaliseConfig(copy, hostPage, 'start');
    if (value === null) throw startRefusal(refused);
    const unknownMode = unknownModeReason(value.config.mode);
    if (unknownMode !== null) throw refusal(`${unknownMode}.`);
    return { normalised: value, warnings };
}

/** Both arguments' options in one object, each copied (structured clone): what the config schema reads. */
function copiedOptions(appFields: Fields, grantFields: Fields): Record<string, unknown> {
    const copy: Record<string, unknown> = {};
    for (const name of [...APP_OPTIONS, ...EMBEDDER_OPTIONS]) {
        const fields = APP_OPTIONS.includes(name) ? appFields : grantFields;
        if (Object.hasOwn(fields, name)) copy[name] = copied(name, fields[name]);
    }
    return copy;
}

function copied(name: OptionName, value: unknown): unknown {
    try {
        return structuredClone(value);
    } catch (error) {
        throw refusal(`${name} cannot be copied (${errorName(error)}): an option holds data only (no function, Proxy or DOM node).`);
    }
}

// What the schema refused, as start() throws it: its own TypeError, said as start()'s where it is not yet (the options
// were copied before the schema read them, so a TypeError here is the library's own text, never the embedder's), a
// refusal with a reason of the library's as that reason, anything else as the configuration that could not be used,
// named as the element's refusal names it.
function startRefusal(refused: unknown): TypeError {
    if (refused instanceof TypeError) return refused.message.startsWith(START_PREFIX) ? refused : refusal(`${refused.message}.`);
    if (refused instanceof ConfigRefusal) return refusal(`${refused.reason}.`);
    return refusal(`${reasonText('configRefused', joinDetails(errorName(refused), networkModes()?.refusalDetail(refused) ?? fixedDetail('')))}.`);
}

/** The app's files, validated as one batch by the file store's rules, into a store of their own. */
function readFiles(files: unknown): FileStore {
    const store = new FileStore();
    if (files === undefined) return store;
    if (typeof files !== 'object' || files === null || Array.isArray(files)) throw fileError('INVALID_FILE', `start() expects the app's files as an object mapping paths to file contents, not ${shown(files)}.`);
    store.apply({ put: new Map(Object.entries(files)) }, 'start()');
    return store;
}

/** Where the mode runs an entry (strict and sealed), it names a JavaScript file of the app's. */
function checkEntry({ config }: NormalisedConfig, files: FileStore) {
    const entry = config.entry;
    if (!hasStrictView(config.mode) || entry === undefined || entry === '') return;
    const file = files.list().find(candidate => candidate.path === entry);
    if (file === undefined) throw refusal(`"entry" names no file of the app's files.`);
    if (!isJavaScriptType(file.type)) throw refusal(`"entry" names a file of the type ${file.type}, which is not JavaScript.`);
}

/**
 * The host methods: own enumerable string keys, each a name the broker can call (at most 256 characters, not `sandbox:`
 * reserved) and a function, read once into a frozen record with no prototype.
 */
function readMethods(methods: unknown): Readonly<Record<string, HostMethod>> {
    if (methods === undefined) return NO_FIELDS as Readonly<Record<string, HostMethod>>;
    if (typeof methods !== 'object' || methods === null || Array.isArray(methods)) throw refusal(`"methods" must be an object mapping names to functions, not ${shown(methods)}.`);
    const names = Object.keys(methods);
    for (const name of names) checkMethodName(name);
    const record: Record<string, HostMethod> = Object.create(null);
    for (const name of names) {
        const method = (methods as Record<string, unknown>)[name];
        if (typeof method !== 'function') throw refusal(`the method ${shown(name)} must be a function, not ${shown(method)}.`);
        record[name] = method as HostMethod;
    }
    return Object.freeze(record);
}

function checkMethodName(name: string) {
    if (name.length > METHOD_NAME_MAX_LENGTH) throw refusal(`the method name ${shown(name)}… is longer than ${METHOD_NAME_MAX_LENGTH} characters.`);
    if (name.startsWith(RESERVED_METHOD_PREFIX)) throw refusal(`method names starting with "${RESERVED_METHOD_PREFIX}" are reserved for the library; ${shown(name)} is one.`);
}
