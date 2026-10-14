import { describe, it, expect } from 'vitest';
import { generateCSP } from './csp-generator';
import type { CSPDirectives } from '@src/csp-directives';

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

  it(`should parse [''] as [], and emit both as 'none'`, () => {
    const input: CSPDirectives = {
      'default-src': ["'self'"],
      'img-src': [],
      'font-src': [''],
    };
    const expected = "default-src 'self'; img-src 'none'; font-src 'none';";
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

  it(`should emit [] as 'none' and leave out directives that are not filled in`, () => {
    const input: CSPDirectives = {
      'img-src': [],
      'script-src': ["example.com"],
      'base-uri': ["example.com"],
    };
    expect(generateCSP(input)).toBe(`default-src 'none'; img-src 'none'; script-src example.com; base-uri example.com;`);
  });

 it('default-src should always be present, even if not defined', () => {
    const input: CSPDirectives = {
      'style-src': [],
      'script-src': ["example.com"],
      'img-src': ["images.com"],
    };
    expect(generateCSP(input)).toBe(`default-src 'none'; style-src 'none'; script-src example.com; img-src images.com;`);
  });

  it('default-src should always be first, even if it s just for better readbility', () => {
    const input: CSPDirectives = {
      'style-src': [],
      'script-src': ["example.com"],
      'img-src': ["images.com"],
      'default-src': ["'none'"],
    };
    expect(generateCSP(input)).toBe(`default-src 'none'; style-src 'none'; script-src example.com; img-src images.com;`);

  });

  it('should handle upgrade-insecure-requests as a boolean directive', () => {
    const input: CSPDirectives = {
      'upgrade-insecure-requests': true,
    };
    const expected = "default-src 'none'; upgrade-insecure-requests;";
    expect(generateCSP(input)).toBe(expected);
  });

  it('should handle directive of boolean and string[] type', () => {
    const input: CSPDirectives = {
      'upgrade-insecure-requests': true,
      'script-src': ["example.com"],
    };
    const expected = "default-src 'none'; upgrade-insecure-requests; script-src example.com;";
    expect(generateCSP(input)).toBe(expected);
  });
});
// ---- S16: an empty directive can never widen the policy ------------------------------------------

// Every list-valued directive of CSPDirectives. The type below fails `bun run typecheck` when one is
// added to CSPDirectives and not here, so the tests cannot silently skip a directive.
const LIST_DIRECTIVES = [
  'default-src', 'script-src', 'connect-src', 'base-uri', 'img-src', 'style-src', 'font-src', 'media-src',
  'manifest-src', 'prefetch-src', 'form-action', 'object-src', 'frame-src', 'frame-ancestors', 'worker-src',
  'script-src-elem', 'script-src-attr', 'style-src-elem', 'style-src-attr', 'child-src',
] as const satisfies readonly Exclude<keyof CSPDirectives, 'upgrade-insecure-requests'>[];
type Unlisted = Exclude<keyof CSPDirectives, 'upgrade-insecure-requests' | (typeof LIST_DIRECTIVES)[number]>;
const everyDirectiveListed: [Unlisted] extends [never] ? true : Unlisted = true;
void everyDirectiveListed;

type Directive = (typeof LIST_DIRECTIVES)[number];

/**
 * What "broader" means here: for each directive, the set of sources a browser enforces for it.
 * - A directive present in the policy enforces its own list; 'none' is the empty set ('none' next to
 *   other sources is ignored by browsers, so it is dropped from the list).
 * - An absent fetch directive enforces the next one in its CSP Level 3 fallback chain
 *   (worker-src → child-src → script-src → default-src; frame-src → child-src → default-src; every
 *   other fetch directive → default-src). Nothing present at the end of the chain means unrestricted.
 * - An absent base-uri, form-action or frame-ancestors is unrestricted: they have no fallback.
 * Policy A is no broader than policy B when every directive's set in A is a subset of B's (anything
 * is a subset of unrestricted; unrestricted is a subset only of unrestricted).
 */
const UNRESTRICTED = null;
type Sources = Set<string> | typeof UNRESTRICTED;

const FALLBACK: Record<Directive, string[]> = {
  'default-src': ['default-src'],
  'script-src': ['script-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'style-src': ['style-src', 'default-src'],
  'font-src': ['font-src', 'default-src'],
  'media-src': ['media-src', 'default-src'],
  'manifest-src': ['manifest-src', 'default-src'],
  'prefetch-src': ['prefetch-src', 'default-src'],
  'object-src': ['object-src', 'default-src'],
  'frame-src': ['frame-src', 'child-src', 'default-src'],
  'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
  'base-uri': ['base-uri'],
  'form-action': ['form-action'],
  'frame-ancestors': ['frame-ancestors'],
  'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
  'script-src-attr': ['script-src-attr', 'script-src', 'default-src'],
  'style-src-elem': ['style-src-elem', 'style-src', 'default-src'],
  'style-src-attr': ['style-src-attr', 'style-src', 'default-src'],
  'child-src': ['child-src', 'default-src'],
};

function parsePolicy(policy: string): Map<string, string[]> {
  const parsed = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...tokens] = part.trim().split(/\s+/);
    if (name && !parsed.has(name)) parsed.set(name.toLowerCase(), tokens); // the first occurrence wins
  }
  return parsed;
}

