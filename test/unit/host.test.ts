import { describe, it, expect, vi } from 'vitest';
import { ALLOWED_CAPABILITIES } from '@src/csp-directives';

describe('WebSandbox Security Configuration', () => {
  it('should have ALLOWED_CAPABILITIES defined', () => {
    expect(ALLOWED_CAPABILITIES).toBeDefined();
    expect(Array.isArray(ALLOWED_CAPABILITIES)).toBe(true);
    expect(ALLOWED_CAPABILITIES.length).toBeGreaterThan(0);
  });

  it('should not contain dangerous capabilities that allow sandbox escape or access to host page', () => {
    const dangerous = [
      'allow-same-origin',
      'allow-popups-to-escape-sandbox',
      'allow-top-navigation',
      'allow-top-navigation-by-user-activation',
      'allow-top-navigation-to-custom-protocols',
    ];

    dangerous.forEach((capability) => {
      expect(ALLOWED_CAPABILITIES as readonly string[]).not.toContain(capability);
    });
  });
});
const COOPERATIVE_DEFAULT = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'; upgrade-insecure-requests";

// The guest CSP sits in the guest srcdoc, which sits (attribute-escaped) in the wrapper's srcdoc.
const frames = (el: HTMLElement) => {
  const outer = el.shadowRoot!.querySelector('iframe')!;
  const wrapper = new DOMParser().parseFromString(outer.srcdoc, 'text/html');
  const inner = wrapper.querySelector('iframe')!;
  const guest = new DOMParser().parseFromString(inner.getAttribute('srcdoc')!, 'text/html');
  const policy = guest.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
  return { outer, wrapper, inner, policy };
};

const mount = async (config?: Record<string, unknown>) => {
  const { defineWebSandbox } = await import('@src/host');
  defineWebSandbox();
  const el = document.createElement('web-sandbox') as any;
  document.body.appendChild(el);
  if (config) el.setConfig(config);
  return el;
};

