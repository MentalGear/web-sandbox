import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWebSandbox, WebSandbox } from '@src/index';
import { BUILD_ENTRIES, buildFor, buildOfMode, BUILDS, NETWORK_MODES_FLAG } from '@src/lib/build-flag';
import { BUILD_CLASSES, BUILD_MODULES, modulesOf, type ModuleClass, type SourceModule } from '@src/lib/build-modules';
import { CONFIG_SCHEMA, ConfigRefusal, NETWORK_MODES, NETWORK_OPTIONS, normaliseConfig, NO_HOST_PAGE, readIn, SANDBOX_MODES } from '@src/lib/config-schema';
import { BRIDGE_ROLE, viewBootstrapText } from '@src/lib/in-sandbox-view';
import { NETWORK_ELEMENT_METHODS, networkModes } from '@src/lib/network-modes';
import { NETWORK_MODE_REALMS, STRINGIFIED, type StringifiedName } from '@src/lib/realms';
import { reasonText, TERMINATION_REASONS } from '@src/lib/reasons';
import { code, graphOf, member } from './call-graph';
import { networkMethodNames } from './element-source';
import { edgesOf, reachable, sourceModules } from './module-graph';

/**
 * The default build (research 24, D9; ADR-009): the package with the build flag off, which is sealed mode alone. This
 * file imports the default build's entry and nothing of the network modes, so the element it mounts is that build's.
 *
 *  - The flag is one value, off by default, and the modes and options behind it are the config schema's.
 *  - The module graph: every module of src/ is classified (BUILD_MODULES, the allowlist with its domain enumerated), the
 *    default entry reaches `sealed` modules only, at run time and for a type, and the network entry reaches every
 *    `network` module. So a change that pulls a network module back into the default build fails here, whatever it pulls.
 *  - The stringified sources, which no import shows: a function the library stringifies into a realm only the network
 *    modes build (NETWORK_MODE_REALMS) is stringified by a network module, and the guest's bootstrap is stringified in
 *    the default build for strict mode's worker alone.
 *  - The bundle: `bun scripts/build-lib.ts` writes the default build from `sealed` modules alone (it refuses any other),
 *    and no function a network module declares is in it; the network build's bundle has them (the positive control).
 *  - The refusal: a config that asks for a network mode or option is refused whole, with a reason that names the flag,
 *    before anything of it is applied.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const classOf = (file: string): ModuleClass | undefined => (BUILD_MODULES as Record<string, ModuleClass>)[file];
const ofClass = (wanted: ModuleClass) => (Object.keys(BUILD_MODULES) as SourceModule[]).filter(file => BUILD_MODULES[file] === wanted);

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('the build flag', () => {
    it('is one value, off by default: only its one value turns it on', () => {
        expect(NETWORK_MODES_FLAG.default).toBe(false);
        expect(BUILDS).toEqual(['default', 'network']);
        for (const value of [undefined, '', '0', 'true', 'on', 'yes', ' 1', '1 ']) expect(buildFor(value), String(value)).toBe('default');
        expect(buildFor(NETWORK_MODES_FLAG.on)).toBe('network');
        expect(NETWORK_MODES_FLAG.command).toBe(`${NETWORK_MODES_FLAG.env}=${NETWORK_MODES_FLAG.on} bun run build:lib`);
    });

    it("the modes and options behind it are the schema's network modes and options, and sealed mode is the one mode outside it", () => {
        expect(NETWORK_MODES).toBe(NETWORK_MODES_FLAG.modes);
        expect(NETWORK_OPTIONS).toBe(NETWORK_MODES_FLAG.options);
        expect([...SANDBOX_MODES].sort()).toEqual(['sealed', ...NETWORK_MODES_FLAG.modes].sort());
        for (const mode of SANDBOX_MODES) expect(buildOfMode(mode), mode).toBe(mode === 'sealed' ? 'default' : 'network');
        expect(buildOfMode(undefined)).toBe('default'); // a config with no mode is sealed
        for (const option of NETWORK_MODES_FLAG.options) expect(CONFIG_SCHEMA[option].modes, option).toBe(NETWORK_MODES);
    });

    it('the build script, the declarations and the scripts of package.json read the flag from its declaration', () => {
        for (const script of ['scripts/build-lib.ts', 'scripts/emit-declarations.ts']) {
            const text = readFileSync(path.join(ROOT, script), 'utf8');
            expect(text, script).toContain('buildFor(process.env[NETWORK_MODES_FLAG.env])');
            expect(text.replace(/\/\*[\s\S]*?\*\//g, ''), `${script} names the variable itself`).not.toContain(NETWORK_MODES_FLAG.env);
        }
        // package.json cannot read the declaration: its two scripts that build both builds spell the flag as declared
        const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
        const spelled = Object.keys(scripts).filter(name => scripts[name]!.includes('WEB_SANDBOX_'));
        expect(spelled).toEqual(['api:check', 'api:update']);
        for (const name of spelled) expect(scripts[name], name).toContain(`${NETWORK_MODES_FLAG.env}=${NETWORK_MODES_FLAG.on} bun run build:lib && `);
    });
});

describe('the module graph: the default build is made of sealed modules alone', () => {
    it('every module of src/ is classified, and every row is a module (the domain, enumerated)', () => {
        expect(Object.keys(BUILD_MODULES).sort()).toEqual(sourceModules());
        expect(BUILD_CLASSES).toEqual({ default: ['sealed'], network: ['sealed', 'network'] });
        for (const build of BUILDS) expect(classOf(BUILD_ENTRIES[build]), build).toBe(build === 'default' ? 'sealed' : 'network');
    });

    it('the default entry reaches every sealed module and no other, at run time', () => {
        const reached = [...reachable(BUILD_ENTRIES.default)].sort();
        expect(reached.filter(file => classOf(file) !== 'sealed'), 'the default build imports a module that is not sealed mode\'s').toEqual([]);
        expect(reached).toEqual(modulesOf('default').sort());
    });

    it('nor for a type: a sealed module names no type of a network module, and reaches none but through a registry', () => {
        for (const file of ofClass('sealed')) {
            const direct = edgesOf(file).map(edge => edge.to).filter(to => classOf(to) === 'network');
            expect(direct, `${file} imports a module of the network modes`).toEqual([]);
        }
        // What the default build's declarations still hold of the network modes: the modules a registry names (the limits
        // table reads the fetch bridge's bounds), reached for a type through that registry and no other way.
        const typed = [...reachable(BUILD_ENTRIES.default, true)].filter(file => classOf(file) === 'network').sort();
        expect(typed).toEqual(['src/lib/fetch-bridge.ts', 'src/lib/in-bridge-frame.ts']);
        const registries = ofClass('data').filter(file => edgesOf(file).some(edge => typed.includes(edge.to)));
        expect(registries).toEqual(['src/lib/limits.ts']);
    });

    it('the network entry reaches every sealed and every network module, and no build reaches a registry at run time', () => {
        const reached = reachable(BUILD_ENTRIES.network);
        const typesOnly = ['src/lib/network-types.ts']; // declarations alone: no code to reach
        expect([...reached].sort()).toEqual(modulesOf('network').filter(file => file !== BUILD_ENTRIES.default && !typesOnly.includes(file)).sort());
        expect(reachable(BUILD_ENTRIES.network, true).has('src/lib/network-types.ts')).toBe(true);
        for (const file of ofClass('data')) expect(reached.has(file), file).toBe(false);
    });

    it('the seam is never filled in the default build: nothing it reaches installs the network modes, and the element has none of their methods', () => {
        const installers = [...reachable(BUILD_ENTRIES.default)].filter(file => /\binstallNetworkModes\(/.test(code(file).replace('export function installNetworkModes(', '')));
        expect(installers).toEqual([]);
        expect(networkModes()).toBeNull();
        expect(networkMethodNames().length).toBeGreaterThan(20);
        expect(networkMethodNames()).toEqual(expect.arrayContaining([...NETWORK_ELEMENT_METHODS]));
        for (const name of networkMethodNames()) expect(name in WebSandbox.prototype, name).toBe(false);
    });
});

describe('the stringified sources: what no import shows', () => {
    const networkOnly = (Object.keys(STRINGIFIED) as StringifiedName[]).filter(name => (STRINGIFIED[name].realms as readonly string[]).every(realm => (NETWORK_MODE_REALMS as readonly string[]).includes(realm)));
    const stringifiers = (name: string) => sourceModules().filter(file => new RegExp(`\\b${name}\\.toString\\(\\)`).test(code(file)));

    it('a function stringified only into a realm of the network modes is stringified by a network module, and declared in one or left out of the bundle', () => {
        expect(networkOnly.sort()).toEqual(['inBridgeFrame', 'inSandboxImportMap', 'inSandboxMarkup', 'workerBootstrap']);
        for (const name of networkOnly) {
            expect(stringifiers(name).length, name).toBeGreaterThan(0);
            for (const file of stringifiers(name)) expect(classOf(file), `${name} is stringified by ${file}`).toBe('network');
        }
    });

    it("the default build stringifies the guest's bootstrap for strict mode's worker alone: sealed mode's, with `sealed` set", () => {
        const inDefault = stringifiers('inSandboxScript').filter(file => classOf(file) === 'sealed');
        expect(inDefault).toEqual(['src/host.ts']);
        const users = [...graphOf('src/host.ts').units].filter(([, text]) => text.includes('inSandboxScript.toString()')).map(([name]) => name);
        expect(users).toEqual(['this._getStrictWorkerSource']);
        expect(member('_getStrictWorkerSource')).toContain("(${inSandboxScript.toString()})(${scriptUnsafe}, 'strict', console,");
        // with no network (the default build's only call: _prepareSealedFrame hands null), the features say `sealed`
        expect(member('_getStrictWorkerSource')).toContain("listeners: bootstrapListeners('sealed'), uncaught: { ...UNCAUGHT_BUDGET }, connect: [], sealed: true,");
        expect(member('_prepareSealedFrame')).toMatch(/return this\._prepareViewFrame\(built, files, this\._sealedPolicy\(files\), null\);\s*$/);
    });

    it("the default build's hashed bootstrap runs the view alone: it has no fetch bridge frame's part", () => {
        const text = viewBootstrapText();
        expect(text).not.toContain(BRIDGE_ROLE);
        expect(text).not.toContain('function inBridgeFrame(');
        expect(text.startsWith("(function () {'use strict';if ((function checkSandboxEnvironment(")).toBe(true);
    });
});

describe('the bundle: `bun scripts/build-lib.ts` writes the default build from sealed modules alone', () => {
    const out = (build: string) => `temp/default-build-test/${build}`;
    const bundle = (build: 'default' | 'network') => {
        const env = { ...process.env };
        delete env[NETWORK_MODES_FLAG.env];
        if (build === 'network') env[NETWORK_MODES_FLAG.env] = NETWORK_MODES_FLAG.on;
        const built = spawnSync('bun', ['scripts/build-lib.ts', '--out', out(build)], { cwd: ROOT, env, encoding: 'utf8' });
        expect(built.status, built.stderr).toBe(0);
        expect(built.stdout).toContain(`the ${build} build`);
        return readFileSync(path.join(ROOT, out(build), 'index.js'), 'utf8');
    };
    /** The functions a module declares at its top level, exported or not. */
    const functionsOf = (file: string) => [...code(file).matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map(match => match[1]!);
    const declares = (text: string, name: string) => new RegExp(`\\bfunction ${name}\\(`).test(text);

    it('no function a network module declares is in the default bundle, and each is in the network bundle (the positive control)', () => {
        const defaultBundle = bundle('default');
        const networkBundle = bundle('network');
        const names = ofClass('network').flatMap(functionsOf);
        expect(names.length).toBeGreaterThan(40);
        expect(names.filter(name => declares(defaultBundle, name)), "a network module's function is in the default bundle").toEqual([]);
        // not every one is in the network bundle either (a bundler leaves out what nothing calls), but most are
        expect(names.filter(name => declares(networkBundle, name)).length).toBeGreaterThan(40);
        for (const name of ['inBridgeFrame', 'workerBootstrap', 'createFetchBridge', 'parseOrigins', 'hostReach', 'limitHostReach', 'rewriteGuestMarkup', 'toFetchPolicy']) {
            expect(declares(networkBundle, name), name).toBe(true);
        }
        // nor the methods the network build installs on the element, nor the functions stringified for its realms alone
        // (the class calls the seam's by name; none is declared, and no other is named at all)
        const declaresMethod = (text: string, name: string) => new RegExp(`\\n\\s+${name}\\([^)]*\\) \\{`).test(text);
        for (const name of networkMethodNames()) {
            expect(declaresMethod(defaultBundle, name), name).toBe(false);
            expect(declaresMethod(networkBundle, name), name).toBe(true);
            if (!(NETWORK_ELEMENT_METHODS as readonly string[]).includes(name)) expect(new RegExp(`\\b${name}\\(`).test(defaultBundle), name).toBe(false);
        }
        for (const name of ['inSandboxImportMap', 'inSandboxMarkup']) {
            expect(declares(defaultBundle, name), name).toBe(false);
            expect(declares(networkBundle, name), name).toBe(true);
        }
        expect(defaultBundle.length).toBeLessThan(networkBundle.length);
        rmSync(path.join(ROOT, 'temp/default-build-test'), { recursive: true, force: true });
    }, 60_000);

    it('the build script refuses to write a bundle that holds a module of another build', () => {
        const script = readFileSync(path.join(ROOT, 'scripts/build-lib.ts'), 'utf8');
        expect(script).toContain('const allowed = new Set<string>(modulesOf(build));');
        expect(script).toMatch(/if \(foreign\.length > 0\) \{\s*rmSync\(join\(outdir, 'index\.js'\), \{ force: true \}\);[\s\S]*?process\.exit\(1\);/);
        expect(existsSync(path.join(ROOT, 'scripts/emit-declarations.ts'))).toBe(true);
    });
});

