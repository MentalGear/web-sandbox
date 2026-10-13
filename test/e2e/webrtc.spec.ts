import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { test, expect } from './fixture';

/**
 * Backlog S13: WebRTC. ICE gathering sends UDP to STUN/TURN servers that no CSP directive governs
 * (connect-src does not apply; `webrtc 'block'` and Chromium's local-network-access policy changed
 * nothing, measured 2026-10-13). Guarantees, per engine:
 *   1. the guest's own realm has no peer-connection constructor, from its first script on (iframe mode),
 *      and a worker never has one (worker mode);
 *   2. the guest cannot take it back from another realm: every frame it creates is cross-origin to it;
 * and the residual, asserted as measured so a change is noticed:
 *   3. a frame the guest creates is a realm of its own, runs its own script and keeps RTCPeerConnection;
 *      in Chromium and WebKit its ICE gathering reaches a loopback UDP listener. Firefox sends nothing to a
 *      loopback STUN/TURN server even from the host page (the listener's control), so there only
 *      candidate gathering is observable.
 */

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

test('residual: a frame the guest creates keeps RTCPeerConnection, and in Chromium and WebKit its ICE traffic leaves (measured)', async ({ sandbox, browserName }) => {
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
        if (browserName === 'firefox') {
            // Firefox sends no STUN/TURN traffic to a loopback server, not even from the host page
            expect({ hostPackets, nestedPackets: packets }).toEqual({ hostPackets: 0, nestedPackets: 0 });
        } else {
            expect(hostPackets).toBeGreaterThan(0);
            expect(packets).toBeGreaterThan(0);
        }
    } finally {
        udp.close();
    }
});
