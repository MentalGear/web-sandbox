import { expect } from 'vitest';
import { registeredDocumentUrl } from '@src/lib/document-url';
import { SEALED_VIEW_FLAGS, sealedDocument, sealedDocumentPolicy } from '@src/lib/sealed-document';

/**
 * Sealed mode's view as the element frames it in jsdom (design 03, "The shape"): F, a frame of the registered
 * documentUrl, which holds C, the view, in the served file's static markup. jsdom loads no frame, so what C is and runs
 * under is read from the file the build serves (sealedDocument()), and what the element decides is read from F's frame:
 * its URL, its flags, its referrer policy. Strict mode's view is a srcdoc document the element writes, read from there.
 */

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

/** The element's frame: F for sealed mode, the wrapper for strict mode. */
export const frameOf = (el: HTMLElement): HTMLIFrameElement => (el.shadowRoot ?? el).querySelector('iframe')!;

/** Whether the element's frame is the served file: a frame of the registered documentUrl, with no srcdoc. */
export function isServed(frame: HTMLIFrameElement): boolean {
    const url = registeredDocumentUrl();
    return url !== null && frame.getAttribute('src') === url && !frame.hasAttribute('srcdoc');
}

/** C's frame element as the served file holds it. */
export const servedViewFrame = (): HTMLIFrameElement => parse(sealedDocument()).querySelector('iframe')!;

/**
 * The flags of the element's frame and of the view inside it, as [frame, view]. A served view's are its static attribute
 * narrowed by F's: a nested frame has the restrictions of every frame above it (design 03, "The sandbox flags").
 */
export function frameAndViewFlags(el: HTMLElement): [string | null, string | null] {
    const frame = frameOf(el);
    const flags = frame.getAttribute('sandbox');
    if (!isServed(frame)) return [flags, parse(frame.srcdoc).querySelector('iframe')!.getAttribute('sandbox')];
    const granted = new Set((flags ?? '').split(' '));
    expect(servedViewFrame().getAttribute('sandbox')).toBe(SEALED_VIEW_FLAGS.join(' '));
    const effective: string[] = [];
    for (const flag of SEALED_VIEW_FLAGS) if (granted.has(flag)) effective.push(flag);
    return [flags, effective.join(' ')];
}

/** The policy the view runs under: the served file's constant one, or the one in a srcdoc view's document. */
export function viewPolicyOf(el: HTMLElement): string {
    const frame = frameOf(el);
    if (isServed(frame)) return sealedDocumentPolicy();
    const view = parse(parse(frame.srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!);
    return view.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
}

/**
 * The view's announcement, played by hand where jsdom cannot run the served file (it loads no frame): the reducer's
 * `viewAnnounced`, from a window that stands for the first frame of the element's frame, which records what the element
 * posts to it. Returns that record: INIT_VIEW and its ports, once the element answered.
 */
export function announceView(el: any): { posted: { data: any; ports: MessagePort[] }[] } {
    const record = { posted: [] as { data: any; ports: MessagePort[] }[] };
    const view = { postMessage: (data: unknown, _origin: string, ports: MessagePort[] = []) => record.posted.push({ data, ports }) };
    el._step({ t: 'viewAnnounced', gen: el._lc.gen, source: view, finding: null }); // the version and the verdicts its own (startup-verdicts.ts)
    return record;
}
