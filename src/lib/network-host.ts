/**
 * The element's part of the network modes (research 24, D9; ADR-009): what strict, cooperative and worker mode do in the
 * host page's realm that sealed mode never does. The builds of cooperative and worker mode's guest document and of strict
 * mode's view with its network, the host page's policy applied to the connect lists, the fetch bridge and its frame, the
 * guest frame's announcement and its port, and `execute()` with its deadline. They are methods of the element: the
 * network build's entry (src/network.ts) installs them on its prototype (network-install.ts), and the element calls the
 * ones the seam declares (network-modes.ts, NetworkElement). The default build imports none of this, so its element
 * has none of them.
 *
 * Host-side only; the functions it stringifies into a guest realm are declared in their own modules (realms.ts).
 */
import { UNSAFE_PERMISSIONS } from '../csp-directives';
import { EXECUTION_TIMEOUT_GRACE_MS, hostNotice, LOAD_TIMEOUT_MS, workerGlobalsCall, type BootstrapFeatures } from '../host';
import { BRIDGE_FRAME_REFUSED, createBridgeFrame, prepareBridgeFrame } from './bridge-frame';
import { hasStrictView } from './config-schema';
import { connectSources, cooperativePolicy, fileKinds, strictViewPolicy, type PolicyInput } from './csp/csp-generator';
import { hostReach, type NarrowedReach } from './csp/host-connect';
import { executeRefused } from './csp/host-trusted-types';
import type { OriginPolicy } from './csp/origin-kinds';
import { bootstrapListeners, UNCAUGHT_BUDGET } from './egress';
import { elementEvent } from './element-events';
import { createFetchBridge, type FetchBridge, type FetchPolicy, type FetchRecord } from './fetch-bridge';
import { isJavaScriptType, type FileSnapshotEntry, type FileStore } from './files';
import { buildGuestDocument, buildWrapperDocument, permissionAttributes, setWrapperFrameIsolation, toInlineScriptLiteral } from './frame-documents';
import { hostPageOrigin } from './host-site';
import { mergeGuestImportMaps } from './import-map';
import { inSandboxFiles, inSandboxImportMap, inSandboxMarkup } from './in-sandbox-files';
import { inSandboxScript } from './in-sandbox-script';
import { requestGate } from './request-gate';
import { environmentGate, STRICT_DIRECTIVE, viewBootstrapHash } from './in-sandbox-view';
import type { Generation } from './lifecycle';
import { setLongTimeout } from './long-timer';
import { kindMismatchMessage, rewriteGuestMarkup, type MarkupParts } from './markup-references';
import { scriptInMarkup } from './markup-scripts';
import type { Announcement, NetworkHost, PreparedBuild, PreparedNetwork, ViewNetwork } from './network-modes';
import { fixedDetail, hostLine, reasonText } from './reasons';
import { createBroker } from './rpc';
import { createSizeOf } from './structured-size';
import { setLibrarySrcdoc, TRUSTED_TYPES_POLICY } from './trusted-types';
import { VIOLATION_EVENT_FIELDS } from './violation';
import { startWatchdog, watchdogBudget, type Watchdog } from './watchdog';
import { workerBootstrap } from './worker-bootstrap';
import { WORKER_GLOBALS, workerGlobalsFor } from './worker-globals';

// What the bootstrap writes and registers for one build's guest markup (cooperative mode).
interface GuestMarkupPlan {
    // the markup cut into parts for the bootstrap to write (markup-references.ts), or null to embed it as written
    parts: MarkupParts | null;
    // the one import map (module graph): every registered JavaScript file, plus the guest's own
    // inline maps merged (import-map.ts), or null when no JavaScript file is registered
    importMap: { paths: string[]; guest: string | null } | null;
}

const NO_MARKUP_PLAN: GuestMarkupPlan = { parts: null, importMap: null };

// What worker mode's frame may announce instead of a port (worker-bootstrap.ts), and the reason each ends the build with.
const WORKER_FRAME_REFUSALS: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null), {
    'worker': reasonText('workerRefused'),
    'trusted-types': reasonText('trustedTypes'),
    'failed': reasonText('buildFailed', fixedDetail('Error')),
}));

// The network of a build as these modes prepared it: the bridge's frame (PreparedNetwork), and the bridge's policy with
// the host page's policy applied (reach): what its requests are checked against.
interface NetworkBuild extends PreparedNetwork {
    fetchPolicy: FetchPolicy | null;
}

