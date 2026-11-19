/**
 * The one measure of the byte budgets on log lines and RPC messages: how many bytes structured
 * clone copies for a value. Measured where a message is made (the guest's console relay and both brokers) and again
 * where it arrives (R1:R3-3), so neither side has to trust the other's measure.
 *
 * Exact by construction (S77): the snapshot is the one canonical form of a value that leaves a sandbox (a closed set of
 * kinds: the primitives, arrays, plain objects and the built-ins below; any other kind measures Infinity and is refused),
 * and every field it carries to the receiver is counted below. What is measured is what is posted, and what is posted is
 * what the receiver gets, so a budget never counts less than is delivered.
 *
 * What it measures is a SNAPSHOT (R2:C-3): a value that is already the result of a structured clone, as a
 * message is when it arrives, and as every sender makes one first, with a structuredClone captured before any guest
 * code ran; the sender then posts that snapshot, never the live value. Measuring the live value would let a getter answer the
 * measure small and the clone large, and reading only own enumerable keys is not what clone copies for most
 * types: an Error (its message and stack), a RegExp (its source), a BigInt (its digits) and the platform's objects
 * (an ImageData's pixels, in Firefox ~16 bytes by own keys) would cross past every budget. A snapshot holds no getter, no
 * Proxy and no function, so the walk is an allow-list of the types clone produces whose size it knows exactly:
 *   - a string: two bytes per UTF-16 code unit plus 8; a BigInt: its two's-complement bytes plus 8, by its hexadecimal
 *     digits, found without making anything larger than the limit; any other primitive 8;
 *   - a plain object (16): its own enumerable keys, each like a string, and their values; an array likewise, and besides
 *     its `length` times 8, whichever is more: a clone keeps a sparse array's length, and a walk to it costs that much, so
 *     one of 2**32 - 1 slots is past every limit however few elements it holds;
 *   - a Map or a Set: its entries; a Date 16; a RegExp its source like a string (the flags are at most 8 characters);
 *     a String, Number, Boolean or BigInt object like its primitive;
 *   - an ArrayBuffer: its byteLength; a typed array or a DataView: its whole buffer, which clone copies, once per buffer.
 * Anything else measures Infinity, past every limit (SNAPSHOT_REFUSED_KINDS names the ones a sender meets): a `Blob` or a
 * `File` (I7: a `blob:` URL the host page makes of one is a document of the host page's origin, so no guest value carries
 * one to the embedder's code; the guest sends bytes), an Error (its stack is the engine's to serialize), a platform
 * object (ImageData, ImageBitmap, FileList, CryptoKey, …), a SharedArrayBuffer, a function or a symbol (never in a
 * snapshot), or a value whose reading throws. Every guest value the host page receives is measured here before any code
 * of the embedder's sees it: a host method's arguments and a call's result (rpc.ts), a log line's arguments
 * (sandbox-log.ts). A sender that wants an error across sends what it needs of it: the console
 * relay sends every Error in a line as { name, message, stack } (in-sandbox-script.ts).
 *
 * Infinity says two things, and a sender's message must not confuse them (R3:C-3): a value really past the
 * limit, or a value the measure does not know, whatever its size. `unsupported`, when given, tells them apart: the walk
 * writes the kind it stopped at into `unsupported.kind` ('Error', 'ImageData', 'SharedArrayBuffer', from the value's
 * Object.prototype.toString tag), and leaves it alone when the limit was what it passed. So "past the byte budget" is
 * said only of a value that was, and an Error nested in a call's arguments reads "unsupported value: Error".
 *
 * `createSizeOf()` captures everything it uses when it is called, and returns the measure. The bootstrap calls it before
 * any guest code runs (it is stringified into the guest like createBroker, so it closes over nothing), so guest code that
 * replaces Object.keys, Array.isArray, a getter or a prototype method later cannot change what a value measures (R2:C-1: no
 * closure here reads a global or an intrinsic the guest can replace; a unit test scans the text). The walk visits each
 * object once and stops as soon as the estimate passes `limit`: its work is bounded by the limit, whatever the value. It
 * never throws. `buffers`, when given, receives every ArrayBuffer the walk counted, once each: what a sender may transfer
 * when it posts the snapshot, so its bytes are not copied a second time.
 */
export type SizeOf = (value: unknown, limit: number, buffers?: unknown[], unsupported?: { kind: string }) => number;

/**
 * The kinds a snapshot may hold, which the measure walks: a primitive by its `typeof` (`null` by itself), an object by its
 * `Object.prototype.toString` tag, and every typed array. The measure is the allow-list itself (it is stringified into
 * the guest's realm, so it reads no value of this module); test/unit/snapshot-kinds.test.ts measures a sample of each
 * kind, and every typed array the environment has, against it.
 */
