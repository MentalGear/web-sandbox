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
describe('the guest policy never contains \'self\' (backlog S14)', () => {
  // The guest CSP sits in the guest srcdoc, which sits (attribute-escaped) in the wrapper's srcdoc.
  const guestPolicy = (el: HTMLElement): string => {
    const wrapper = el.shadowRoot!.querySelector('iframe')!.srcdoc;
    const guest = new DOMParser().parseFromString(wrapper, 'text/html').querySelector('iframe')!.getAttribute('srcdoc')!;
    return new DOMParser().parseFromString(guest, 'text/html').querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
  };

  const mount = async (config?: Record<string, unknown>) => {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    if (config) el.setConfig(config);
    return el;
  };

  it("the default policy has no 'self'", async () => {
    const el = await mount();
    expect(guestPolicy(el)).toMatch(/script-src 'unsafe-inline'(;| )/);
    expect(guestPolicy(el).toLowerCase()).not.toContain("'self'");
    el.remove();
  });

  it("drops a configured 'self' in iframe and worker mode, warning once per directive across resets", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const mode of ['iframe', 'worker']) {
      warn.mockClear();
      const el = await mount({ mode, connectionsAllowed: { 'script-src': ["'SELF'", "'unsafe-inline'", 'https://a.example'], 'connect-src': ["'self'"] } });
      el.reset();
      const policy = guestPolicy(el);
      expect(policy.toLowerCase()).not.toContain("'self'");
      expect(policy).toContain("script-src 'unsafe-inline' https://a.example");
      expect(policy).toContain("connect-src 'none'");
      const selfWarnings = warn.mock.calls.map(c => String(c[0])).filter(m => m.includes("'self'"));
      expect(selfWarnings).toHaveLength(2);
      el.remove();
    }
    warn.mockRestore();
  });
});

describe('the guest policy and frames built by the element (S15, S16)', () => {
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

  it('the default guest policy is exactly what it was before S16: empty fetch directives are left to default-src', async () => {
    const el = await mount();
    expect(frames(el).policy).toBe("default-src 'none'; upgrade-insecure-requests; script-src 'unsafe-inline'; base-uri 'none'; style-src 'unsafe-inline'; form-action 'none'; worker-src blob: data:;");
    el.remove();
  });

  it("connectionsAllowed { 'default-src': [] } keeps default-src 'none' in the guest policy, in iframe and worker mode", async () => {
    for (const mode of ['iframe', 'worker']) {
      const el = await mount({ mode, connectionsAllowed: { 'default-src': [] } });
      expect(frames(el).policy).toMatch(/^default-src 'none';/);
      el.remove();
    }
  });

  it("an embedder's default-src reaches every fetch directive it does not set (the defaults do not pin them to 'none')", async () => {
    const el = await mount({ connectionsAllowed: { 'default-src': ['https://cdn.example'] } });
    const { policy } = frames(el);
    expect(policy).toMatch(/^default-src https:\/\/cdn\.example;/);
    for (const directive of ['connect-src', 'img-src', 'font-src', 'media-src', 'object-src', 'frame-src', 'manifest-src']) {
      expect(policy).not.toContain(directive);
    }
    el.remove();
  });

  it('in iframe and worker mode, both frames are no-referrer, the guest inherits an inert base, and base-uri stays none', async () => {
    for (const mode of ['iframe', 'worker']) {
      // even a config that asks for a base: the guest policy never allows one
      const el = await mount({ mode, connectionsAllowed: { 'base-uri': [] } });
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

describe('directives a <meta> policy discards are dropped from the guest policy (backlog S7)', () => {
  const guestPolicy = (el: HTMLElement): string => {
    const wrapper = new DOMParser().parseFromString(el.shadowRoot!.querySelector('iframe')!.srcdoc, 'text/html');
    const guest = new DOMParser().parseFromString(wrapper.querySelector('iframe')!.getAttribute('srcdoc')!, 'text/html');
    return guest.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
  };

  it('in iframe and worker mode, none of the four is emitted, with one warning per directive per instance across resets', async () => {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const mode of ['iframe', 'worker']) {
      warn.mockClear();
      const el = document.createElement('web-sandbox') as any;
      document.body.appendChild(el);
      const connectionsAllowed = { 'frame-ancestors': ["'none'"], 'report-uri': ['https://r.example/'], 'report-to': ['group'], 'sandbox': ['allow-scripts'], 'frame-src': [] };
      el.setConfig({ mode, connectionsAllowed });
      el.reset();
      el.setConfig({ mode, connectionsAllowed });
      const policy = guestPolicy(el);
      for (const directive of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox']) {
        expect(policy).not.toMatch(new RegExp(`(^|; )${directive} `));
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes(`connectionsAllowed.${directive}"`))).toHaveLength(1);
      }
      expect(policy).toContain("frame-src 'none';"); // S16 still holds for every other directive
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

describe('the guest bootstrap must be able to run (backlog S13, S5)', () => {
  it('warns once per instance when scripts are allowed but the policy refuses the inline bootstrap, and never otherwise', async () => {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = () => warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('cannot run'));
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);

    el.setConfig({ capabilities: ['allow-scripts'] });
    el.setConfig({ capabilities: [] , connectionsAllowed: { 'script-src': ['https://cdn.example'] } }); // no scripts at all: nothing to warn about
    expect(refused()).toEqual([]);

    for (const mode of ['iframe', 'worker']) el.setConfig({ mode, capabilities: ['allow-scripts'], connectionsAllowed: { 'script-src': ['https://cdn.example'] } });
    el.reset();
    expect(refused()).toHaveLength(1);
    expect(refused()[0]).toContain('WebRTC');
    el.remove();
    warn.mockRestore();
  });
});

describe('content auto-sizing reaches the guest bootstrap only when asked for (backlog B6)', () => {
  // The bootstrap is the guest srcdoc's one inline script (in worker mode, inside the worker source literal).
  const guestDocument = (el: HTMLElement): string => {
    const wrapper = el.shadowRoot!.querySelector('iframe')!.srcdoc;
    return new DOMParser().parseFromString(wrapper, 'text/html').querySelector('iframe')!.getAttribute('srcdoc')!;
  };

  it('passes { autoResize: true } in iframe mode with autoResize: true, and nothing otherwise', async () => {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    const FEATURE = '{"autoResize":true}';

    el.setConfig({ capabilities: ['allow-scripts'] });
    expect(guestDocument(el)).not.toContain(FEATURE);
    el.setConfig({ capabilities: ['allow-scripts'], autoResize: 'yes' });
    expect(guestDocument(el)).not.toContain(FEATURE);
    el.setConfig({ capabilities: ['allow-scripts'], autoResize: true });
    expect(guestDocument(el)).toContain(FEATURE);
    el.setConfig({ mode: 'worker', autoResize: true });
    expect(guestDocument(el)).not.toMatch(/autoResize\\*":true/); // the worker source is a string literal: escaped quotes
    expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('autoResize'))).toHaveLength(1);

    el.remove();
    warn.mockRestore();
  });
});
