/**
 * The host realm's passes over guest content, as data (S74, class A's third realm; class E-cpu): every function of the
 * library's host code that receives guest content, what it does with it, and the rule it is held to.
 *
 * Class A was closed for the guest's realms by enumeration (SEALED_REACH, sealed-reach.ts): every name a sealed guest
 * can reach, classified against every row of INHERITED_CONTEXT. The domain left out a third realm that handles guest
 * content: the host page's own, where the element runs. The browser consults the host page's policy wherever the host
 * realm parses or loads anything, its markup parser included (BD7:LIM-1: Chromium checked the guest's style attributes,
 * `<style>`s and `<base>` against the page's `style-src` and `base-uri`, and reported them, as the element read `html`
 * with DOMParser for a warning), and what the host realm does with guest content costs the host page's thread (BD7:LIM-2:
 * the entry scan was quadratic). So every such function is a row here, and each is held to one rule:
 *  - it is library code over strings and bytes, which hands nothing of the guest's to a platform parser, loader or
 *    policy-checked API: no DOMParser, no markup sink of any document, no `Image`, no stylesheet of the host realm, no
 *    URL loaded, no Trusted Types sink. A platform function that computes on its arguments alone (`URL` parsing,
 *    `TextDecoder`, `atob`, `structuredClone`, `postMessage`) is not one;
 *  - its cost is linear in what it takes, and a cap of the library's bounds what it takes.
 *
 * A row's `rule` says how it stands: `pure`, a pass held to both; `carries`, a function that hands guest content on
 * (posts it, stores it, dispatches it to the embedder) and makes no pass over it; `documented`, cooperative mode's own
 * host-side reading of its guest document, which is not the board's scope (S74: sealed mode, the default) and is stated
 * with why. test/unit/host-passes.test.ts follows guest content from where it enters (GUEST_ENTRIES) through the call
 * graph of src/ and fails on a function it reaches that no row names; fails when a platform parser, loader or markup
 * sink is reachable from a `pure` or `carries` row or from the view's frame builders (_prepareViewFrame,
 * _prepareSealedFrame), but for the library's own documents (LIBRARY_SINKS); and times every `pure` row on adversarial
 * shapes (scalingRatio), failing for a row it has no shapes for. SEALED_REACH classifies every row a sealed build runs
 * against every row of INHERITED_CONTEXT, as the third side of the class-A table (`host`).
 *
 * Values first: the units are the call graph's names (`file#name`; host.ts's element members as `src/host.ts#this.name`).
 * Internal: not exported from the package, and imported by tests and the docs only.
 */
import type { SandboxMode } from './config-schema';

/** The guest content the host realm receives. */
export const GUEST_CONTENT = {
    html: "the config's `html`, given to setConfig() or load(): the initial view, or cooperative mode's guest document",
    entry: 'the text of the registered file `entry` names (strict and sealed mode)',
    files: 'the registered files: their paths, types and bytes (registerFiles(), unregisterFiles(), a commit of guest writes)',
    writes: "the guest's writes and removals (`sandbox:write`): a path, a type and bytes",
    calls: "the guest's RPC frames: its requests and answers, with their values",
    lines: "the guest's log lines and uncaught errors",
    violations: "the violation reports of the guest's realm and of the view",
    viewFrames: "the view's frames: its check-in, its notes, the content's height, the guest's error texts it relays",
    fetches: "strict mode's `sandboxFetch()` requests, and the responses the bridge's frame gets for them",
    announcement: "cooperative and worker mode: the guest frame's announcement and its port",
} as const;
export type GuestContentId = keyof typeof GUEST_CONTENT;

/**
 * Where guest content enters the host realm: a member of the element, and the names in it that hold the content (its
 * parameters, or `this.…`, what it reads of the element's own state that holds it). Every member that reads such state
 * is one (GUEST_STATE).
 */