/**
 * The methods the network build adds to the element (network-install.ts). Never constructed: `this` is the element,
 * whose own fields and methods these read by name (network-modes.ts, NetworkHost). Private, as the element's own are:
 * the element calls the ones the seam names (NETWORK_ELEMENT_METHODS), and the install checks that each is here.
 */
export interface NetworkMethods extends NetworkHost {
    // the element's fields as these modes made them: the validated fetchBridge config (BL:B5), and the build's bridge
    _fetchPolicy: FetchPolicy | null;
    _fetchBridge: FetchBridge | null;
}
export class NetworkMethods {
    /**
     * The build effect of strict, cooperative and worker mode (host.ts, _prepareBuild): the host page's policy applied
     * to the connect lists first (_reach), then its Trusted Types list, then the mode's frame.
     */
    private _prepareNetworkBuild(built: FileStore, files: FileSnapshotEntry[]): PreparedBuild {
        const reach = this._reach();
        this._refuseByTrustedTypes();
        if (this._config.mode === 'strict') return this._prepareStrictFrame(built, files, reach);
        return this._prepareDocumentFrame(built, files, reach);
    }

    /**
     * The sandbox flags of a build of cooperative or worker mode: the safe capabilities configured and the unsafe ones
     * that are flags (strict and sealed mode's are the view's: host.ts, _getSandboxFlags).
     */
    private _documentSandboxFlags(): string {
        const flags = new Set<string>(this._config.capabilities || []);
        for (const capability of this._config.unsafeCapabilities || []) {
            if (this._isPermission(capability)) continue; // goes into the allow attribute instead
            flags.add(capability);
        }

        // worker mode needs scripts in the frame to spawn the worker
        if (this._config.mode === 'worker') flags.add('allow-scripts');

        return [...flags].join(' ');
    }

    /**
     * The guest frame's one announcement, as the element's listener read it (host.ts, _listenForAnnouncement): what it
     * does is the reducer's (`announced`).
     */
    private _onAnnouncement({ data, ports, trusted, source, gen }: Announcement): void {
        // Worker mode's frame announces a worker that could not start as its one announcement, with no port (R2:C-5,
        // worker-bootstrap.ts): the build ends with the reason strict mode gives for the same refusal,
        // and is never 'ready'. Only in worker mode, whose frame runs no guest code: elsewhere it is a forgery.
        const refusal = this._config.mode === 'worker' && ports.length === 0 ? WORKER_FRAME_REFUSALS[data.refused as string] ?? null : null;
        const valid = trusted && (ports.length === 1 || refusal !== null);
        // The check-in (S46): the environment is ready then, whether or not the wrapper has loaded (its load waits for
        // the guest's subresources).
        this._step({ t: 'announced', gen, valid, refusal, port: valid && refusal === null ? ports[0]! : null, source });
    }

    /**
     * Cooperative and worker mode: the guest document (cooperative mode's is `html`, which runs as it is: that is the mode;
     * worker mode's has no markup) under the guest policy, in the wrapper. Cooperative mode reads `html` with an inert
     * parser here, for its warning and its file references (HOST_PASSES.cooperativeDocument); a strict or sealed build
     * never reaches this (host.ts, _prepareBuild returns before it).
     */
    private _prepareDocumentFrame(built: FileStore, files: FileSnapshotEntry[], reach: NarrowedReach): PreparedBuild {
        const isWorkerMode = this._config.mode === 'worker';
        const sandboxFlags = this._documentSandboxFlags();
        const permissions = this._getPermissions();
        const policy = this._guestPolicy(files, reach.origins);
        const connect = this._gateConnect(files, reach.origins);

        // Guest markup is the guest's own: cooperative mode runs it as it is (that is the mode), and strict mode's view cleans
        // it with its allowlist renderer (sanitizeRender), not here.
        let guestDocument: string;
        if (isWorkerMode) {
            // worker mode is headless: no guest markup, so no markup references either
            guestDocument = buildGuestDocument({ csp: policy, bootstrapScript: this._getWorkerBootstrapScript(files, connect), content: '' });
        } else {
            const html = this._config.html || '<div id="root"></div>';
            this._warnAboutNoScripts(html, sandboxFlags);
            // A fresh slot nonce per build (inside rewriteGuestMarkup); null parts keep the markup verbatim.
            const plan = this._getMarkupPlan(html, files, sandboxFlags);
            guestDocument = buildGuestDocument({
                csp: policy,
                bootstrapScript: this._getCooperativeBootstrapScript(files, plan, connect),
                content: plan.parts ? '' : html,
                bootstrapWritesContent: plan.parts !== null,
            });
        }

        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", sandboxFlags);
        // the wrapper's own document.referrer is never the host page (S15; the guest's is set in the wrapper), and on Chromium
        // none of its requests carries a cookie (S74)
        setWrapperFrameIsolation(iframe);
        for (const [name, value] of Object.entries(permissionAttributes(permissions))) {
            iframe.setAttribute(name, value);
        }
        iframe.style.cssText = isWorkerMode ? "display:none" : "width:100%;height:100%;border:none";
        // srcdoc goes in before the frame is inserted: an iframe inserted without one first
        // loads about:blank, which would count as the frame's one load (see _frameLoadHandler)
        setLibrarySrcdoc(iframe, buildWrapperDocument(guestDocument, sandboxFlags, permissions));
        return { iframe, built, strictInit: null, network: this._prepareNetwork(reach.fetchPolicy) };
    }

