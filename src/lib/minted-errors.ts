/**
 * The errors the library makes in the host's realm, and what a guest receives for each (BD6:LIM-1, BD7:CHL-2; class P,
 * what crosses is what the API shows). A host method that lets a library error propagate (`await el.call(…)`,
 * `el.registerFiles(…)`, a relay of another element's refusal, with no catch) hands that error to the host's broker as
 * its failure. The broker never reads such an error for the guest's text: it asks {@link crossingText}, which answers the
 * text chosen when the error was made, from a fixed table and the error's code, never from its message:
 *   - an error with a code (mintError): the code, `: ` and that code's one text in CROSSING_TEXTS;
 *   - one without (mintUncodedError: the TypeError of a bad argument, an invariant): `the method failed (<name>)`, as for
 *     any throw that is not the embedder's own.
 * The message stays as detailed as the library's caller needs (it may quote the caller's path, a method name or another
 * side's text, which is why it never crosses), and the host's broker hands it to the host's console (`reportWithheld`).
 *
 * So every error the library makes in host-realm code is made here: a source scan (test/unit/structural.test.ts) fails
 * on any other construction of an error in src/ outside the functions the library stringifies into a guest's realm. The
 * host's broker makes its own refusals here too, through its `host.mint` option (rpc.ts, codedError), refusals that
 * carry the other side's text included. Module state of the host realm; the guest's broker has none.
 */
import type { RpcErrorCode, RpcLibraryCode } from './rpc';

/** Every code an error of the library carries: the broker's, the files' and the fetch bridge's. */
export type LibraryErrorCode = RpcErrorCode | RpcLibraryCode;

/**
 * The one text a guest receives, after the code, for a library error with that code that a host method lets propagate.
 * Fixed: no part of it is ever composed from data.
 */
export const CROSSING_TEXTS = {
    TIMEOUT: 'a call timed out',
    TERMINATED: 'a sandbox was reset or terminated',
    ARGS_NOT_TRANSFERABLE: 'the arguments of a call could not be carried',
    SEND_FAILED: 'a call could not be sent',
    INVALID_CALL: 'a call named no valid method',
    UNKNOWN_METHOD: 'a call named a method that is not exposed',
    HANDLER_ERROR: 'a called method failed',
    RESULT_NOT_TRANSFERABLE: 'the result of a call could not be carried',
    BUSY: 'too many calls at once; retry later',
    FETCH_NOT_ALLOWED: 'the fetch bridge does not allow the request',
    FETCH_BUSY: 'too many requests at once; retry later',
    FETCH_REDIRECT: 'the response was a redirect, which the fetch bridge never follows',
    FETCH_TOO_LARGE: 'the request or the response is larger than the fetch bridge allows',
    FETCH_TIMEOUT: 'no whole response arrived in time; retry later',
    FETCH_FAILED: 'the request failed',
    INVALID_PATH: 'a path is not valid',
    INVALID_FILE: 'a file is not valid',
    FILES_QUOTA_EXCEEDED: 'the files would exceed their quota',
    FILES_NOT_ALLOWED: 'the change to the files is not allowed',
    FILES_BUSY: 'too many writes at once; retry later',
} as const satisfies { readonly [C in LibraryErrorCode]: string };

/** A library error with an own `code`, as mintError makes it. */
export type CodedError<C extends LibraryErrorCode> = Error & { code: C };

// What crosses for each error made here, chosen when it was made.
const crossing = new WeakMap<object, string>();

// An error name kept in `the method failed (<name>)`: an identifier of at most 64 characters, as the host's broker keeps
// one (rpc.ts, errorName).
const NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

// The text of an error without a code: its name, the library's own class's, else "Error".
const failedText = (name: unknown) => `the method failed (${typeof name === 'string' && NAME.test(name) ? name : 'Error'})`;

// The text of a code: its fixed text, or, for a value outside the table (none of the library's), an uncoded error's.
const codedText = (code: unknown) => (typeof code === 'string' && Object.hasOwn(CROSSING_TEXTS, code) ? `${code}: ${CROSSING_TEXTS[code as LibraryErrorCode]}` : failedText('Error'));

/**
 * An `Error` of the library with an own `code`; a guest receives `<code>: <CROSSING_TEXTS[code]>` for it, never
 * `message`.
 *
 * @param code - Why it was made, from the table.
 * @param message - The text for the library's caller, as detailed as that caller needs.
 * @param cause - An engine's error that caused it: a non-enumerable own `cause`, never read for a guest.
 */
export function mintError<C extends LibraryErrorCode>(code: C, message: string, cause?: unknown): CodedError<C> {
    const text = codedText(code);
    const error = new Error(message) as CodedError<C>;
    Object.defineProperty(error, 'code', { value: code, writable: true, enumerable: true, configurable: true });
    if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause, writable: true, enumerable: false, configurable: true });
    crossing.set(error, text);
    return error;
}

/**
 * An error of the library's class `Kind` with no code (the TypeError of a bad argument, an invariant); a guest receives
 * `the method failed (<its name>)` for it, never its message.
 *
 * @param Kind - The error class: a built-in one or the library's own subclass.
 * @param argument - What `Kind` is constructed with: the message, or what its constructor takes in its place.
 */
export function mintUncodedError<A, E extends Error>(Kind: new (argument: A) => E, argument: A): E {
    const error = new Kind(argument);
    crossing.set(error, failedText(error.name));
    return error;
}

/** What a guest receives for `error` when it is one of the library's, else null. Never throws, whatever the value. */
export function crossingText(error: unknown): string | null {
    if (typeof error !== 'object' || error === null) return null;
    return crossing.get(error) ?? null;
}