export interface GuestEntry {
    readonly member: string;
    readonly takes: readonly GuestContentId[];
    readonly holds: readonly string[];
}

/** The element's state that holds guest content: a member that reads one of these is an entry (GUEST_ENTRIES). */
export const GUEST_STATE = ['this._config.html', 'this._config.entry', 'this._configuring', 'this._lastConfig', 'this._files', 'this._strictInit', 'this._guestWrites'] as const;

export const GUEST_ENTRIES: readonly GuestEntry[] = [
    { member: 'setConfig', takes: ['html'], holds: ['config'] },
    { member: '_configure', takes: ['html'], holds: ['this._configuring'] },
    { member: 'load', takes: ['html'], holds: ['html'] },
    { member: 'registerFiles', takes: ['files'], holds: ['files', 'this._files'] },
    { member: 'unregisterFiles', takes: ['files'], holds: ['paths', 'this._files'] },
    { member: 'listFiles', takes: ['files'], holds: ['this._files'] },
    { member: 'listGuestWrites', takes: ['writes'], holds: ['this._guestWrites'] },
    { member: 'commitGuestWrites', takes: ['writes', 'files'], holds: ['paths', 'this._guestWrites'] },
    { member: '_startGuestWrites', takes: ['files'], holds: ['built', 'this._files'] },
    { member: '_discardGuestWrites', takes: ['writes'], holds: ['this._guestWrites'] },
    { member: '_handleGuestWrite', takes: ['writes'], holds: ['writes', 'request'] },
    { member: '_buildRefusal', takes: ['entry', 'files'], holds: ['this._files', 'this._config.entry'] },
    { member: '_prepareBuild', takes: ['html', 'entry', 'files'], holds: ['this._files'] },
    { member: '_prepareDocumentFrame', takes: ['html', 'files'], holds: ['built', 'files', 'this._config.html'] },
    { member: '_prepareViewFrame', takes: ['html', 'entry', 'files'], holds: ['built', 'files', 'this._config.entry', 'this._config.html'] },
    { member: '_attachBuild', takes: ['html', 'entry', 'files'], holds: ['prepared'] },
    { member: '_setupStrictChannels', takes: ['html', 'entry', 'files'], holds: ['this._strictInit'] },
    { member: '_teardown', takes: ['writes'], holds: ['this._guestWrites', 'this._strictInit'] },
    { member: '_listenForAnnouncement', takes: ['announcement'], holds: ['event'] },
    { member: '_onGuestMessage', takes: ['calls', 'lines', 'violations'], holds: ['data'] },
    { member: '_onViewMessage', takes: ['viewFrames', 'violations'], holds: ['data'] },
];

/** A row's standing (see the file comment). */
export const PASS_RULES = ['pure', 'carries', 'documented'] as const;
export type PassRule = (typeof PASS_RULES)[number];

export interface HostPass {
    /** What it does with the guest content it takes. */
    readonly does: string;
    readonly takes: readonly GuestContentId[];
    /** The modes whose builds, calls or messages run it. */
    readonly modes: readonly SandboxMode[];
    /** Its units in the call graph (test/unit/call-graph.ts): `file#name`, or `src/host.ts#this.member`. */
    readonly units: readonly string[];
    readonly rule: PassRule;
    /** What bounds its cost: linear in what it takes, and the cap on that. */
    readonly cost: string;
    /** `documented`: why it stays. */
    readonly why?: string;
}

const ALL: readonly SandboxMode[] = ['strict', 'sealed', 'cooperative', 'worker'];
const VIEW_MODES: readonly SandboxMode[] = ['strict', 'sealed'];
const FILES_CAP = 'linear in the files, which MAX_FILES (1000) and MAX_TOTAL_BYTES (8 MiB) cap';