    /**
     * Strict mode (ADR-005): the view (_prepareViewFrame) under the strict template with this build's origins, the request
     * gate's list from the same input, the origins the renderer admits, and the fetch bridge's frame.
     */
    private _prepareStrictFrame(built: FileStore, files: FileSnapshotEntry[], reach: NarrowedReach): PreparedBuild {
        const network: ViewNetwork = {
            connect: this._gateConnect(files, reach.origins),
            origins: reach.origins,
            fetchBridge: this._fetchPolicy ? { timeoutMs: this._fetchPolicy.timeoutMs } : null,
            requestGate: requestGate.toString(),
        };
        const prepared = this._prepareViewFrame(built, files, this._guestPolicy(files, reach.origins), network);
        return { ...prepared, network: this._prepareNetwork(reach.fetchPolicy) };
    }

    // The network of a build of strict, cooperative or worker mode: the fetch bridge's frame, written detached like the
    // wrapper (or none with the bridge off), and the bridge's policy. _attachBuild starts it (_startFetchBridge).
    private _prepareNetwork(policy: FetchPolicy | null): NetworkBuild {
        return { bridgeFrame: policy ? prepareBridgeFrame(policy.allow) : null, fetchPolicy: policy };
    }

    // The host page's policy applied to the connect origins of this build (host-connect.ts): `origins` and the bridge's
    // allowlist as configured, less what the embedder's `hostContentSecurityPolicy` refuses, and nothing of them when the
    // embedder did not give it (hostReach, the one decision; BD4:CHL-1, BD4:CHL-2). The page itself is never asked.
    // Pure of the element's fields: a nested or stale build narrows its own (LM-2).
    private _reach(): NarrowedReach {
        return hostReach(this._origins, this._fetchPolicy, this._config.hostContentSecurityPolicy, message => this._warnOnce(message));
    }

    // The guest policy of this build (csp-generator.ts, ADR-007): the mode's template, the parsed origins, and blob:
    // for the kinds of load this build's files need (the snapshot's types, through the one load-kind table). The one
    // place a guest policy of strict, cooperative and worker mode is made; worker mode's worker and strict mode's worker
    // inherit their frame's. Sealed mode's is not made here: _sealedPolicy, which takes no origins.
    private _guestPolicy(files: FileSnapshotEntry[], origins: OriginPolicy): string {
        const input = this._policyInput(files, origins);
        if (this._config.mode !== 'strict') return cooperativePolicy(input);
        return strictViewPolicy({ ...input, bootstrapHash: viewBootstrapHash() });
    }

    // The sources of that policy's connect-src, from the same input: what the bootstrap's request gate admits (S74), so
    // the gate and the browser read one list. Sealed mode has no such list: its gate admits nothing (_prepareSealedFrame).
    private _gateConnect(files: FileSnapshotEntry[], origins: OriginPolicy): string[] {
        return connectSources(this._policyInput(files, origins));
    }

    private _policyInput(files: FileSnapshotEntry[], origins: OriginPolicy): PolicyInput {
        const scriptUnsafe = this._config.scriptUnsafe === true;
        if (!hasStrictView(this._config.mode)) return { origins, fileKinds: fileKinds(files.map(entry => entry[1])), scriptUnsafe };
        return { origins, fileKinds: this._viewFileKinds(files), scriptUnsafe };
    }

