import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { createBroker } from '@src/lib/rpc';

/**
 * The request gate's unit harness (in-sandbox-script.ts; S74): the bootstrap runs in this file's realm, in strict mode's
 * form, over stand-ins installed as the platform's fetch, XMLHttpRequest and WebSocket before it captures them. A copy of
 * the stand-in fetch also sits on the global object's prototype, where a worker's platform keeps it (BD1:ISO-2). The gate is
 * not configurable on the global object, so one gate is installed per test file, with the list `install` is given.
 */

class FakePort {
    posted: any[] = [];
    private handler: ((event: unknown) => void) | null = null;
    postMessage(frame: unknown) { this.posted.push(frame); }
    get onmessage() { return this.handler; }
    set onmessage(handler) { this.handler = handler; }
}

export function createGateHarness() {
    const fetched: { url: string; credentials: string }[] = [];
    const platformFetch = (request: Request) => {
        fetched.push({ url: request.url, credentials: request.credentials });
        return Promise.resolve(new Response('ok'));
    };
    const opened: string[] = [];
    const sent: string[] = [];
    const credentialsSet: unknown[] = [];
    class PlatformXMLHttpRequest extends EventTarget {
        static readonly DONE = 4;
        private state = 0;
        private target = '';
        open(_method: string, url: string) { opened.push(url); this.target = url; this.state = 1; }
        send() { sent.push(this.target); }
        abort() {}
        get readyState() { return this.state; }
        get withCredentials() { return false; }
        set withCredentials(value: unknown) { credentialsSet.push(value); }
    }
    const PLATFORM_MEMBERS = { open: PlatformXMLHttpRequest.prototype.open, send: PlatformXMLHttpRequest.prototype.send, abort: PlatformXMLHttpRequest.prototype.abort };
    const sockets: string[] = [];
    class PlatformWebSocket extends EventTarget {
        static readonly OPEN = 1;
        constructor(readonly url: string) { super(); sockets.push(url); }
    }

    const g = globalThis as any;
    let port: FakePort;
    const prototypeOfGlobal = Object.getPrototypeOf(globalThis);

    /** Installs the stand-ins and the gate over `connect`, the list of the policy's connect-src. */
    const install = (connect: readonly string[]) => {
        g.MessagePort = FakePort;
        Object.defineProperty(globalThis, 'fetch', { value: platformFetch, writable: true, configurable: true });
        Object.defineProperty(prototypeOfGlobal, 'fetch', { value: platformFetch, writable: true, configurable: true });
        g.XMLHttpRequest = PlatformXMLHttpRequest;
        g.WebSocket = PlatformWebSocket;
        // strict mode's form: the port is handed to attach() (no INIT_PORT listener), as the strict prelude does
        const comms = inSandboxScript(false, 'strict', { log() {}, info() {}, warn() {}, error() {} } as unknown as Console, createBroker, { externalPort: true, connect: [...connect] });
        port = new FakePort();
        comms.attach(port as unknown as MessagePort);
    };

    const reports = () => port.posted.filter(frame => frame.type === 'VIOLATION');
    const clear = () => {
        port.posted.length = fetched.length = opened.length = sent.length = sockets.length = credentialsSet.length = 0;
    };

    return {
        install, reports, clear, fetched, opened, sent, sockets, credentialsSet,
        platformFetch, PlatformXMLHttpRequest, PlatformWebSocket, PLATFORM_MEMBERS, prototypeOfGlobal,
        /** Everything the gate posted on its port. */
        posted: () => port.posted,
    };
}
