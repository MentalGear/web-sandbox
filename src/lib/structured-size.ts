/**
 * The one measure of the byte budgets on log lines and RPC messages (review round 1, R3-3): a bounded estimate of how
 * many bytes structured clone would copy for a value. Measured where a message is made (the guest's console relay
 * and both brokers) and again where it arrives, so neither side has to trust the other's measure.
 *
 * `createSizeOf()` captures every primitive it uses when it is called, and returns the measure. The bootstrap calls it
 * before any guest code runs (it is stringified into the guest like createBroker, so it closes over nothing), so guest
 * code that replaces Object.keys, Array.isArray, a getter or a prototype method later cannot change what a value
 * measures. The walk reads what structured clone reads (own enumerable properties, Map and Set entries, the bytes of
 * an ArrayBuffer or of a view's whole buffer, which clone copies), each object once, and stops as soon as the estimate
 * passes `limit`: its work is bounded by the limit, whatever the value (100 000 keys, a 64 MiB buffer, a cycle).
 *
 * The estimate is in bytes: a string counts two per UTF-16 code unit plus 8, a key the same, every other primitive 8,
 * an object 16 plus its entries, a buffer its byteLength, a Blob 64 (clone copies a handle, not its bytes). It never
 * throws: a value whose reading throws (a getter, a revoked Proxy) measures Infinity, past every limit, as structured
 * clone would refuse it too. Reading a property runs its getter, and a Proxy's traps, as structured clone does.
 */
export type SizeOf = (value: unknown, limit: number) => number;

export function createSizeOf(): SizeOf {
    const apply = Reflect.apply;
    const keysOf = Object.keys;
    const setPrototype = Object.setPrototypeOf;
    const getter = (proto: object, name: string): ((this: unknown) => unknown) | null => {
        for (let p: object | null = proto; p; p = Object.getPrototypeOf(p)) {
            const descriptor = Object.getOwnPropertyDescriptor(p, name);
            if (descriptor && descriptor.get) return descriptor.get;
        }
        return null;
    };
    // Brand checks through the platform's own getters: each throws for anything that is not one, in any realm.
    const bufferBytes = getter(ArrayBuffer.prototype, 'byteLength');
    const typedArrayBuffer = getter(Uint8Array.prototype, 'buffer');
    const dataViewBuffer = typeof DataView === 'function' ? getter(DataView.prototype, 'buffer') : null;
    const mapSize = getter(Map.prototype, 'size');
    const setSize = getter(Set.prototype, 'size');
    const mapForEach = Map.prototype.forEach;
    const setForEach = Set.prototype.forEach;
    const blobSize = typeof Blob === 'function' ? getter(Blob.prototype, 'size') : null;
    const SetConstructor = Set;
    const setHas = Set.prototype.has;
    const setAdd = Set.prototype.add;
    const brand = (read: ((this: unknown) => unknown) | null, value: object): unknown => {
        if (!read) return undefined;
        try {
            return apply(read, value, []);
        } catch {
            return undefined;
        }
    };

    return (value: unknown, limit: number): number => {
        let total = 0;
        try {
            // A list without a prototype (review C3): an index written to it never reaches an inherited setter.
            const stack: unknown[] = setPrototype([], null);
            stack[0] = value;
            const seen = new SetConstructor();
            while (stack.length > 0 && total <= limit) {
                const item = stack[stack.length - 1];
                stack.length = stack.length - 1;
                const type = typeof item;
                if (type === 'string') {
                    total += 2 * (item as string).length + 8;
                    continue;
                }
                if (item === null || type !== 'object') {
                    total += 8; // number, boolean, undefined, bigint; a symbol or function, which clone refuses anyway
                    continue;
                }
                const object = item as object;
                if (apply(setHas, seen, [object])) {
                    total += 8;
                    continue;
                }
                apply(setAdd, seen, [object]);
                total += 16;
                const bytes = brand(bufferBytes, object);
                if (typeof bytes === 'number') {
                    total += bytes;
                    continue;
                }
                const buffer = brand(typedArrayBuffer, object) ?? brand(dataViewBuffer, object);
                if (buffer !== undefined) {
                    const whole = brand(bufferBytes, buffer as object); // clone copies the view's whole buffer
                    total += typeof whole === 'number' ? whole : 0;
                    continue;
                }
                if (typeof brand(blobSize, object) === 'number') {
                    total += 64;
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
                const keys = keysOf(object);
                for (let i = 0; i < keys.length && total <= limit; i++) {
                    const key = keys[i]!;
                    total += 2 * key.length + 8;
                    stack[stack.length] = (object as Record<string, unknown>)[key];
                }
            }
        } catch {
            return Infinity;
        }
        return total;
    };
}