export const SNAPSHOT_MEASURED_KINDS = [
    'string', 'number', 'boolean', 'bigint', 'undefined', 'null',
    'Array', 'Object', 'Map', 'Set', 'Date', 'RegExp', 'ArrayBuffer', 'DataView', 'typed array',
    'String', 'Number', 'Boolean', 'BigInt',
] as const;

/**
 * Kinds structured clone carries and the measure refuses, by their tag, each with why: past every limit, its kind named
 * (`unsupported value: Blob`). Any kind not in SNAPSHOT_MEASURED_KINDS is refused the same way; these are the ones a
 * sender meets. test/unit/snapshot-kinds.test.ts measures a sample of each, alone and at every place a container holds
 * one.
 */
export const SNAPSHOT_REFUSED_KINDS = {
    Blob: "it carries a type, and a `blob:` URL the host page makes of it is a document of the host page's origin (I7): the guest sends bytes, and the host page decides what they are",
    File: 'a `Blob` with a name (I7): the guest sends bytes',
    Error: "its stack is the engine's to serialize: the console relay sends an error's `name`, `message` and `stack` as strings",
    DOMException: 'an error, as `Error`',
    SharedArrayBuffer: 'clone shares its memory, or refuses it: never measured',
} as const;

export function createSizeOf(): SizeOf {
    // ---- The captured list (R2:C-1): everything the measure uses, taken now, before any guest code runs.
    const apply = Reflect.apply;
    const getOwn = Object.getOwnPropertyDescriptor;
    const protoOf = Object.getPrototypeOf;
    const keysOf = Object.keys;
    const isArray = Array.isArray;
    const setPrototype = Object.setPrototypeOf;
    const ObjectPrototype = Object.prototype;
    const SetConstructor = Set;
    const setHas = Set.prototype.has;
    const setAdd = Set.prototype.add;
    // Brand checks through the platform's own getters and methods: each throws for anything that is not one, in any realm.
    const bufferBytes = getOwn(ArrayBuffer.prototype, 'byteLength')!.get!;
    const typedArrayBuffer = getOwn(protoOf(Uint8Array.prototype), 'buffer')!.get!;
    const dataViewBuffer = getOwn(DataView.prototype, 'buffer')!.get!;
    const mapSize = getOwn(Map.prototype, 'size')!.get!;
    const setSize = getOwn(Set.prototype, 'size')!.get!;
    const mapForEach = Map.prototype.forEach;
    const setForEach = Set.prototype.forEach;
    const dateTime = Date.prototype.getTime;
    const regExpSource = getOwn(RegExp.prototype, 'source')!.get!;
    const stringValue = String.prototype.valueOf;
    const numberValue = Number.prototype.valueOf;
    const booleanValue = Boolean.prototype.valueOf;
    const bigintValue = BigInt.prototype.valueOf;
    const bigintText = BigInt.prototype.toString;
    const bigintFits = BigInt.asIntN;
    const toTag = Object.prototype.toString;
    const slice = String.prototype.slice;
    // The longest kind name a refusal gives (LIMITS.KIND_MAX_LENGTH: api-docs.test.ts keeps the value equal).
    const KIND_MAX_LENGTH = 64;
    const CAPTURE_POINT = 'nothing below reads a global, or an intrinsic guest code can replace';

    const brand = (read: (this: unknown) => unknown, value: unknown): unknown => {
        try {
            return apply(read, value, []);
        } catch {
            return undefined;
        }
    };
    // A BigInt's bytes: its hexadecimal digits, two to a byte, plus 8. Past `limit` bytes it is Infinity, decided by
    // asIntN, which makes nothing longer than the limit, before its digits are written out.
    const bigintBytes = (value: bigint, limit: number): number => {
        const bits = limit * 8 + 64;
        if (bits < 9007199254740991 && apply(bigintFits, undefined, [bits, value]) !== value) return Infinity;
        const digits = apply(bigintText, value, [16]) as string;
        return (digits.length + 1) / 2 + 8;
    };
    // A String, Number, Boolean or BigInt object: what its primitive measures, or undefined for any other object.
    const wrapped = (object: object, limit: number): number | undefined => {
        const text = brand(stringValue, object);
        if (typeof text === 'string') return 2 * text.length + 8;
        if (typeof brand(numberValue, object) === 'number' || typeof brand(booleanValue, object) === 'boolean') return 8;
        const big = brand(bigintValue, object);
        return typeof big === 'bigint' ? bigintBytes(big, limit) : undefined;
    };

    // The kind of a value the measure does not know: its tag's name, `Error` of `[object Error]`; its type for a primitive.
    // At most KIND_MAX_LENGTH characters: a tag is guest code's to choose (Symbol.toStringTag), and a sender's message names it.
    const kindOf = (value: unknown): string => {
        if (typeof value !== 'object' || value === null) return typeof value;
        try {
            const tag = apply(toTag, value, []) as string;
            return apply(slice, tag, [8, tag.length - 1 < 8 + KIND_MAX_LENGTH ? tag.length - 1 : 8 + KIND_MAX_LENGTH]) as string;
        } catch {
            return 'object';
        }
    };

    return (value: unknown, limit: number, buffers?: unknown[], unsupported?: { kind: string }): number => {
        let total = 0;
        // Infinity for a value the measure does not know, its kind noted for the sender's message.
        const unknown = (item: unknown): number => {
            if (unsupported) unsupported.kind = kindOf(item);
            return Infinity;
        };
        try {
            // A list without a prototype (AR:C3): an index written to it never reaches an inherited setter.
            const stack: unknown[] = setPrototype([], null);
            stack[0] = value;
            const seen = new SetConstructor();
            // A buffer counted once however many views share it, as clone copies it once; offered for transfer once.
            const countBuffer = (buffer: unknown) => {
                if (apply(setHas, seen, [buffer])) return;
                apply(setAdd, seen, [buffer]);
                const bytes = brand(bufferBytes, buffer);
                if (typeof bytes !== 'number') {
                    total = unknown(buffer); // a SharedArrayBuffer: clone shares it, or refuses it; never measured
                    return;
                }
                total += bytes;
                if (buffers) buffers[buffers.length] = buffer;
            };
            while (stack.length > 0 && total <= limit) {
                const item = stack[stack.length - 1];
                stack.length = stack.length - 1;
                const type = typeof item;
                if (type === 'string') {
                    total += 2 * (item as string).length + 8;
                    continue;
                }
                if (type === 'bigint') {
                    total += bigintBytes(item as bigint, limit);
                    continue;
                }
                if (item === null || type === 'number' || type === 'boolean' || type === 'undefined') {
                    total += 8;
                    continue;
                }
                if (type !== 'object') return unknown(item); // a function or a symbol: never in a snapshot
                const object = item as object;
                if (apply(setHas, seen, [object])) {
                    total += 8;
                    continue;
                }
                apply(setAdd, seen, [object]);
                total += 16;
                if (isArray(object) || protoOf(object) === ObjectPrototype) {
                    // charged by length, as the more of that and its keys: a sparse array's keys are few, its length is not.
                    // Past the limit by length alone, its keys are not even listed.
                    const slots = isArray(object) ? 8 * (object as unknown[]).length : 0;
                    if (total + slots > limit) {
                        total += slots;
                        break;
                    }
                    const start = total;
                    const keys = keysOf(object);
                    for (let i = 0; i < keys.length && total <= limit; i++) {
                        const key = keys[i]!;
                        total += 2 * key.length + 8;
                        stack[stack.length] = (object as Record<string, unknown>)[key];
                    }
                    if (total - start < slots) total = start + slots;
                    continue;
                }
                const bytes = brand(bufferBytes, object);
                if (typeof bytes === 'number') {
                    total += bytes;
                    if (buffers) buffers[buffers.length] = object;
                    continue;
                }
                const viewed = brand(typedArrayBuffer, object) ?? brand(dataViewBuffer, object);
                if (viewed !== undefined) {
                    countBuffer(viewed);
                    continue;
                }
                if (typeof brand(mapSize, object) === 'number') {
                    // an entry costs at least 16 here, so past the limit nothing more is pushed
                    apply(mapForEach, object, [(entry: unknown, key: unknown) => {
                        total += 16;
                        if (total > limit) return;
                        stack[stack.length] = key;
                        stack[stack.length] = entry;
                    }]);
                    continue;
                }
                if (typeof brand(setSize, object) === 'number') {
                    apply(setForEach, object, [(entry: unknown) => {
                        total += 8;
                        if (total <= limit) stack[stack.length] = entry;
                    }]);
                    continue;
                }
                if (typeof brand(dateTime, object) === 'number') continue;
                const source = brand(regExpSource, object);
                if (typeof source === 'string') {
                    total += 2 * source.length + 24;
                    continue;
                }
                const primitive = wrapped(object, limit);
                if (primitive === undefined) return unknown(object); // outside the allow-list: a Blob, a File, an Error, a platform object
                total += primitive;
            }
        } catch {
            if (unsupported) unsupported.kind = 'unreadable value';
            return Infinity;
        }
        return total;
    };
}
