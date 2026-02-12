import { describe, it, expect } from 'vitest';
import { ALLOWED_CAPABILITIES } from '@src/host';

describe('LofiSandbox Security Configuration', () => {
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