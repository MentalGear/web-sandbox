/**
 * The realms, channels and frames: ARCHITECTURE.md's tables and ADR-005's port table, from src/lib/realms.ts and
 * src/lib/frames.ts.
 */
import { CHANNELS, FRAMES, type ChannelId, type FrameRoute, type FrameType } from '../../../src/lib/frames';
import { REALMS, STRINGIFIED, type RealmId, type StringifiedName } from '../../../src/lib/realms';
import { signatureOf, type Item } from '../engine';
import { code, row, table, type Extractor } from './markdown';

const realmIds = () => Object.keys(REALMS) as RealmId[];
const channelIds = () => Object.keys(CHANNELS) as ChannelId[];
const frameTypes = () => Object.keys(FRAMES) as FrameType[];
const stringifiedNames = () => Object.keys(STRINGIFIED) as StringifiedName[];
const routesOf = (type: FrameType): readonly FrameRoute[] => FRAMES[type].routes;
const list = (values: readonly string[]) => (values.length ? values.map(code).join(', ') : '—');

/** The functions stringified into a realm. */
const runsIn = (realm: RealmId) => stringifiedNames().filter(name => (STRINGIFIED[name].realms as readonly RealmId[]).includes(realm));
/** The realms that speak on a channel, from the realms registry. */
const speakers = (channel: ChannelId) => realmIds().filter(id => (REALMS[id].channels as readonly ChannelId[]).includes(channel));
/** The frame types that cross a channel. */
const crossing = (channel: ChannelId) => frameTypes().filter(type => routesOf(type).some(route => route.channel === channel));
const boundsOf = (type: FrameType) => Object.fromEntries(Object.entries(FRAMES[type].fields).map(([name, field]) => [name, field.bound]));

// Signatures: what a prose section that describes the item would have to follow, never a summary's wording.
const realmSignature = (id: RealmId) => ({ guestCode: REALMS[id].guestCode, builder: REALMS[id].builder, channels: REALMS[id].channels, egress: REALMS[id].egress, runs: runsIn(id) });
const channelSignature = (id: ChannelId) => ({ kind: CHANNELS[id].kind, speakers: speakers(id), frames: crossing(id) });
const frameSignature = (type: FrameType) => ({ routes: routesOf(type), fields: boundsOf(type) });
const stringifiedSignature = (name: StringifiedName) => ({ realms: STRINGIFIED[name].realms, scans: [STRINGIFIED[name].capture === true, STRINGIFIED[name].readOnce === true, STRINGIFIED[name].typeofRead === true] });

const rows = (prefix: string, all: readonly Item[]) => all.filter(item => item.id.startsWith(prefix)).map(item => item.render());

const items = (): Item[] => {
    const all: Item[] = [
        ...realmIds().map(id => ({
            id: `realm:${id}`,
            signature: signatureOf(realmSignature(id)),
            render: () => row([code(id), REALMS[id].summary, REALMS[id].guestCode ? 'yes' : 'no', list(runsIn(id)), list(REALMS[id].channels)]),
        })),
        ...channelIds().map(id => ({
            id: `channel:${id}`,
            signature: signatureOf(channelSignature(id)),
            render: () => row([code(id), CHANNELS[id].kind, list(speakers(id)), CHANNELS[id].summary, `${crossing(id).length}`]),
        })),
        ...frameTypes().map(type => ({
            id: `frame:${type}`,
            signature: signatureOf(frameSignature(type)),
            render: () => row([
                code(type),
                routesOf(type).map(route => `${code(route.channel)}: ${route.from.join(', ')} → ${route.to.join(', ')}`).join('<br>'),
                Object.keys(FRAMES[type].fields).length ? Object.entries(FRAMES[type].fields).map(([name, field]) => `${code(name)} (${field.bound})`).join(', ') : '—',
                FRAMES[type].purpose,
            ]),
        })),
        ...stringifiedNames().map(name => ({
            id: `stringified:${name}`,
            signature: signatureOf(stringifiedSignature(name)),
            render: () => row([code(name), code(STRINGIFIED[name].module), list(STRINGIFIED[name].realms)]),
        })),
    ];
    return [
        ...all,
        { id: 'realms', signature: signatureOf([realmIds().map(id => [id, realmSignature(id)]), stringifiedNames().map(name => [name, stringifiedSignature(name)])]), render: () => '' },
        { id: 'channels', signature: signatureOf(channelIds().map(id => [id, channelSignature(id)])), render: () => '' },
        { id: 'frames', signature: signatureOf(frameTypes().map(type => [type, frameSignature(type)])), render: () => '' },
        { id: 'adr005:ports', signature: signatureOf({ ports: ports(), initView: Object.keys(FRAMES.INIT_VIEW.fields) }), render: () => '' },
    ];
};

// ---- ADR-005: the three ports of a strict environment

const STRICT_REALMS: readonly RealmId[] = ['host', 'view', 'strict-worker'];
const touchesStrict = (route: FrameRoute) => [...route.from, ...route.to].some(realm => realm === 'view' || realm === 'strict-worker');

/** Each MessagePort a strict environment uses: the strict realms at its ends, and the frame types it carries between them. */
function ports(): { channel: ChannelId; ends: RealmId[]; carries: FrameType[] }[] {
    return channelIds().filter(id => CHANNELS[id].kind === 'MessagePort').map(channel => {
        const routes = frameTypes().flatMap(type => routesOf(type).filter(route => route.channel === channel && touchesStrict(route)).map(route => ({ type, route })));
        const ends = STRICT_REALMS.filter(realm => routes.some(({ route }) => [...route.from, ...route.to].includes(realm)));
        return { channel, ends, carries: [...new Set(routes.map(({ type }) => type))] };
    }).filter(port => port.carries.length > 0);
}

const portTable = () => table(['Port', 'Ends', 'Carries'], ports().map(({ channel, ends, carries }) => row([
    channel.replace(/-port$/, ''),
    ends.join(' ↔ ') + (ends.includes('host') ? '' : ' (the host is not on this path)'),
    list(carries),
])));

/** The sentence ADR-005 says what the host hands the view in: INIT_VIEW with its fields. */
const initView = () => `On the wrapper's one \`load\`, the host posts \`INIT_VIEW { ${Object.keys(FRAMES.INIT_VIEW.fields).join(', ')} }\` to the view with the logic and view ports.`;

export const frames: Extractor = {
    items,
    regions: {
        realms: () => table(['Realm', 'What it is', 'Guest code', 'Code stringified into it', 'Channels'], rows('realm:', items())),
        stringified: () => table(['Function', 'Module', 'Realms'], rows('stringified:', items())),
        channels: () => table(['Channel', 'Kind', 'Spoken in', 'What it is for', 'Frame types'], rows('channel:', items())),
        frames: () => table(['Frame', 'Route', 'Fields (what bounds each)', 'Purpose'], rows('frame:', items())),
        'adr005-ports': portTable,
        'adr005-init-view': initView,
    },
};