    // What the bootstrap does with this build's guest markup (GuestMarkupPlan): references to registered
    // files cut into parts for it to write (markup-references.ts) and, with JavaScript files, the one
    // import map (module graph). Only when the bootstrap can run — scripts allowed by the sandbox flags (the
    // policy always admits the inline bootstrap, csp-generator.ts) — since otherwise nothing would write the markup
    // or register the map; references then stay as written and fail closed, and so do relative imports between modules.
    private _getMarkupPlan(html: string, files: FileSnapshotEntry[], sandboxFlags: string): GuestMarkupPlan {
        if (files.length === 0) return NO_MARKUP_PLAN;
        if (!sandboxFlags.split(' ').includes('allow-scripts')) return NO_MARKUP_PLAN;

        // The module graph maps only files a script load admits (load-kinds.ts, through isJavaScriptType): an import
        // of any other file names nothing in the import map and fails closed, as a <script src> of one does (FR:W1).
        const javascript = files.filter(entry => isJavaScriptType(entry[1])).map(entry => entry[0]);
        const markup = rewriteGuestMarkup(html, new Map(files.map(entry => [entry[0], entry[1]])), {
            modules: javascript.length > 0,
            onModuleFailure: (index) => this._warnOnce(`[Sandbox] inline module script #${index + 1} in the guest markup could not be lexed, so its relative imports were not rewritten and will fail.`),
            onKindMismatch: (mismatch) => this._warnOnce(kindMismatchMessage(mismatch)),
        });
        if (javascript.length === 0) return { parts: markup.parts, importMap: null };
        const guest = mergeGuestImportMaps(markup.importMaps, (message) => this._warnOnce(message));
        return { parts: markup.parts, importMap: { paths: javascript, guest } };
    }

    // Cooperative mode without allow-scripts runs no script, the library's bootstrap included (R1:R3-4): what
    // needs one does nothing there, silently, so it is said once per element and message.
    private _warnAboutNoScripts(html: string, sandboxFlags: string) {
        if (sandboxFlags.split(' ').includes('allow-scripts')) return;
        const unused: string[] = [];
        if (scriptInMarkup(html)) unused.push('the scripts and handlers in html');
        if (watchdogBudget(this._config.watchdogTimeout) > 0) unused.push('watchdogTimeout');
        if (this._config.autoResize === true) unused.push('autoResize');
        if (this._fetchPolicy) unused.push('fetchBridge');
        if (this._config.guestWrites === true) unused.push('guestWrites');
        if (this._config.scriptUnsafe === true) unused.push('execute()');
        if (this._exposedNames.size > 0) unused.push('the methods published with expose()');
        if (unused.length === 0) return;
        this._warnOnce(`[Sandbox] cooperative mode without "allow-scripts" runs no script, the library's own included: ${unused.join(', ')} ${unused.length === 1 ? 'has' : 'have'} no effect. Add "allow-scripts" to capabilities.`);
    }

