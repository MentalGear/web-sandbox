import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { test, expect, type SandboxDriver } from './fixture';
import { inFrames, waitInView } from './strict-view';

/**
 * Backlog S13: WebRTC. ICE gathering sends UDP to STUN/TURN servers that no CSP directive governs
 * (connect-src does not apply; `webrtc 'block'` and Chromium's local-network-access policy changed
 * nothing, measured 2026-10-13). Guarantees, per engine:
 *   1. the guest's own realm has no peer-connection constructor, from its first script on (cooperative mode),
 *      and a worker never has one (worker mode);
 *   2. the guest cannot take it back from another realm: every frame it creates is cross-origin to it;
 * and the residual, asserted as measured so a change is noticed:
 *   3. a frame the guest creates is a realm of its own, runs its own script and keeps RTCPeerConnection;
 *      its ICE gathering reaches a loopback UDP listener on every engine.
 * Strict mode (ADR-005) closes the residual by construction:
 *   4. guest code runs in a worker, which has no peer-connection constructor, and the view runs no guest
 *      script; a frame in rendered markup is removed before it is inserted (A1), so the same ICE probe
 *      never runs and no UDP reaches the listener, while the same probe in a frame a cooperative guest creates (the
 *      residual of 3, the positive control) is heard.
 *
 * Firefox (independent verification 2026-10-14): it sends no STUN/TURN traffic to a loopback server by default, so
 * this file runs it with `media.peerconnection.ice.loopback` on (Playwright's firefoxUserPrefs; the other engines
 * ignore it). The pref changes only where ICE may send, not whether a realm has RTCPeerConnection. Where Firefox still
 * sends nothing a listener can hear (a CI runner, measured), the packet assertions are reported as not measurable
 * (packetsMeasurable); the structural ones always hold.
 */

test.use({ launchOptions: { firefoxUserPrefs: { 'media.peerconnection.ice.loopback': true } } });

const PEER_CONNECTION_NAMES = `Object.getOwnPropertyNames(globalThis).filter(n => /^(webkit|moz)?RTCPeerConnection$/.test(n))`;

test('cooperative mode, shipping config: the first guest script finds no peer-connection constructor', async ({ sandbox, page }) => {
    await sandbox.exposeHost('report', '(value) => { window.rtcReport = value; return true; }');
    expect(await sandbox.mount({ scriptUnsafe: false, html: `<script>
        bridge.call('report', { pc: typeof RTCPeerConnection, webkit: typeof webkitRTCPeerConnection, names: ${PEER_CONNECTION_NAMES} });
    </script>` })).toBe('ready');
    await page.waitForFunction(() => (window as any).rtcReport !== undefined);

    expect(await page.evaluate(() => (window as any).rtcReport)).toEqual({ pc: 'undefined', webkit: 'undefined', names: [] });
});

test('the guest cannot take it back: a frame it creates (about:blank or srcdoc) is cross-origin to it', async ({ sandbox }) => {
    expect(await sandbox.mount()).toBe('ready');
    const r = await sandbox.inGuest(`
        const reach = (frame) => { try { return typeof frame.contentWindow.RTCPeerConnection; } catch (e) { return e.name; } };
        const blank = document.createElement('iframe');
        document.body.appendChild(blank);
        const srcdoc = document.createElement('iframe');
        srcdoc.srcdoc = '<p>x</p>';
        await new Promise(res => { srcdoc.onload = res; document.body.appendChild(srcdoc); });
        return { blank: reach(blank), blankDocument: blank.contentDocument, srcdoc: reach(srcdoc), indexed: (() => { try { return typeof window[1].RTCPeerConnection; } catch (e) { return e.name; } })(), names: ${PEER_CONNECTION_NAMES} };
    `);
    expect(r).toEqual({ blank: 'SecurityError', blankDocument: null, srcdoc: 'SecurityError', indexed: 'SecurityError', names: [] });
});

test('worker mode: the worker has no peer-connection constructor', async ({ sandbox }) => {
    expect(await sandbox.mount({ mode: 'worker' })).toBe('ready');
    expect(await sandbox.inGuest(`return { pc: typeof RTCPeerConnection, names: ${PEER_CONNECTION_NAMES} }`)).toEqual({ pc: 'undefined', names: [] });
});

// ---- 3. the residual -------------------------------------------------------------------------------

// Gathers ICE candidates against a STUN and a TURN server on 127.0.0.1:<port> for `ms` and reports what it saw. The
// controls run longer (CONTROL_MS): on a CI runner Firefox gathered host candidates while its host-page control
// delivered no packet to the listener within 3 s (passing locally), so the control gets a wider window and reports
// its candidates when it hears nothing.
const CONTROL_MS = 8000;
const iceProbe = (port: number, ms = 3000) => `(done) => {
    const r = { pc: typeof RTCPeerConnection, candidates: [] };
    if (typeof RTCPeerConnection !== 'function') { done(r); return; }
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }, { urls: 'turn:127.0.0.1:${port}?transport=udp', username: 'u', credential: 'c' }] });
    pc.createDataChannel('x');
    pc.onicecandidate = (e) => { if (e.candidate) r.candidates.push(e.candidate.type); };
    pc.createOffer().then(o => pc.setLocalDescription(o));
    setTimeout(() => { pc.close(); done(r); }, ${ms});
}`;

