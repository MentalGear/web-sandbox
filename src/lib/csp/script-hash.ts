/**
 * The CSP hash-source of a script, computed synchronously on the host (strict mode, ADR-005).
 *
 * Strict mode admits exactly one script in its view document, the library's bootstrap, by its SHA-256
 * hash. The hash is computed here, synchronously, when the first strict view is built, and cached by
 * the caller. Synchronous on purpose: crypto.subtle.digest() returns a promise, and building an
 * environment is synchronous end to end (setConfig(), load(), reset() and the element's lifecycle
 * invariants in ADR-003 rely on that); a build-time constant was rejected too, because the bootstrap is
 * the text of library functions, which differs between the dev server, the bundle and a consumer's
 * build. Hashing the text at run time always matches what this page actually serves.
 *
 * What is hashed (research 15, P2): the browser hashes the script's text AS PARSED, encoded as UTF-8.
 * Non-ASCII, "<", "&" and quotes survive the srcdoc attribute decoding unchanged, but the HTML parser
 * turns CR LF and lone CR into LF and NUL into U+FFFD. So the caller must hand this function the parsed
 * text; for the bootstrap that is the authored text, because hashedScriptText() refuses any text with
 * a CR or a NUL in it (amendment A3).
 *
 * Host-side only, never stringified into a guest, so it may use module scope freely.
 */

// The first 32 bits of the fractional parts of the cube roots of the first 64 primes (FIPS 180-4, 4.2.2).
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 of `bytes` (FIPS 180-4), as 32 bytes. */
export function sha256(bytes: Uint8Array): Uint8Array {
    // padding: 0x80, zeros, then the bit length as a 64-bit big-endian integer, to a multiple of 64 bytes
    const blocks = Math.ceil((bytes.length + 9) / 64);
    const padded = new Uint8Array(blocks * 64);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    const bitLength = bytes.length * 8;
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(padded.length - 4, bitLength >>> 0);

    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let t = 0; t < 16; t++) w[t] = view.getUint32(offset + t * 4);
        for (let t = 16; t < 64; t++) {
            const w15 = w[t - 15]!, w2 = w[t - 2]!;
            const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
            const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
            w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
        }
        let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
        for (let t = 0; t < 64; t++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[t]! + w[t]!) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
        h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
    }
    const digest = new Uint8Array(32);
    const out = new DataView(digest.buffer);
    for (let i = 0; i < 8; i++) out.setUint32(i * 4, h[i]!);
    return digest;
}

const toBase64 = (bytes: Uint8Array) => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
};

/**
 * Throws unless `text` is its own parsed form: the HTML parser changes CR (alone or before LF) and NUL
 * inside a <script>, so a hash over such a text would never match what the browser hashes (A3). Also
 * refuses anything that could end or re-enter the script element while the view document is parsed
 * ("</script", "<!--", "<script"), so the parser's script text is exactly `text`.
 */
export function assertHashableScript(text: string): void {
    if (/[\r\u0000]/.test(text)) throw new Error('[Sandbox] a hashed script must not contain CR or NUL: the HTML parser changes them, so its hash would never match');
    if (/<\/script|<!--|<script/i.test(text)) throw new Error('[Sandbox] a hashed script must not contain "</script", "<script" or "<!--": its parsed text would differ from its source');
}

/** The CSP hash-source for a script whose parsed text is `text`: `'sha256-<base64>'`. */
export function scriptHashSource(text: string): string {
    assertHashableScript(text);
    return `'sha256-${toBase64(sha256(new TextEncoder().encode(text)))}'`;
}