    // `postToFrame` (worker mode): the expression that names the worker's platform postMessage, which the globals
    // allowlist handed over (worker-globals.ts, R4:M-1); the bootstrap's one WORKER_STARTED uses it.
    // `connect`: the sources of the guest policy's connect-src (_gateConnect), which the bootstrap's request gate admits.
    private _getSandboxCommsScript(mode: 'cooperative' | 'worker', files: FileSnapshotEntry[], plan: GuestMarkupPlan = NO_MARKUP_PLAN, postToFrame = 'null', connect: readonly string[] = []) {
        // communication, logs and RPC bridge template that any content running in the sandbox uses.
        // createBroker is stringified in too, so the guest runs the identical dispatcher (see rpc.ts).
        // The features as one literal: the opt-in ones only when on, and the call budget always (R3:M-2).
        // The listeners the bootstrap installs are the egress table's rows for this mode (egress.ts), and worker mode's guest also
        // counts its uncaught errors and rejections against their budget (R5:N-1).
        const features: BootstrapFeatures = { callBudget: { ...this._callBudget }, listeners: bootstrapListeners(mode), connect: [...connect] };
        if (mode === 'worker') {
            features.uncaught = { ...UNCAUGHT_BUDGET };
            features.violationFields = { ...VIOLATION_EVENT_FIELDS };
        }
        if (mode === 'cooperative' && this._autoResizeEnabled()) features.autoResize = true;
        if (this._fetchPolicy) features.fetchBridge = { timeoutMs: this._fetchPolicy.timeoutMs };
        if (this._config.guestWrites === true) features.guestWrites = true;
        const featuresArgument = `, ${toInlineScriptLiteral(features)}`;
        // Only literals are interpolated: `=== true` here as well, whatever setConfig() stored (AR:A6).
        const comms = `(${inSandboxScript.toString()})(${this._config.scriptUnsafe === true}, '${mode}', console, ${createBroker.toString()}${featuresArgument}, ${createSizeOf.toString()}, ${postToFrame}, ${requestGate.toString()})`;
        // Guest writes (BL:C5): sandboxFiles gets the comms script's captured write call through `comms`, a constant
        // of a block the whole bootstrap then runs in: block-scoped, so never a global guest code could read.
        // Without them the bootstrap keeps its text: the comms statement, then sandboxFiles without a write call
        // (its write() and remove() refuse locally).
        const writes = this._config.guestWrites === true;
        // The snapshot is one inline literal, so the blobs exist before the parser reaches guest markup.
        // Installed even with no files (an empty literal): sandboxFiles always exists, and a lookup in
        // an empty store is NOT_FOUND like any other miss, never a ReferenceError.
        let filesCall = `(${inSandboxFiles.toString()})(${toInlineScriptLiteral(files)}${writes ? ', comms.writeFiles' : ''})`;
        // With JavaScript files: the one import map, registered with the URLs filesCall just created,
        // before any guest markup (module graph). It hands the files object on to the next step.
        if (plan.importMap) {
            filesCall = `(${inSandboxImportMap.toString()})(${filesCall}, ${toInlineScriptLiteral(plan.importMap.paths)}, ${toInlineScriptLiteral(plan.importMap.guest)})`;
        }
        // Guest markup that names files: written by the bootstrap's last statement, with the blob: URLs
        // filesCall just created (markup-references.ts). The parts are one more inline literal.
        const last = plan.parts ? `(${inSandboxMarkup.toString()})(${filesCall}, ${toInlineScriptLiteral(plan.parts)});` : `${filesCall};`;
        return writes ? `{const comms = ${comms};${last}}` : `${comms};${last}`;
    }

    // The cooperative guest's bootstrap, behind the environment gate (environment-check.ts, S74): the check is its first
    // statement, and on a refusal the document's parser stops, so the guest markup that follows never runs.
    private _getCooperativeBootstrapScript(files: FileSnapshotEntry[], plan: GuestMarkupPlan, connect: readonly string[]) {
        return environmentGate('parent.parent', true, this._getSandboxCommsScript('cooperative', files, plan, 'null', connect));
    }

    private _getWorkerBootstrapScript(files: FileSnapshotEntry[], connect: readonly string[]) {
        // the worker keeps only the allowlisted globals (worker-globals.ts), then runs the comms script and builds its
        // own blobs and sandboxFiles from the same literal; the frame only spawns it and forwards the port
        // No WebAssembly unless scriptUnsafe (R1:R2-5), as in strict mode: off the allowlist (workerGlobalsFor).
        // The allowlist runs first, as the argument of the function the rest runs in: it returns the worker's postMessage,
        // which it deleted (R4:M-1), and only the comms script is given it, for its one WORKER_STARTED.
        const globals = workerGlobalsFor(WORKER_GLOBALS, this._config.scriptUnsafe === true);
        const workerSource = `${STRICT_DIRECTIVE}(function (g, postToFrame) {${this._getSandboxCommsScript('worker', files, NO_MARKUP_PLAN, 'postToFrame', connect)}})(this, ${workerGlobalsCall('this', globals)});`;
        return environmentGate('parent.parent', false, `(${workerBootstrap.toString()})(${toInlineScriptLiteral(workerSource)}, ${toInlineScriptLiteral(TRUSTED_TYPES_POLICY)});`);
    }

    private _isPermission(capability: string): boolean {
        return (UNSAFE_PERMISSIONS as readonly string[]).includes(capability);
    }

    // Permissions Policy features for the iframe `allow` attribute (e.g. fullscreen)
    private _getPermissions(): string[] {
        const permissions: string[] = [];
        if (hasStrictView(this._config.mode)) return permissions;
        for (const capability of this._config.unsafeCapabilities || []) {
            if (this._isPermission(capability)) permissions.push(capability);
        }
        return permissions;
    }