export const HOST_PASSES = {
    configCopy: {
        does: "setConfig()'s argument is copied (structuredClone, so the embedder cannot change it later) and compared with the last one (sameData, at most SAME_DATA_MAX_PAIRS pairs): no parse of `html`, which is a string in it",
        takes: ['html'], modes: ALL, rule: 'pure',
        units: ['src/host.ts#this.setConfig', 'src/host.ts#sameData'],
        cost: "linear in the config; `html` is one string, which strict and sealed mode cap at VIEW_RENDER_MAX_LENGTH",
    },
    configSchema: {
        does: "the config schema reads each option by its own rule: `html`'s reads its type and, in strict and sealed mode, its length, and refuses one longer than VIEW_RENDER_MAX_LENGTH before it is stored (htmlRefusal: setConfig() and load() alike)",
        takes: ['html'], modes: ALL, rule: 'pure',
        units: [
            'src/host.ts#this._configure', 'src/host.ts#this._applyConfig', 'src/host.ts#this._warnConfig', 'src/host.ts#this.load', 'src/host.ts#this._buildContext',
            'src/lib/config-schema.ts#normaliseConfig', 'src/lib/config-schema.ts#htmlRefusal', 'src/lib/config-schema.ts#hasStrictView', 'src/lib/config-schema.ts#ignoredIn',
            'src/lib/config-schema.ts#readIn', 'src/lib/config-schema.ts#sealedNetworkRefusal', 'src/lib/config-schema.ts#sealedScriptUnsafeRefusal',
            'src/lib/utils.ts#defineData', 'src/lib/utils.ts#hasOwnField', 'src/lib/utils.ts#ownField',
        ],
        cost: "constant in `html`: its type and its length",
    },
    entryScan: {
        does: "the entry's registered bytes are decoded (atob, TextDecoder) and scanned for an import expression (dynamicImportAt): its text, never a parse of it",
        takes: ['entry'], modes: VIEW_MODES, rule: 'pure',
        units: ['src/host.ts#this._buildRefusal', 'src/host.ts#entryText', 'src/lib/entry-imports.ts#dynamicImportAt', 'src/lib/entry-imports.ts#pastTrivia', 'src/lib/entry-imports.ts#isLineEnd', 'src/lib/entry-imports.ts#isSpace', 'src/lib/files.ts#isJavaScriptType'],
        cost: `linear in the entry, one pass of its trivia from the right (BD7:LIM-2); ${FILES_CAP}`,
    },
    fileStore: {
        does: "registerFiles(), unregisterFiles() and a commit: each path checked against PATH_RULES (a URL parse of the path alone among them), a refusal minted with the rule it breaks, each entry's bytes copied and encoded, the quota counted; snapshot() orders the stylesheets after the files they name (one walk of the reference graph)",
        takes: ['files', 'writes'], modes: ALL, rule: 'pure',
        units: [
            'src/lib/files.ts#FileStore', 'src/lib/files.ts#checkPath', 'src/lib/files.ts#brokenPathRule', 'src/lib/files.ts#describePath', 'src/lib/files.ts#fileError', 'src/lib/minted-errors.ts#mintError', 'src/lib/files.ts#isStylesheetType',
            'src/lib/files.ts#isUint8Array', 'src/lib/files.ts#isValidPath', 'src/lib/files.ts#toBytes', 'src/lib/files.ts#toBase64', 'src/lib/files.ts#referenceCost', 'src/lib/files.ts#rewriteCost',
            'src/lib/files.ts#stronglyConnectedComponents', 'src/lib/load-kinds.ts#admits',
        ],
        cost: FILES_CAP,
    },
    moduleRewrite: {
        does: "a registered JavaScript file's relative specifiers, found by es-module-lexer (a library's lexer of the text) and resolved against the file's virtual URL (a URL parse of the specifier), become edits of its bytes",
        takes: ['files'], modes: ALL, rule: 'pure',
        units: ['src/lib/files.ts#rewriteModule', 'src/lib/files.ts#utf8Offsets', 'src/lib/files.ts#utf8Length', 'src/lib/module-specifiers.ts#moduleSpecifierEdits', 'src/lib/module-specifiers.ts#resolveModuleSpecifier'],
        cost: `linear in the file; ${FILES_CAP}`,
    },
    stylesheetReferences: {
        does: "a registered stylesheet's `url()` and `@import` references, found by the library's tokenizer (css-references.ts, a subset of css-syntax), become ranges of its bytes",
        takes: ['files'], modes: ALL, rule: 'pure',
        units: ['src/lib/files.ts#stylesheetReferences', 'src/lib/css-references.ts#cssUrlReferences', 'src/lib/css-references.ts#cssReferences', 'src/lib/markup-references.ts#virtualPathOf'],
        cost: `linear in the file; ${FILES_CAP}`,
    },
    viewStylesheets: {
        does: "at a strict or sealed build, every reference of a registered stylesheet the one rule for a URL in the view does not keep becomes `\"\"` by an edit of the snapshot (viewStylesheets, keepsUrl: a registered file's slot stays; BD7:ISO-1), its slots and its references read in one walk; the element warns once, naming the file and the first URL, each cut",
        takes: ['files'], modes: VIEW_MODES, rule: 'pure',
        units: ['src/lib/files.ts#viewStylesheets', 'src/lib/files.ts#slotRanges', 'src/lib/css-references.ts#keepsUrl', 'src/host.ts#viewStylesheetWarning', 'src/host.ts#this._warnOnce', 'src/lib/in-sandbox-view.ts#isViewFileType'],
        cost: `linear in the stylesheets (BD7:LIM-2's class); ${FILES_CAP}`,
    },
    viewBuild: {
        does: "the strict or sealed build: the entry and the files become the worker's source (the files as an escaped literal, toInlineScriptLiteral), and that source and `html` travel to the view in INIT_VIEW, a structured clone; the wrapper and the view documents are the library's own (the policy and the bootstrap), so no markup of the guest's reaches a sink or a parser of the host realm (BD7:LIM-1)",
        takes: ['html', 'entry', 'files'], modes: VIEW_MODES, rule: 'pure',
        units: [
            'src/host.ts#this._prepareBuild', 'src/host.ts#this._prepareSealedFrame', 'src/host.ts#this._prepareStrictFrame', 'src/host.ts#this._prepareViewFrame',
            'src/host.ts#this._getStrictWorkerSource', 'src/lib/frame-documents.ts#toInlineScriptLiteral', 'src/lib/in-sandbox-view.ts#buildViewDocument',
            'src/lib/frame-documents.ts#buildWrapperDocument', 'src/lib/frame-documents.ts#escapeAttribute',
        ],
        cost: `linear in the entry and the files; ${FILES_CAP}`,
    },
    policyFromKinds: {
        does: "each registered file's type, and only its type, chooses which fixed directives of the policy admit `blob:`: the policy holds nothing of the guest's",
        takes: ['files'], modes: ALL, rule: 'pure',
        units: [
            'src/host.ts#this._sealedPolicy', 'src/host.ts#this._viewFileKinds', 'src/host.ts#this._guestPolicy', 'src/host.ts#this._policyInput', 'src/host.ts#this._gateConnect',
            'src/lib/csp/csp-generator.ts#sealedViewPolicy', 'src/lib/csp/csp-generator.ts#strictViewPolicy', 'src/lib/csp/csp-generator.ts#cooperativePolicy',
            'src/lib/csp/csp-generator.ts#fileKinds', 'src/lib/csp/csp-generator.ts#connectSources', 'src/lib/csp/csp-generator.ts#fetchDirectives',
            'src/lib/csp/csp-generator.ts#format', 'src/lib/csp/csp-generator.ts#sourcesOf',
        ],
        cost: FILES_CAP,
    },
    workerBuild: {
        does: "worker mode's build: the files become the bootstrap's literal (toInlineScriptLiteral), with the library's own scripts; no markup",
        takes: ['files'], modes: ['worker', 'cooperative'], rule: 'pure',
        units: ['src/host.ts#this._getWorkerBootstrapScript', 'src/host.ts#this._getSandboxCommsScript', 'src/lib/in-sandbox-view.ts#environmentGate'],
        cost: FILES_CAP,
    },
    cooperativeDocument: {
        does: "cooperative mode's guest document is `html` itself: the element reads it with DOMParser (parseInert) for its warning that nothing runs without `allow-scripts` and for its file references and inline module scripts (rewriteGuestMarkup), and writes the document into the wrapper's `srcdoc` (_prepareDocumentFrame, which builds worker mode's document too, with no markup)",
        takes: ['html', 'files'], modes: ['cooperative', 'worker'], rule: 'documented',
        why: "cooperative mode runs the guest's own document under the host page's policy, which checks the same markup there (THREAT-MODEL, cooperative mode's limits); its host-side reading is not the board's scope (S74: sealed mode, the default), and a strict or sealed build never reaches it (the scan of _prepareViewFrame)",
        units: [
            'src/host.ts#this._warnAboutNoScripts', 'src/lib/markup-scripts.ts#scriptInMarkup', 'src/lib/markup-scripts.ts#holdsScript', 'src/lib/trusted-types.ts#parseInert',
            'src/host.ts#this._getMarkupPlan', 'src/lib/markup-references.ts#rewriteGuestMarkup', 'src/lib/markup-references.ts#resolveReference', 'src/lib/markup-references.ts#scriptType',
            'src/lib/markup-references.ts#serialiseDocument', 'src/lib/module-specifiers.ts#rewriteInlineModule', 'src/lib/module-specifiers.ts#applyEdits', 'src/lib/srcset.ts#srcsetCandidates',
            'src/lib/srcset.ts#isWhitespace', 'src/lib/load-kinds.ts#linkKinds', 'src/lib/import-map.ts#mergeGuestImportMaps', 'src/lib/import-map.ts#mergeSpecifierMap',
            'src/lib/import-map.ts#isPlainObject', 'src/lib/frame-documents.ts#buildGuestDocument', 'src/lib/csp/script-hash.ts#assertParserSafeScript',
            'src/host.ts#this._getCooperativeBootstrapScript', 'src/host.ts#this._prepareDocumentFrame',
        ],
        cost: "the browser's parser, linear in `html`, which cooperative mode does not cap (its guest document is that markup, which its frame parses anyway)",
    },
    guestWrites: {
        does: "a guest write's path is checked, its bytes counted against the quota (FileStore.check) and recorded; the view gets a copy of a raster image's bytes (VIEW_WRITE), and the embedder the path (`fileswritten`); a commit applies them as registerFiles() does",
        takes: ['writes'], modes: ALL, rule: 'pure',
        units: [
            'src/lib/guest-writes.ts#createGuestWrites', 'src/lib/guest-writes.ts#parseCommitArguments', 'src/host.ts#this.commitGuestWrites', 'src/host.ts#this._handleGuestWrite',
            'src/host.ts#viewWriteOf', 'src/host.ts#this._showInView', 'src/host.ts#this._dispatchFilesWritten', 'src/host.ts#this._startGuestWrites',
        ],
        cost: 'linear in the write, which MAX_TOTAL_BYTES caps, at most GUEST_WRITES_PER_SECOND a second',
    },
    rpcFrames: {
        does: "every frame on the guest's port is validated by the broker and measured as a snapshot (createSizeOf) before its value reaches the embedder's method or a reserved one; a probe's answer is a number",
        takes: ['calls'], modes: ALL, rule: 'pure',
        units: ['src/host.ts#this._onGuestMessage', 'src/lib/rpc.ts#createBroker', 'src/host.ts#this._passExecutionProbe'],
        cost: 'linear in the frame, which RPC_MAX_INBOUND_BYTES caps, at most callLimits a second',
    },
    logLines: {
        does: "a guest log line's arguments are cut at LOG_MAX_STRING and measured against LOG_MAX_BYTES (toLogDetail), then dispatched as `sandbox-log`",
        takes: ['lines'], modes: ALL, rule: 'pure',
        units: ['src/host.ts#this._dispatchGuestLog', 'src/host.ts#this._dispatchLog', 'src/lib/sandbox-log.ts#toLogDetail', 'src/lib/sandbox-log.ts#clampArgument'],
        cost: 'linear in the line, which LOG_MAX_BYTES caps, at most LOG_EVENTS_PER_SECOND a second',
    },
    violations: {
        does: 'a violation report\'s fields are cut at VIOLATION_MAX_STRING and checked (toViolationDetail), then dispatched as `violation`, at most VIOLATION_EVENT_LIMIT per environment',
        takes: ['violations'], modes: ALL, rule: 'pure',
        units: ['src/host.ts#this._dispatchViolation', 'src/lib/violation.ts#toViolationDetail', 'src/lib/violation.ts#clampString', 'src/lib/violation.ts#positiveInteger', 'src/lib/violation.ts#violationBucket'],
        cost: 'linear in the report, whose strings VIOLATION_MAX_STRING caps',
    },
    viewFrames: {
        does: "the view's frames: its check-in's numbers, the notes of what it dropped of the initial view (three constants, which decide the element's warning), the guest's error texts, cut again (viewErrorLine)",
        takes: ['viewFrames'], modes: VIEW_MODES, rule: 'pure',
        units: ['src/host.ts#this._onViewMessage', 'src/host.ts#this._warnAboutStrictHtml', 'src/host.ts#dropsScript', 'src/host.ts#viewErrorLine', 'src/host.ts#uncaughtLine'],
        cost: "constant, or linear in a text the view cut to guestText.maxLength",
    },
    fetchBridge: {
        does: "strict mode's `sandboxFetch()`: the request's URL is parsed and checked against `fetchBridge.allow`, its headers and body against their budgets, and the bridge's frame makes it; the response's chunks are counted against `maxBytes`",
        takes: ['fetches'], modes: ['strict', 'cooperative', 'worker'], rule: 'pure',
        units: [
            'src/host.ts#this._handleFetch', 'src/host.ts#this._exposeFetch', 'src/host.ts#this._startFetchBridge', 'src/lib/fetch-bridge.ts#createFetchBridge', 'src/lib/fetch-bridge.ts#validateRequest',
            'src/lib/fetch-bridge.ts#toHeaders', 'src/lib/fetch-bridge.ts#readBody', 'src/lib/fetch-bridge.ts#hasNoBody', 'src/lib/fetch-bridge.ts#recordOf', 'src/lib/fetch-bridge.ts#abortedRecord',
            'src/lib/fetch-bridge.ts#fetchRefusal', 'src/lib/bridge-frame.ts#createBridgeFrame', 'src/lib/long-timer.ts#setLongTimeout', 'src/lib/watchdog.ts#startWatchdog',
        ],
        cost: 'linear in the request and the response, which `fetchBridge.maxBytes` caps',
    },
    announcement: {
        does: "the guest frame's announcement: a port, taken once from the guest frame's own window, or a bootstrap's refusal, whose name is looked up in the library's table (ENVIRONMENT_REFUSALS) and whose reason, a text of the library's, ends the build",
        takes: ['announcement'], modes: ALL, rule: 'pure',
        units: ['src/host.ts#this._listenForAnnouncement', 'src/host.ts#this._refusedByHostPage', 'src/host.ts#hostNotice', 'src/lib/reasons.ts#hostLine', 'src/lib/reasons.ts#fill'],
        cost: 'constant: a lookup of one name',
    },
    carried: {
        does: "hands guest content on without a pass over it: the reducer gets an input of the library's (step), the build its prepared frame, the view its INIT_VIEW, the embedder an event whose detail is frozen (elementEvent), a listener its notices, the wrapper's `srcdoc` the document it is given (setLibrarySrcdoc: a strict or sealed build's is the library's own, LIBRARY_SINKS)",
        takes: ['html', 'entry', 'files', 'writes', 'calls', 'announcement'], modes: ALL, rule: 'carries',
        units: [
            'src/host.ts#step', 'src/host.ts#this._attachBuild', 'src/host.ts#this._setupStrictChannels', 'src/host.ts#this._teardown',
            'src/host.ts#this._frameLoadHandler', 'src/host.ts#guestWindowOf', 'src/host.ts#this.registerFiles', 'src/host.ts#this.unregisterFiles', 'src/host.ts#this.listFiles',
            'src/host.ts#this.listGuestWrites', 'src/host.ts#this._discardGuestWrites', 'src/host.ts#this._dispatchFilesChanged', 'src/lib/element-events.ts#elementEvent',
            'src/lib/element-events.ts#freezeDeep', 'src/lib/lifecycle.ts#runNotices', 'src/lib/trusted-types.ts#setLibrarySrcdoc',
        ],
        cost: 'constant, or linear in what it hands on (freezeDeep walks a detail once)',
    },
} as const satisfies Record<string, HostPass>;
export type HostPassId = keyof typeof HOST_PASSES;