describe('the guest policy built by the element: `origins` (ADR-007)', () => {
  it('the default guest policy, in cooperative and worker mode: the cooperative template, every directive explicit', async () => {
    for (const mode of ['cooperative', 'worker']) {
      const el = await mount({ mode });
      expect(frames(el).policy, mode).toBe(COOPERATIVE_DEFAULT);
      el.remove();
    }
  });

  it('each kind fills its directive and no other, in cooperative and worker mode, across reset()', async () => {
    for (const mode of ['cooperative', 'worker']) {
      const el = await mount({ mode, origins: { scripts: ['https://cdn.example'], images: ['https://img.example'], connect: ['https://api.example', 'wss://ws.example'] } });
      el.reset();
      expect(frames(el).policy, mode).toBe(COOPERATIVE_DEFAULT
        .replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' https://cdn.example")
        .replace("img-src 'none'", 'img-src https://img.example')
        .replace("connect-src 'none'", 'connect-src https://api.example wss://ws.example'));
      el.remove();
    }
  });

  it("backlog S14, S16: 'self', a scheme, a wildcard or data: is dropped with one warning each across resets; a kind left with nothing is 'none'", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const mode of ['cooperative', 'worker']) {
      warn.mockClear();
      const el = await mount({ mode, origins: { scripts: ["'SELF'", 'https://a.example'], connect: ["'self'", 'https:', '*'], images: ['data:'] } });
      el.reset();
      el.setConfig({ mode, origins: { scripts: ["'SELF'", 'https://a.example'], connect: ["'self'", 'https:', '*'], images: ['data:'] } });
      const { policy } = frames(el);
      expect(policy.toLowerCase()).not.toMatch(/'self'|data:|\*|https: /);
      expect(policy).toContain("script-src 'unsafe-inline' https://a.example;");
      expect(policy).toContain("connect-src 'none';");
      expect(policy).toContain("img-src 'none';");
      expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('was dropped: list exact origins'))).toHaveLength(5);
      el.remove();
    }
    warn.mockRestore();
  });

  it('connectionsAllowed was removed: one warning per instance, ignored (no origin from it), the rest of the config applied', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = await mount({ mode: 'cooperative', connectionsAllowed: { 'img-src': ['https://img.example'], 'default-src': ['*'] }, origins: { connect: ['https://api.example'] }, html: '<p id="kept">' });
    el.reset();
    el.setConfig({ mode: 'cooperative', connectionsAllowed: null, origins: { connect: ['https://api.example'] }, html: '<p id="kept">' });
    expect(el.state).toBe('loading');
    expect(frames(el).policy).toBe(COOPERATIVE_DEFAULT.replace("connect-src 'none'", 'connect-src https://api.example'));
    expect(el._config.html).toBe('<p id="kept">');
    expect(Object.hasOwn(el._config, 'connectionsAllowed')).toBe(false);
    expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('connectionsAllowed was removed; use origins'))).toHaveLength(1);
    el.remove();
    warn.mockRestore();
  });

  it('in cooperative and worker mode, both frames are no-referrer, the guest inherits an inert base, and base-uri stays none', async () => {
    for (const mode of ['cooperative', 'worker']) {
      const el = await mount({ mode });
      el.reset();
      const { outer, wrapper, inner, policy } = frames(el);
      expect(outer.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(inner.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(wrapper.querySelector('base')?.getAttribute('href')).toBe('about:blank');
      expect(wrapper.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
      expect(policy).toContain("base-uri 'none';");
      el.remove();
    }
  });
});

describe('the scriptUnsafe guard rail (backlog S4)', () => {
  const mount = async () => {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    return el;
  };
  const scriptUnsafeWarnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('scriptUnsafe is enabled'));

  it('warns exactly once per instance across setConfig(), reset() and load(), naming eval in the guest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await mount();
    first.setConfig({ capabilities: ['allow-scripts'], scriptUnsafe: true });
    first.reset();
    first.load('<p>again</p>');
    first.setConfig({ scriptUnsafe: false });
    first.setConfig({ scriptUnsafe: true, mode: 'worker' });
    first.reset();
    const warnings = scriptUnsafeWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'unsafe-eval'");
    expect(warnings[0]).toContain('eval');
    expect(warnings[0]).toContain('testing');

    // a second instance has its own guard rail
    const second = await mount();
    second.setConfig({ scriptUnsafe: true });
    expect(scriptUnsafeWarnings(warn)).toHaveLength(2);
    first.remove();
    second.remove();
    warn.mockRestore();
  });

  it('never warns while scriptUnsafe is off, and only a literal true enables it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = await mount();
    el.setConfig({ capabilities: ['allow-scripts'] });
    el.setConfig({ scriptUnsafe: false });
    el.setConfig({ scriptUnsafe: 'true' as any });
    el.setConfig({ scriptUnsafe: 1 as any });
    el.reset();
    expect(scriptUnsafeWarnings(warn)).toEqual([]);
    const wrapper = new DOMParser().parseFromString(el.shadowRoot!.querySelector('iframe')!.srcdoc, 'text/html');
    const guest = new DOMParser().parseFromString(wrapper.querySelector('iframe')!.getAttribute('srcdoc')!, 'text/html');
    expect(guest.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')).not.toContain('unsafe-eval');
    el.remove();
    warn.mockRestore();
  });
});

describe('no directive a <meta> policy discards is ever emitted (backlog S7)', () => {
  it('a config cannot name one: as a key of origins it is an unknown kind, dropped with one warning per instance; the policy is the template', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const mode of ['cooperative', 'worker']) {
      warn.mockClear();
      const origins = { 'frame-ancestors': ["'none'"], 'report-uri': ['https://r.example/'], 'report-to': ['group'], 'sandbox': ['allow-scripts'] };
      const el = await mount({ mode, origins });
      el.reset();
      el.setConfig({ mode, origins });
      const { policy } = frames(el);
      expect(policy).toBe(COOPERATIVE_DEFAULT);
      for (const directive of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox']) {
        expect(policy).not.toMatch(new RegExp(`(^|; )${directive} `));
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes(`origins."${directive}" was dropped`))).toHaveLength(1);
      }
      el.remove();
    }
    warn.mockRestore();
  });
});