    // One fetch bridge per environment (BL:B5), built with the environment and aborted by _teardown. The reserved
    // method is registered again by every build (_attachBuild, from this function's answer: a sealed build, which has no
    // network, gives null), closed over THIS build's bridge (or null when off), as sandbox:write is
    // over its overlay: the broker looks a method up when a request arrives and runs it a microtask later, and a
    // request must be served by the bridge of the environment it arrived in. Reading this._fetchBridge when the method
    // runs would let a request that arrived just before a rebuild be served by the next environment's bridge (FR:H).
    // Closed over its own bridge, it reaches the one teardown closed, and is refused there.
    // Its requests are made by its own frame (bridge-frame.ts; BD1:ISO-1, class E-net), prepared by the build and put in
    // the shadow root after the wrapper: the bridge's only transport. The host page's fetch makes none of them.
    private _startFetchBridge(network: PreparedNetwork): FetchBridge | null {
        const { bridgeFrame: prepared, fetchPolicy: policy } = network as NetworkBuild;
        if (!policy || !prepared) {
            this._fetchBridge = null;
            return null;
        }
        const frame = createBridgeFrame({
            iframe: prepared,
            parent: this.shadowRoot!,
            maxBytes: policy.maxBytes,
            startupTimeoutMs: LOAD_TIMEOUT_MS,
            onRefused: () => this._warnBridgeFrameRefused(),
        });
        this._bridgeFrame = frame;
        this._fetchBridge = createFetchBridge({
            policy,
            hostOrigin: hostPageOrigin(),
            onRecord: (record) => this._dispatchFetch(record),
            transport: frame.transport,
        });
        return this._fetchBridge;
    }

    // The bridge fails closed when its frame never started (every request refused, with the reason in its record);
    // the embedder is told once, on the console.
    private _warnBridgeFrameRefused() {
        if (this._warnedBridgeFrame) return;
        this._warnedBridgeFrame = true;
        console.warn(`[Sandbox] ${BRIDGE_FRAME_REFUSED}: every sandboxFetch() request is refused.`);
    }

    // Every request through the bridge, once, when it settled: dispatched on the element and bubbling, like
    // 'violation'. The record is built by the host from validated fields (fetch-bridge.ts).
    private _dispatchFetch(record: FetchRecord) {
        this.dispatchEvent(elementEvent('fetch', record));
    }

    // The guest's port, announced by the guest frame itself (BR:CB1), becomes this environment's port. Null when this
    // build's guest runs no bootstrap (no allow-scripts): there is nothing to talk to,
    // and calls wait in the queue until they time out.
    private setupChannel(port: MessagePort | null) {
        if (this._port) { this._port.close(); this._port = null; }
        if (!port) return;
        this._port = port;
        // One reply channel per port: answers go back where their request came from, and the broker counts the
        // calls it runs per channel (AR:B7), so the count belongs to this environment.
        const reply = (frame: unknown, transfer?: Transferable[]) => port.postMessage(frame, transfer ?? []);
        // Setting onmessage starts the port: frames the guest posted before its announcement was accepted are
        // delivered now, after 'ready'. What waits in the queue is posted by the `flush` effect, the one flush point.
        port.onmessage = (e) => this._onGuestMessage(port, reply, e.data, null);
    }

    // One EXECUTE frame, with its budget armed first.
    private _postExecute(port: MessagePort, code: string) {
        // where the browser has no Trusted Types: the page requires them for scripts, so a string is not evaluated (as the guest's own sink refuses it where it has them)
        const trustedTypes = this._trustedTypes();
        if (trustedTypes && executeRefused(trustedTypes)) {
            console.warn("[Sandbox] execute() refused: the host page requires Trusted Types for scripts (require-trusted-types-for 'script'), so a string is not evaluated (docs/API.md#host-page-policy).");
            return;
        }
        this._armExecutionBudget();
        port.postMessage({ type: 'EXECUTE', code });
    }

