/**
 * Installs the network modes (research 24, D9; ADR-009): their methods on the element's prototype (network-host.ts,
 * NetworkMethods), and their part of the config schema and of the hashed bootstrap in the seam's slot
 * (network-modes.ts). The network build's entry (src/network.ts) calls it once, as it is imported, before any element
 * exists; a test of a network mode gets it the same way, by importing that entry.
 *
 * Host-side only.
 */
import { WebSandbox } from '../host';
import { BRIDGE_FRAME_OPTIONS, inBridgeFrame } from './in-bridge-frame';
import { NETWORK_RULES, readHostPage, refusalDetail } from './network-config';
import { NetworkMethods } from './network-host';
import { mintUncodedError } from './minted-errors';
import { installNetworkModes as fillSlot, NETWORK_ELEMENT_METHODS, type NetworkModes } from './network-modes';

/**
 * The fetch bridge frame's part of the library's one hashed bootstrap (in-sandbox-view.ts, viewBootstrapSource): the
 * frame's function, called with its options, as text.
 */
export const BRIDGE_BOOTSTRAP = `(${inBridgeFrame.toString()})(${JSON.stringify(BRIDGE_FRAME_OPTIONS).replaceAll('<', '\\u003c')});`;

/** What the slot holds in a build with the network modes. */
export const NETWORK_MODES_BUILD: NetworkModes = Object.freeze({ rules: NETWORK_RULES, readHostPage, refusalDetail, bridgeBootstrap: BRIDGE_BOOTSTRAP });

/**
 * The element's prototype gets every method of NetworkMethods, as its own methods are: not enumerable. The ones the
 * element calls must be among them (NETWORK_ELEMENT_METHODS): a build that lacks one is refused here, as it starts.
 */
function installMethods(): void {
    const methods = Object.getOwnPropertyDescriptors(NetworkMethods.prototype);
    for (const name of NETWORK_ELEMENT_METHODS) {
        if (typeof methods[name]?.value !== 'function') throw mintUncodedError(Error, `the network modes have no method ${name}`);
    }
    for (const name of Object.keys(methods)) {
        if (name === 'constructor') continue;
        Object.defineProperty(WebSandbox.prototype, name, methods[name]!);
    }
}

/** The network modes, installed: the element's methods first, then the slot that says the build has them. */
export function installNetworkModes(): void {
    installMethods();
    fillSlot(NETWORK_MODES_BUILD);
}