describe('the tests: each runs against its build, and the wrong pairing fails', () => {
    const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
    const filesIn = (directory: string): string[] => readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
        const file = `${directory}/${entry.name}`;
        if (entry.isDirectory()) return filesIn(file);
        return /\.(ts|html|js|mjs)$/.test(entry.name) ? [file] : [];
    });
    // An entry of the library, or its element's module, named in a page or a spec: an import, or a URL a page loads.
    const ENTRY = /(?:@src|\/src)\/(?:host|index|network|sealed)(?:\.ts)?['"`]/;
    const namesAnEntry = (file: string) => read(file).split('\n').some(line => ENTRY.test(line) && !/^\s*import type\b/.test(line));

    it("the e2e pages take the library from one module, by the build the fixture names: no page or spec imports an entry itself", () => {
        const pages = [...filesIn('test/e2e'), ...filesIn('docs/research')].filter(namesAnEntry).sort();
        // library.ts loads the entry of the page's build; host-site.spec.ts writes pages of its own, of the network build, and says so
        expect(pages).toEqual(['test/e2e/host-site.spec.ts', 'test/e2e/library.ts']);
        expect(read('test/e2e/host-site.spec.ts')).toContain("test.use({ build: 'network' });");
        expect(read('test/e2e/host-site.spec.ts')).not.toMatch(/\/src\/(?:host|index|sealed)\.ts/);
        const library = read('test/e2e/library.ts');
        expect(library).toContain("if (pageBuild() === 'network') return import('@src/network');");
        expect(library).toContain("return import('@src/index')");
    });

    it("the fixture pairs every test's page with its build before any script runs, the default build unless the test names the other", () => {
        const fixture = read('test/e2e/fixture.ts');
        expect(fixture).toContain("build: ['default', { option: true }],");
        expect(fixture).toContain('otherBuildConfigs: [false, { option: true }],');
        expect(fixture).toMatch(/paired: \[async \(\{ context, build, otherBuildConfigs \}, use\) => \{\s*await pairWithBuild\(context, build, otherBuildConfigs\);\s*await use\(\);\s*\}, \{ auto: true \}\],/);
        // the guard: a network mode on the default build, a sealed config on the network build, each throws from setConfig()
        expect(fixture).toContain("if (build === 'default' && network) return");
        expect(fixture).toContain("if (build === 'network' && sealed) return");
        expect(fixture).toContain('networkModes: [...NETWORK_MODES_FLAG.modes]');
    });

    it("a unit test's build is its imports: this file's element is the default build's, and a file of a network mode imports the network entry first", () => {
        const tests = [...filesIn('test/unit'), ...filesIn('src')].filter(file => file.endsWith('.test.ts'));
        const network = tests.filter(file => /^import '@src\/network';/m.test(read(file)));
        expect(network.length).toBeGreaterThan(30);
        expect(read('test/unit/default-build.test.ts')).not.toMatch(/^import [^\n]*'@src\/network'/m);
        expect(read('src/network.ts')).toMatch(/^installNetworkModes\(\);$/m);
    });
});