    // workerExecutionTimeout (FR:F2, ADR-003): what it bounds is "the guest's
    // event loop is free at the deadline". Each execute() arms a deadline `budget` ms after the host posts the code
    // (the only moment the host can see). At the deadline the host pings the guest through the bootstrap's own PING
    // handler, which guest code cannot reach (AR:B2), and only a free event loop can run it: no answer within
    // EXECUTION_TIMEOUT_GRACE_MS means the loop is still busy, and that ends the sandbox the way the watchdog does
    // (ADR-003: a guest over a budget is terminated; reset() is the embedder's choice).
    //
    // The guest reports nothing when the code returns, because no report of the guest's can be a bound: code that
    // returns at once but leaves a loop scheduled (setTimeout(() => { for (;;) {} })) would stop its own timer and then
    // loop, and guest code that replaced globalThis.Function would have the bootstrap's `new Function(code)` return a
    // function of its choosing, so a "done" report would come before the embedder's code had run at all (FR:F2). So
    // nothing the guest says ends a budget, only an answer from a free loop at the deadline, and the bootstrap compiles
    // with the Function it captured before guest code ran (in-sandbox-script.ts).
    //
    // Several execute() calls each have their own deadline, and each deadline checks the one event loop: a loop
    // started by any code ends the sandbox at the first deadline it blocks. Code that ran to its end and left the
    // loop free stays, whatever it scheduled for later; a loop that starts after the last deadline is the
    // watchdog's to bound (watchdogTimeout checks the loop continuously). The worker lives inside the frame, so
    // tearing the frame down stops it. Cooperative mode has no such budget: the guest document can share the host's
    // thread, so no timer could fire meanwhile.
    private _armExecutionBudget() {
        if (this._config.mode !== 'worker' && !hasStrictView(this._config.mode)) return;
        const budget = watchdogBudget(this._config.workerExecutionTimeout); // a finite number > 0, else off
        if (budget === 0) return;
        const gen = this._lc.gen; // the environment the code was posted to: its timeout ends that one only
        const timer = setLongTimeout(() => {
            this._executionTimers.delete(timer);
            this._probeExecution(gen);
        }, budget); // any budget, 2^31 ms and past (R2:L-2: long-timer.ts)
        this._executionTimers.add(timer);
    }

    // The check at a deadline: a one-off watchdog over EXECUTION_TIMEOUT_GRACE_MS (watchdog.ts: pings each tick until
    // an answer, expires after a whole grace of silent ticks, so a host stall is never counted against the guest).
    // Its pings carry negative numbers of their own, so a PONG names the probe it answers and never the watchdog's.
    private _probeExecution(gen: Generation) {
        const port = this._port;
        if (!port) return;
        const pings: number[] = [];
        let probe: Watchdog | null = null;
        const end = () => {
            probe?.stop();
            for (const n of pings) this._executionProbes.delete(n);
        };
        probe = startWatchdog({
            timeoutMs: EXECUTION_TIMEOUT_GRACE_MS,
            ping: () => {
                const n = -(++this._probePings);
                pings.push(n);
                this._executionProbes.set(n, end);
                port.postMessage({ type: 'PING', n });
            },
            onExpire: () => {
                end();
                this._onExecutionTimeout(gen);
            },
        });
    }

    // A PONG to a probe's ping: the event loop was free, the probe passes. False when it answers no probe.
    private _passExecutionProbe(n: unknown): boolean {
        const end = typeof n === 'number' ? this._executionProbes.get(n) : undefined;
        if (!end) return false;
        end();
        return true;
    }

    // The deadline's probe went unanswered: one host line, then the termination, of the environment the code ran in.
    //
    // A termination the element starts that says something first carries its lines as `notices` (src/lib/lifecycle.ts,
    // Notice), and the executor dispatches them, one event each, then the termination as a nested step. A listener of a
    // line may reset() or terminate() the sandbox, and acting afterwards on the environment that is gone would undo what
    // the listener did (AR:B5); a second line of one callback, dispatched after a listener of the first had reset or
    // removed the element, would reach the next environment's listeners, or an idle element's (R4:L-2). So the
    // executor stops before the next line and before the step once the generation moved (lifecycle.ts, `runEffects`),
    // and the step itself carries `gen`, which `reduce` drops once it is stale. host.ts keeps no comparison of its own
    // for this (test/unit/lifecycle-reducer.test.ts scans for one), and a notice is data, so it dispatches exactly one
    // event by construction (the executor's `notice`, host.ts's `lifecycleHost`).
    private _onExecutionTimeout(gen: Generation) {
        this._step({ t: 'terminate', reason: reasonText('executionTimeout'), gen, notices: [hostNotice(hostLine('executionTimeout'))] });
    }
}
