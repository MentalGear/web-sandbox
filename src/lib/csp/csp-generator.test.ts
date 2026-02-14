import { describe, it, expect } from 'vitest';
import { generateCSP, type CSPDirectives } from './csp-generator';

describe('generateCSP', () => {
  it('should generate a valid CSP string from multiple directives', () => {
    const input: CSPDirectives = {
      'default-src': ["'none'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'worker-src': ['blob:', 'data:'],
    };
    const expected = "default-src 'none'; script-src 'self' 'unsafe-inline'; worker-src blob: data:;";
    expect(generateCSP(input)).toBe(expected);
  });

  it(`should always at least output default-src 'none' fallback`, () => {
    const input: CSPDirectives = {
      // empty csp list
    };
    const expected = "default-src 'none';";
    expect(generateCSP(input)).toBe(expected);
  });

  it(`should be able to change default-src`, () => {
    const input: CSPDirectives = {
      'default-src': ["'self'"],
    };
    const expected = "default-src 'self';";
    expect(generateCSP(input)).toBe(expected);
  });

  it(`should parse [''] as []`, () => {
    const input: CSPDirectives = {
      'default-src': ["'self'"],
      'img-src': [],
      'font-src': [''],
    };
    const expected = "default-src 'self';";
    expect(generateCSP(input)).toBe(expected);
  });

  it('should filter out duplicate values within a directive', () => {
    const input: CSPDirectives = {
      'script-src': ["'self'", "'self'", 'https://example.com', "'self'"],
    };
    const expected = "default-src 'none'; script-src 'self' https://example.com;";
    expect(generateCSP(input)).toBe(expected);
  });

  it(`should throw when invalid input is provided`, () => {
    const input: CSPDirectives = {
      'connect-src': [null as any],
    };
    expect(()=> {generateCSP(input)}).toThrowError("value type must be string");
  });

  it('should throw if a directive or value is not a string', () => {
    const input: CSPDirectives = {
      'img-src': [],
      'style-src': 32 as any,
    };
// outpus default-src instead of error
    expect(()=> {generateCSP(input)}).toThrowError("value type must be array");
  });

  it('should omit directives that are [] or not filled in', () => {
    const input: CSPDirectives = {
      'img-src': [],
      'script-src': ["example.com"],
      'base-uri': ["example.com"],
    };
    expect(generateCSP(input)).toBe(`default-src 'none'; script-src example.com; base-uri example.com;`);
  });

 it('default-src should always be present, even if not defined', () => {
    const input: CSPDirectives = {
      'style-src': [],
      'script-src': ["example.com"],
      'img-src': ["images.com"],
    };
    expect(generateCSP(input)).toBe(`default-src 'none'; script-src example.com; img-src images.com;`);
  });

  it('default-src should always be first, even if it s just for better readbility', () => {
    const input: CSPDirectives = {
      'style-src': [],
      'script-src': ["example.com"],
      'img-src': ["images.com"],
      'default-src': ["'none'"],
    };
    expect(generateCSP(input)).toBe(`default-src 'none'; script-src example.com; img-src images.com;`);

  });

  it('should handle upgrade-insecure-requests as a boolean directive', () => {
    const input: CSPDirectives = {
      'upgrade-insecure-requests': [],
    };
    const expected = "default-src 'none'; upgrade-insecure-requests;";
    expect(generateCSP(input)).toBe(expected);
  });

  it('should handle directive of boolean and string[] type', () => {
    const input: CSPDirectives = {
      'upgrade-insecure-requests': [],
      'script-src': ["example.com"],
    };
    const expected = "default-src 'none'; upgrade-insecure-requests; script-src example.com;";
    expect(generateCSP(input)).toBe(expected);
  });
});