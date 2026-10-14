import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { test, expect } from './fixture';
import { inFrames, waitInView } from './strict-view';

/**
 * Backlog S13: WebRTC. ICE gathering sends UDP to STUN/TURN servers that no CSP directive governs
 * (connect-src does not apply; `webrtc 'block'` and Chromium's local-network-access policy changed
 * nothing, measured 2026-10-13). Guarantees, per engine:
 *   1. the guest's own realm has no peer-connection constructor, from its first script on (iframe mode),
 *      and a worker never has one (worker mode);
 *   2. the guest cannot take it back from another realm: every frame it creates is cross-origin to it;
 * and the residual, asserted as measured so a change is noticed:
 *   3. a frame the guest creates is a realm of its own, runs its own script and keeps RTCPeerConnection;
 *      its ICE gathering reaches a loopback UDP listener on every engine.
 * Strict mode (ADR-005) closes the residual by construction:
 *   4. guest code runs in a worker, which has no peer-connection constructor, and the view runs no guest
 *      script; a frame in rendered markup is removed before it is inserted (A1), so the same ICE probe
 *      never runs and no UDP reaches the listener, while the host-page control does, on every engine.
 *
 * The positive control on Firefox (independent verification 2026-10-14): Firefox sends no STUN/TURN traffic to a
 * loopback server by default, not even from the host page, which left "no UDP from strict mode" without a control
 * there. This file runs Firefox with `media.peerconnection.ice.loopback` on (Playwright's firefoxUserPrefs; the other
 * engines ignore it), so the host-page control sends packets on all three engines and silence means something. The
 * pref changes only where ICE may send, not whether a realm has RTCPeerConnection.
 */

test.use({ launchOptions: { firefoxUserPrefs: { 'media.peerconnection.ice.loopback': true } } });

const PEER_CONNECTION_NAMES = `Object.getOwnPropertyNames(globalThis).filter(n => /^(webkit|moz)?RTCPeerConnection$/.test(n))`;

test('iframe mode, shipping config: the first guest script finds no peer-connection constructor', async ({ sandbox, page }) => {
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

// Gathers ICE candidates against a STUN and a TURN server on 127.0.0.1:<port> for 3 s and reports what it saw.
const iceProbe = (port: number) => `(done) => {
    const r = { pc: typeof RTCPeerConnection, candidates: [] };
    if (typeof RTCPeerConnection !== 'function') { done(r); return; }
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }, { urls: 'turn:127.0.0.1:${port}?transport=udp', username: 'u', credential: 'c' }] });
    pc.createDataChannel('x');
    pc.onicecandidate = (e) => { if (e.candidate) r.candidates.push(e.candidate.type); };
    pc.createOffer().then(o => pc.setLocalDescription(o));
    setTimeout(() => { pc.close(); done(r); }, 3000);
}`;

test('residual: a frame the guest creates keeps RTCPeerConnection, and its ICE traffic leaves (measured; Firefox with loopback ICE on)', async ({ sandbox }) => {
    test.setTimeout(45000);
    const udp = dgram.createSocket('udp4');
    let packets = 0;
    udp.on('message', () => packets++);
    await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve));
    const port = (udp.address() as AddressInfo).port;
    try {
        // control for the listener: the host page itself, outside any sandbox
        const host = await sandbox.page.evaluate(`new Promise(res => (${iceProbe(port)})(res))`) as { pc: string; candidates: string[] };
        const hostPackets = packets;
        packets = 0;

        expect(await sandbox.mount()).toBe('ready');
        const nested = await sandbox.inGuest(`return await new Promise(res => {
            addEventListener('message', e => { if (e.data && e.data.ice) res(e.data.ice); });
            const frame = document.createElement('iframe');
            frame.srcdoc = '<script>(' + ${JSON.stringify(iceProbe(port))} + ')(r => parent.postMessage({ ice: r }, "*"))<\\/script>';
            document.body.appendChild(frame);
            setTimeout(() => res('timeout'), 10000);
        })`, 20000);

        expect(host.pc).toBe('function');
        expect(nested.pc).toBe('function');
        expect(nested.candidates).toContain('host');
        expect(hostPackets).toBeGreaterThan(0);
        expect(packets).toBeGreaterThan(0);
    } finally {
        udp.close();
    }
});

// ---- 4. strict mode -----------------------------------------------------------------------------------

test('strict mode: no peer connection in the worker; a rendered frame carrying the ICE probe is absent, nothing runs, no UDP leaves (control: the host page, every engine)', async ({ sandbox, page, browserName }) => {
    test.setTimeout(45000);
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

        // control: the host page itself, outside any sandbox
        packets = 0;
        const host = await page.evaluate(`new Promise(res => (${iceProbe(port)})(res))`) as { pc: string; candidates: string[] };
        expect(host.pc).toBe('function');
        expect(strictPackets).toBe(0);
        expect(packets).toBeGreaterThan(0); // the listener hears the host page's ICE: silence above is evidence
    } finally {
        udp.close();
    }
});
