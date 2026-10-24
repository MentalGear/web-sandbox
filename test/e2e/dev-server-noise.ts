import { E2E_PORT } from './server';

/**
 * A console line of the dev server's client, not of the library: the e2e server runs Vite without its HMR socket
 * (vite.config.ts), so the client Vite injects into the harness page fails to connect and says so, and WebKit also
 * reports the refused handshake. A spec that asserts the host page's console is clean leaves these out, and only these.
 */
export function isDevServerNoise(text: string): boolean {
    return text.startsWith('[vite]') || (text.startsWith(`WebSocket connection to 'ws://localhost:${E2E_PORT}/`) && text.includes('did not accept the WebSocket handshake'));
}