describe('the refusal: the default build takes no config of a network mode or option', () => {
    const REASON = reasonText('networkModesOff');
    const refusalOf = (config: unknown) => normaliseConfig(config, NO_HOST_PAGE);

    it('the reason names the flag and how to build with it, and no value of the config', () => {
        expect(REASON).toContain(`${NETWORK_MODES_FLAG.env}=${NETWORK_MODES_FLAG.on}`);
        expect(REASON).toContain(NETWORK_MODES_FLAG.command);
        for (const name of [...NETWORK_MODES_FLAG.modes, ...NETWORK_MODES_FLAG.options]) expect(REASON, name).toContain(name);
        expect(TERMINATION_REASONS.networkModesOff.decidedBy).toBe('config');
    });

    it.each(NETWORK_MODES_FLAG.modes)('mode %s is refused whole, with that reason, whatever else the config says', (mode) => {
        for (const config of [{ mode }, { mode, html: '<p>x</p>', capabilities: ['allow-scripts'] }, { mode, origins: { images: ['https://cdn.example'] } }, { mode, scriptUnsafe: true }]) {
            const { value, refusal } = refusalOf(config);
            expect(value, JSON.stringify(config)).toBeNull();
            expect(refusal).toBeInstanceOf(ConfigRefusal);
            expect((refusal as ConfigRefusal).reason).toBe(REASON);
        }
    });

    it.each(NETWORK_MODES_FLAG.options)('%s is refused with no mode, with sealed mode and with a mode that is none: never stripped, never read', (option) => {
        const values = [{}, [], null, 0, '', { images: ['https://cdn.example'] }, { allow: ['https://api.example'] }];
        for (const mode of [undefined, 'sealed', 'banana', 7]) {
            for (const given of values) {
                const config: Record<string, unknown> = { [option]: given };
                if (mode !== undefined) config.mode = mode;
                const { value, refusal, warnings } = refusalOf(config);
                expect(value, JSON.stringify(config)).toBeNull();
                expect((refusal as ConfigRefusal).reason, JSON.stringify(config)).toBe(REASON);
                expect(warnings).toEqual([]);
            }
        }
    });

    it('an option left `undefined` asks for nothing: a sealed config with it is a sealed config', () => {
        const { value, refusal } = refusalOf({ origins: undefined, fetchBridge: undefined, html: '<p>x</p>' });
        expect(refusal).toBeNull();
        expect(value!.config.mode).toBe('sealed');
        expect(value!.fetchPolicy).toBeNull();
        expect(Object.values(value!.origins).flat()).toEqual([]);
    });

    it('no rule of a network option runs in any mode, a mode that is none included: the build has none to run', () => {
        for (const mode of [...SANDBOX_MODES, 'banana', undefined, 7]) {
            expect(readIn(mode).filter(name => (NETWORK_OPTIONS as readonly string[]).includes(name)), String(mode)).toEqual([]);
        }
        for (const option of NETWORK_OPTIONS) expect('read' in CONFIG_SCHEMA[option], option).toBe(false);
        // a mode that is none is stored and refused at every build, as before; it reads no network option either
        const { value } = refusalOf({ mode: 'banana' });
        expect(value!.config.mode).toBe('banana');
    });

    it('the element: the config is refused before anything of it is applied, the sandbox terminates with the reason, and a sealed config builds again', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});
        defineWebSandbox();
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        const reasons: string[] = [];
        el.addEventListener('terminated', (event: CustomEvent) => reasons.push(event.detail.reason));
        el.setConfig({ html: '<p>kept</p>' });
        expect(el.state).toBe('loading');
        for (const config of [{ mode: 'strict' }, { mode: 'cooperative', html: '<script>x()</script>' }, { mode: 'worker' }, { origins: {} }, { mode: 'sealed', fetchBridge: { allow: [] } }]) {
            el.setConfig(config);
            expect(el.state, JSON.stringify(config)).toBe('terminated');
            expect(el.shadowRoot.querySelector('iframe'), JSON.stringify(config)).toBeNull();
            expect([el._config.mode, el._config.html, el._fetchPolicy], JSON.stringify(config)).toEqual(['sealed', '<p>kept</p>', null]);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        expect(reasons).toEqual(Array(5).fill(REASON));
        el.setConfig({ html: '<p>again</p>' });
        expect(el.state).toBe('loading');
        expect(el.shadowRoot.querySelectorAll('iframe')).toHaveLength(1);
    });

    it('execute() runs nothing: scriptUnsafe is never on in the default build', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        defineWebSandbox();
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        el.execute('1');
        expect(warn.mock.calls.map(call => String(call[0]))).toEqual(['[Sandbox] execute() blocked: scriptUnsafe is false. Enable it in config to run arbitrary code.']);
        expect(el._queue).toEqual([]);
    });
});
