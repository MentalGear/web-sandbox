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