function enforced(policy: Map<string, string[]>, directive: Directive): Sources {
  for (const name of FALLBACK[directive]) {
    const tokens = policy.get(name);
    if (tokens) return new Set(tokens.filter(token => token.toLowerCase() !== "'none'"));
  }
  return UNRESTRICTED;
}

const isSubset = (a: Sources, b: Sources) => b === UNRESTRICTED || (a !== UNRESTRICTED && [...a].every(token => b.has(token)));

/** Directives whose enforced sources in policy `a` are NOT a subset of those in policy `b`. */
function broaderIn(a: string, b: string): Directive[] {
  const [pa, pb] = [parsePolicy(a), parsePolicy(b)];
  return LIST_DIRECTIVES.filter(directive => !isSubset(enforced(pa, directive), enforced(pb, directive)));
}

// Configs the property is checked against: empty, the shipping default, broad and narrow default-src,
// directives set and unset, and the 'self'/blank/duplicate shapes a caller can pass.
const SAMPLE_CONFIGS: CSPDirectives[] = [
  {},
  {
    'upgrade-insecure-requests': true, 'default-src': ["'none'"], 'script-src': ["'unsafe-inline'"],
    'base-uri': [], 'style-src': ["'unsafe-inline'"], 'form-action': [], 'worker-src': ['blob:'],
  },
  { 'default-src': ['https:', "'unsafe-inline'"] },
  { 'default-src': ['*'], 'script-src': ["'unsafe-inline'"] },
  { 'script-src': ['https://cdn.example', "'unsafe-eval'"], 'connect-src': ['https://api.example'] },
  { 'default-src': ['https://a.example'], 'img-src': ['data:'], 'frame-src': ['https://f.example'], 'worker-src': ['blob:'] },
  { 'default-src': [''], 'base-uri': ['https://b.example'], 'form-action': ['https://f.example'], 'frame-ancestors': ["'self'"] },
  Object.fromEntries(LIST_DIRECTIVES.map(d => [d, [`https://${d}.example`]])) as CSPDirectives,
];

const without = (config: CSPDirectives, directive: Directive): CSPDirectives => {
  const copy: Record<string, unknown> = { ...config };
  delete copy[directive];
  return copy as CSPDirectives;
};

describe('generateCSP: an empty directive means deny, for every directive (S16)', () => {
  it.each(LIST_DIRECTIVES)("%s: [] and blank strings are emitted as 'none', never omitted", (directive) => {
    for (const empty of [[], [''], ['  ', '']]) {
      const policy = generateCSP({ [directive]: empty } as CSPDirectives);
      expect(parsePolicy(policy).get(directive)).toEqual(["'none'"]);
      // and default-src stays 'none' (an empty default-src no longer replaces the built-in one)
      expect(parsePolicy(policy).get('default-src')).toEqual(["'none'"]);
    }
  });

  it("{ 'default-src': [] } with a script-src set still denies every other fetch directive", () => {
    const policy = generateCSP({ 'default-src': [], 'script-src': ["'unsafe-inline'"] });
    expect(policy).toBe("default-src 'none'; script-src 'unsafe-inline';");
    const parsed = parsePolicy(policy);
    for (const directive of LIST_DIRECTIVES) {
      if (FALLBACK[directive].includes('default-src') && !FALLBACK[directive].includes('script-src')) {
        expect(enforced(parsed, directive), directive).toEqual(new Set());
      }
    }
  });

  it('upgrade-insecure-requests is emitted whenever the key is present, whatever its value', () => {
    for (const value of [true, false, [], undefined]) {
      expect(generateCSP({ 'upgrade-insecure-requests': value } as unknown as CSPDirectives)).toBe("default-src 'none'; upgrade-insecure-requests;");
    }
  });

  it('a non-array value is refused, never omitted', () => {
    for (const value of ['', "'none'", null, undefined, {}, true]) {
      expect(() => generateCSP({ 'img-src': value } as unknown as CSPDirectives)).toThrowError('value type must be array');
    }
  });

  it('the oracle is not vacuous: it reports omission of a set directive, and an empty default-src as it used to be emitted', () => {
    // omitting connect-src under a broad default-src widens connect-src
    expect(broaderIn('default-src *;', "default-src *; connect-src 'none';")).toEqual(['connect-src']);
    // the pre-S16 output for { 'default-src': [], 'script-src': ["'unsafe-inline'"] } versus leaving default-src out
    expect(broaderIn("script-src 'unsafe-inline';", "default-src 'none'; script-src 'unsafe-inline';"))
      .toEqual(LIST_DIRECTIVES.filter(d => !FALLBACK[d].includes('script-src') && !['base-uri', 'form-action', 'frame-ancestors'].includes(d)));
    // an omitted base-uri is unrestricted
    expect(broaderIn("default-src 'none';", "default-src 'none'; base-uri 'none';")).toEqual(['base-uri']);
  });

  for (const [index, config] of SAMPLE_CONFIGS.entries()) {
    it.each(LIST_DIRECTIVES)(`sample config ${index}: the policy with %s: [] is never broader than with it left out`, (directive) => {
      const withEmpty = generateCSP({ ...config, [directive]: [] });
      const leftOut = generateCSP(without(config, directive));
      expect(broaderIn(withEmpty, leftOut)).toEqual([]);
    });
  }
});
