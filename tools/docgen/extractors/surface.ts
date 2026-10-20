/**
 * Items for the parts of docs/API.md that stay handwritten but state what code declares: the events, the refusal codes
 * and the guest-facing lists. A section that describes one carries a marker (docgen/engine.ts), so a change to the
 * declaration fails the check until the section has been read. None has a region: the rows' meanings are prose, and no
 * value in the code holds them.
 */
import { ELEMENT_EVENTS } from '../../../src/lib/element-events';
import { FILE_ERROR_CODES } from '../../../src/lib/files';
import { FETCH_ERROR_CODES } from '../../../src/lib/fetch-bridge';
import { RPC_ERROR_CODES } from '../../../src/lib/rpc';
import { ORIGIN_KINDS } from '../../../src/lib/csp/origins';
import { KIND_DIRECTIVES } from '../../../src/lib/csp/csp-generator';
import { WORKER_GLOBALS } from '../../../src/lib/worker-globals';
import { signatureOf } from '../engine';
import type { Extractor } from './markdown';

const none = () => '';

export const surface: Extractor = {
    regions: {},
    items: () => [
        { id: 'events', signature: signatureOf(ELEMENT_EVENTS), render: none },
        { id: 'codes:rpc', signature: signatureOf(RPC_ERROR_CODES), render: none },
        { id: 'codes:fetch', signature: signatureOf(FETCH_ERROR_CODES), render: none },
        { id: 'codes:files', signature: signatureOf(FILE_ERROR_CODES), render: none },
        { id: 'origins', signature: signatureOf(ORIGIN_KINDS.map(kind => [kind, KIND_DIRECTIVES[kind]])), render: none },
        { id: 'worker-globals', signature: signatureOf(WORKER_GLOBALS), render: none },
    ],
};
