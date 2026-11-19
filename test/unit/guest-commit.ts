import { parseCommitArguments, type GuestWrite, type GuestWrites, type MintedWrites } from '@src/lib/guest-writes';

/** The element's side of a commit, as a test drives it: list the pending writes, and commit the values it returned. */
export interface Committing {
    listGuestWrites(): GuestWrite[];
    commitGuestWrites(writes: readonly GuestWrite[], options?: { code?: boolean }): boolean;
}

// The values of `listed` at `paths`; a path with nothing pending names no value.
function listedAt(listed: readonly GuestWrite[], paths: readonly string[]): GuestWrite[] {
    const chosen: GuestWrite[] = [];
    for (const write of listed) {
        if (paths.includes(write.path)) chosen.push(write);
    }
    return chosen;
}

/**
 * Lists the element's pending writes and commits the values listed at `paths`, in one synchronous task: how a test whose
 * subject is not the commit commits what is pending at those paths.
 */
export function commitAt(el: Committing, paths: readonly string[], options?: { code?: boolean }): boolean {
    return el.commitGuestWrites(listedAt(el.listGuestWrites(), paths), options);
}

/**
 * The same on an overlay of its own (createGuestWrites with `minted`): lists it, takes the entries of the values at
 * `paths` as the element's commitGuestWrites() does, and commits them. Returns what the overlay's commit returns.
 */
export function commitOverlayAt(writes: GuestWrites, minted: MintedWrites, paths: readonly string[], code: boolean): string[] | null {
    const { entries } = parseCommitArguments(listedAt(writes.list(), paths), undefined, minted);
    return writes.commit(entries, code);
}
