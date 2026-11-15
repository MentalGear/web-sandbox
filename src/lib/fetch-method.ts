/**
 * The reserved method `sandboxFetch()` calls, and the refusal it answers with (ADR-006): every build has them. In sealed
 * mode, which has no network, the method refuses every request with `FETCH_NOT_ALLOWED` and makes none (ADR-008); the
 * bridge that serves it is the network modes' (fetch-bridge.ts).
 *
 * Host-side only, never stringified into a guest.
 */
import type { RpcLibraryCode } from './rpc';
import { mintError } from './minted-errors';

/** The method name the bridge is exposed under: reserved, so no exposed method can collide with it. */
export const FETCH_METHOD = 'sandbox:fetch';

/**
 * Why `sandboxFetch()` rejected: the rejection's `code`, and the `code` of a {@link FetchRecord}. Minted only by the host.
 * - `FETCH_NOT_ALLOWED`: refused before any request, because of the URL, the origin, the method, a header or the body.
 * - `FETCH_BUSY`: refused before any request, because `maxConcurrent` requests are already in flight. Retryable.
 * - `FETCH_REDIRECT`: the response was a redirect, which is never followed.
 * - `FETCH_TOO_LARGE`: the request body or the response body exceeds `maxBytes`.
 * - `FETCH_TIMEOUT`: no whole response within `timeoutMs`. Retryable.
 * - `FETCH_FAILED`: the request failed (network error, CORS), the bridge's frame could not start, or the sandbox was
 *   torn down. Retryable.
 */
export type FetchErrorCode = Extract<RpcLibraryCode, `FETCH_${string}`>;

/**
 * A refusal minted by the bridge: an Error with a library code. `reason`, when set, is the host's own account of a
 * refusal whose guest text says less; it goes to the record, never to the guest (the broker sends only the message
 * and the code).
 */
export type FetchRefusal = Error & { code: FetchErrorCode; reason?: string; unsent?: true };

/**
 * An Error with a library code, the only kind of refusal this module produces, made by the library's factory: the guest
 * receives its code and a fixed text, never `message` (BD7:CHL-2); the record's `reason` and the host's console have it.
 */
export function fetchRefusal(code: FetchErrorCode, message: string): FetchRefusal {
    return mintError(code, `[sandboxFetch] ${code}: ${message}`);
}
