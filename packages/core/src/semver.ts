/**
 * The little of semver the module loader needs (docs/bot-os-api.md §7): versions
 * `MAJOR.MINOR.PATCH`, with an optional pre-release, and ranges of comparators: `1.2.3` or
 * `=1.2.3`, `>`, `>=`, `<`, `<=`, `^1.2.3`, `~1.2.3`, `*`, several joined by spaces (all must hold)
 * and alternatives by `||`. A pre-release orders before its release, and is otherwise compared as
 * semver does; ranges do not exclude pre-releases as npm's do.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: readonly (string | number)[];
}

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

/** A version, or undefined for text that is not one. */
export function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text.trim());
  if (m === null) return undefined;
  const [, major = '', minor = '', patch = '', pre] = m;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    pre: pre === undefined ? [] : pre.split('.').map((p) => (/^\d+$/u.test(p) ? Number(p) : p)),
  };
}

/** Negative, zero or positive, as `a` orders before, with or after `b`. */
export function compare(a: Version, b: Version): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

type Test = (v: Version) => boolean;

const v = (major: number, minor: number, patch: number): Version => ({
  major,
  minor,
  patch,
  pre: [],
});

/** One comparator's test, or undefined for one that is not. */
function comparator(text: string): Test | undefined {
  if (text === '*' || text === 'x') return () => true;
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/u.exec(text);
  const base = parseVersion(m?.[2] ?? '');
  if (m === null || base === undefined) return undefined;
  switch (m[1]) {
    case '^': {
      const upper =
        base.major > 0
          ? v(base.major + 1, 0, 0)
          : base.minor > 0
            ? v(0, base.minor + 1, 0)
            : v(0, 0, base.patch + 1);
      return (x) => compare(x, base) >= 0 && compare(x, upper) < 0;
    }
    case '~': {
      const upper = v(base.major, base.minor + 1, 0);
      return (x) => compare(x, base) >= 0 && compare(x, upper) < 0;
    }
    case '>=':
      return (x) => compare(x, base) >= 0;
    case '<=':
      return (x) => compare(x, base) <= 0;
    case '>':
      return (x) => compare(x, base) > 0;
    case '<':
      return (x) => compare(x, base) < 0;
    default:
      return (x) => compare(x, base) === 0;
  }
}

/**
 * Whether `version` is in `range`; undefined when either cannot be read, so that the caller says
 * which.
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const parsed = parseVersion(version);
  if (parsed === undefined) return undefined;
  const alternatives: Test[][] = [];
  for (const alt of range.split('||')) {
    const tests = alt
      .trim()
      .split(/\s+/u)
      .filter((t) => t !== '')
      .map(comparator);
    if (tests.length === 0 || tests.some((t) => t === undefined)) return undefined;
    alternatives.push(tests as Test[]);
  }
  return alternatives.some((tests) => tests.every((t) => t(parsed)));
}

/** Whether `range` can be read. */
export function validRange(range: string): boolean {
  return satisfies('0.0.0', range) !== undefined;
}
