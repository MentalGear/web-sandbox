/** docs/API.md's list of the text a guest chooses, from the registry of values the API hands the embedder (src/lib/guest-values.ts). */
import { signatureOf } from '../engine';
import { GUEST_VALUES, guestText } from '../../../src/lib/guest-values';
import { code, row, table, type Extractor } from './markdown';

export const guestValues: Extractor = {
    regions: {
        'guest-text': () => table(['Text the guest chooses', 'Where'], guestText().map(text => row([text.phrase, text.builds === 'every' ? code(text.at) : `${code(text.at)} (the build with the network modes)`]))),
    },
    items: () => [{ id: 'guest-values', signature: signatureOf(GUEST_VALUES), render: () => '' }],
};