/** The rows in table order, with their ids. */
export const hostPassRows = (): Array<HostPass & { readonly id: HostPassId }> =>
    (Object.keys(HOST_PASSES) as HostPassId[]).map(id => ({ id, ...(HOST_PASSES[id] as HostPass) }));

/** The rows a sealed build runs: the third side of the class-A table (SEALED_REACH, `host`). */
export const sealedHostPasses = (): HostPassId[] => (Object.keys(HOST_PASSES) as HostPassId[]).filter(id => (HOST_PASSES[id].modes as readonly SandboxMode[]).includes('sealed'));

/**
 * The library's own documents written to a markup sink of the host realm, which the scan of the passes admits: the unit
 * that writes, the platform names it uses, and why no guest content is in what it writes. The call sites the view's
 * frame builders reach them through are held to that by test/unit/host-passes.test.ts.
 */
export const LIBRARY_SINKS = {
    'src/lib/trusted-types.ts#setLibrarySrcdoc': {
        names: ['srcdoc', 'createHTML'],
        why: "the wrapper's and the bridge frame's documents, through the library's Trusted Types policy: a strict or sealed build's wrapper holds the view document, which is the policy and the bootstrap (the guest's markup, entry and files travel in INIT_VIEW); cooperative mode's holds its guest document (cooperativeDocument)",
    },
    'src/lib/trusted-types.ts#htmlPolicy': {
        names: ['createHTML'],
        why: "the library's Trusted Types policy, which blesses only its own documents",
    },
    'src/host.ts#this._prepareViewFrame': {
        names: ['createElement', 'setAttribute', 'cssText'],
        why: "the wrapper's iframe, its sandbox flags and a constant style",
    },
    'src/lib/frame-documents.ts#setWrapperFrameIsolation': {
        names: ['setAttribute'],
        why: "the wrapper's `credentialless` and `referrerpolicy` attributes, constants",
    },
    'src/lib/bridge-frame.ts#createBridgeFrame': {
        names: ['createElement', 'setAttribute', 'cssText'],
        why: "strict mode's fetch bridge frame (fetchBridge): its iframe, flags and a constant style; its document is the library's",
    },
    'src/lib/bridge-frame.ts#prepareBridgeFrame': {
        names: ['createElement', 'setAttribute', 'cssText'],
        why: 'as createBridgeFrame',
    },
} as const satisfies Record<string, { readonly names: readonly string[]; readonly why: string }>;