// The probe in a frame a cooperative-mode guest creates: the residual of section 3, and the positive control of
// section 4. Returns what the frame reported and how many UDP packets the listener heard while it ran.
async function nestedProbe(sandbox: SandboxDriver, port: number, heard: () => number) {
    const before = heard();
    expect(await sandbox.mount()).toBe('ready');
    const nested = await sandbox.inGuest(`return await new Promise(res => {
        addEventListener('message', e => { if (e.data && e.data.ice) res(e.data.ice); });
        const frame = document.createElement('iframe');
        frame.srcdoc = '<script>(' + ${JSON.stringify(iceProbe(port, CONTROL_MS))} + ')(r => parent.postMessage({ ice: r }, "*"))<\\/script>';
        document.body.appendChild(frame);
        setTimeout(() => res('timeout'), ${CONTROL_MS + 5000});
    })`, CONTROL_MS + 15000) as { pc: string; candidates: string[] };
    return { nested, packets: heard() - before };
}

// Measured on a GitHub Actions runner (2026-10-14): Firefox there gathered no ICE candidate at all in the host page
// and its frames' STUN traffic never reached the loopback listener, while it does in this repository's container. Where
// the browser sends nothing a listener can hear, packet silence is not evidence, and the run says so (annotation)
// instead of passing on silence or failing on the environment. Only Firefox is given this allowance; Chromium and
// WebKit must be heard.
function packetsMeasurable(browserName: string, controlPackets: number, detail: string): boolean {
    if (controlPackets > 0) return true;
    expect(browserName, `no ICE packet reached the listener (${detail})`).toBe('firefox');
    test.info().annotations.push({ type: 'not measurable here', description: `Firefox sent no ICE packet a loopback listener could hear (${detail}); the structural assertions stand, the packet assertion was not evaluated` });
    return false;
}

test('residual: a frame the guest creates keeps RTCPeerConnection, and its ICE traffic leaves (measured; Firefox with loopback ICE on)', async ({ sandbox, browserName }) => {
    test.setTimeout(60000);
    const udp = dgram.createSocket('udp4');
    let packets = 0;
    udp.on('message', () => packets++);
    await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve));
    const port = (udp.address() as AddressInfo).port;
    try {
        const { nested, packets: nestedPackets } = await nestedProbe(sandbox, port, () => packets);
        expect(nested.pc).toBe('function'); // the residual: the created frame is a realm of its own with RTCPeerConnection
        expect(nested.candidates).toContain('host');
        // and its ICE traffic leaves: heard by the listener wherever the browser sends any (packetsMeasurable)
        packetsMeasurable(browserName, nestedPackets, `nested frame candidates ${JSON.stringify(nested.candidates)}`);
    } finally {
        udp.close();
    }
});

// ---- 4. strict mode -----------------------------------------------------------------------------------

test('strict mode: no peer connection in the worker; a rendered frame carrying the ICE probe is absent, nothing runs, no UDP leaves (control: the same probe in a frame a cooperative guest creates)', async ({ sandbox, page, browserName }) => {
    test.setTimeout(60000);
    const udp = dgram.createSocket('udp4');
    let packets = 0;
    udp.on('message', () => packets++);
    await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve));
    const port = (udp.address() as AddressInfo).port;
    try {
        expect(await sandbox.mount({ mode: 'strict' })).toBe('ready');
        expect(await sandbox.inGuest(`return { pc: typeof RTCPeerConnection, names: ${PEER_CONNECTION_NAMES} }`)).toEqual({ pc: 'undefined', names: [] });

        const probe = `<script>(${iceProbe(port)})(r => (globalThis.__ran = globalThis.__ran || []).push('ice ' + r.candidates.length))</script>`;
        const html = `<iframe srcdoc="${probe.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe><iframe sandbox="allow-scripts" srcdoc="${probe.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>${probe}<p id="done">done</p>`;
        await sandbox.run(`sandboxView.render(${JSON.stringify(html)})`);
        await waitInView(page, browserName, `!!document.getElementById('done')`);
        await page.waitForTimeout(4000); // the probe would report after 3 s

        const frames = await inFrames<string[]>(page, browserName, '(globalThis.__ran || [])');
        expect(frames.map(f => f.path)).toEqual(['main', 'main/wrapper', 'main/wrapper/view']); // no frame was created
        expect(frames.flatMap(f => (f.value === 'no-context' ? [] : f.value))).toEqual([]);
        const strictPackets = packets;
        expect(strictPackets).toBe(0);

        // control: the same probe in a frame a cooperative guest creates, which strict mode is there to close
        const control = await nestedProbe(sandbox, port, () => packets);
        expect(control.nested.pc).toBe('function');
        // the listener hears the control's ICE, so the silence above is evidence (where the browser sends any at all)
        packetsMeasurable(browserName, control.packets, `control candidates ${JSON.stringify(control.nested.candidates)}`);
    } finally {
        udp.close();
    }
});