describe("the element's 'violation' event (backlog S5)", () => {
  it('dispatches a validated detail that bubbles, caps events per environment with one warning, and the cap resets with the environment', async () => {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const heard: unknown[] = [];
    const onWindow = (e: Event) => { if (e.target === el) heard.push((e as CustomEvent).detail); };
    window.addEventListener('violation', onWindow);

    el._dispatchViolation({ type: 'VIOLATION', directive: 'img-src', blockedURI: 'https://a.test/x', lineNumber: 2, forged: true });
    el._dispatchViolation({ type: 'VIOLATION', directive: 'not a directive', blockedURI: 'x' });
    expect(heard).toEqual([{ directive: 'img-src', blockedURI: 'https://a.test/x', lineNumber: 2 }]);

    for (let i = 0; i < 300; i++) el._dispatchViolation({ directive: 'connect-src', blockedURI: 'x' });
    expect(heard).toHaveLength(100);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('CSP violations'))).toHaveLength(1);

    el.reset();
    el._dispatchViolation({ directive: 'connect-src', blockedURI: 'after-reset' });
    expect(heard).toHaveLength(101);

    window.removeEventListener('violation', onWindow);
    el.remove();
    warn.mockRestore();
  });
});

describe('the guest bootstrap always runs where scripts are allowed (backlog S13, S5)', () => {
  it("the cooperative policy always admits the inline bootstrap, so the element always expects its announcement with allow-scripts, and only then", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const mode of ['cooperative', 'worker']) {
      const el = await mount({ mode, capabilities: ['allow-scripts'], origins: { scripts: ['https://cdn.example'] } });
      expect(frames(el).policy, mode).toMatch(/script-src 'unsafe-inline'[ ;]/);
      expect(el._lc.build.announces, mode).toBe(true);
      el.setConfig({ mode, capabilities: [] });
      expect(el._lc.build.announces, mode).toBe(mode === 'worker'); // worker mode always adds allow-scripts
      el.remove();
    }
  });
});

describe('content auto-sizing reaches the guest bootstrap only when asked for (backlog B6)', () => {
  // The bootstrap is the guest srcdoc's one inline script (in worker mode, inside the worker source literal).
  const guestDocument = (el: HTMLElement): string => {
    const wrapper = el.shadowRoot!.querySelector('iframe')!.srcdoc;
    return new DOMParser().parseFromString(wrapper, 'text/html').querySelector('iframe')!.getAttribute('srcdoc')!;
  };

  it('passes { autoResize: true } in cooperative mode with autoResize: true, and nothing otherwise', async () => {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    const FEATURE = '"autoResize":true'; // in the features literal, next to the call budget every bootstrap carries

    el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
    expect(guestDocument(el)).not.toContain(FEATURE);
    el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], autoResize: 'yes' });
    expect(guestDocument(el)).not.toContain(FEATURE);
    el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], autoResize: true });
    expect(guestDocument(el)).toContain(FEATURE);
    el.setConfig({ mode: 'worker', autoResize: true });
    expect(guestDocument(el)).not.toMatch(/autoResize\\*":true/); // the worker source is a string literal: escaped quotes
    expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('autoResize'))).toHaveLength(1);

    el.remove();
    warn.mockRestore();
  });
});

describe('the fetch bridge reaches the guest only when configured (backlog B5)', () => {
  const guestDocument = (el: HTMLElement): string => {
    const wrapper = el.shadowRoot!.querySelector('iframe')!.srcdoc;
    return new DOMParser().parseFromString(wrapper, 'text/html').querySelector('iframe')!.getAttribute('srcdoc')!;
  };

  it('passes { fetchBridge: { timeoutMs } } in both modes, nothing without it, and keeps the reserved name for itself', async () => {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);

    el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
    expect(guestDocument(el)).not.toMatch(/fetchBridge\\*":/);
    el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], fetchBridge: { allow: ['https://api.example'], timeoutMs: 2500 } });
    expect(guestDocument(el)).toContain('"fetchBridge":{"timeoutMs":2500}');
    el.setConfig({ mode: 'worker', fetchBridge: { allow: [] } });
    expect(guestDocument(el)).toMatch(/fetchBridge\\*":\{\\*"timeoutMs\\*":10000\}/);
    el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], fetchBridge: 'on' });
    expect(guestDocument(el)).not.toMatch(/fetchBridge\\*":/);

    el.expose('sandbox:fetch', () => 'forged');
    el.expose('sandbox:other', () => 'forged');
    expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('reserved for the library'))).toHaveLength(2);

    el.remove();
    warn.mockRestore();
  });
});
