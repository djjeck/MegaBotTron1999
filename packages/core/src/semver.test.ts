import { describe, expect, it } from 'vitest';
import { compare, parseVersion, satisfies, validRange } from './semver.ts';

const cmp = (a: string, b: string): number =>
  Math.sign(compare(parseVersion(a) ?? fail(a), parseVersion(b) ?? fail(b)));
const fail = (v: string): never => {
  throw new Error(`not a version: ${v}`);
};

describe('versions', () => {
  it('reads MAJOR.MINOR.PATCH with a pre-release, and nothing else', () => {
    expect(parseVersion('1.2.3-beta.4')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: ['beta', 4],
    });
    for (const bad of ['1.2', '01.2.3', 'v1.2.3', '1.2.3-', 'one'])
      expect(parseVersion(bad)).toBe(undefined);
  });

  it('orders them as semver does', () => {
    expect(cmp('1.2.3', '1.2.3')).toBe(0);
    expect(cmp('1.10.0', '1.9.9')).toBe(1);
    expect(cmp('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(cmp('1.0.0', '1.0.0-alpha')).toBe(1);
    expect(cmp('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(cmp('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1);
    expect(cmp('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
    expect(cmp('1.0.0-beta', '1.0.0-alpha.1')).toBe(1);
    expect(cmp('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1);
    expect(cmp('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
    expect(cmp('1.0.0-x', '1.0.0-1')).toBe(1);
  });
});

describe('ranges', () => {
  const table: [string, string, boolean][] = [
    ['0.1.4', '^0.1.0', true],
    ['0.2.0', '^0.1.0', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.9.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['1.2.0', '^1.2.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '=1.2.4', false],
    ['3.0.0', '>=1.0.0 <3.0.0', false],
    ['2.5.0', '>=1.0.0 <3.0.0', true],
    ['1.0.0', '>1.0.0', false],
    ['1.0.0', '<=1.0.0', true],
    ['5.0.0', '^1.0.0 || ^5.0.0', true],
    ['9.9.9', '*', true],
    ['9.9.9', 'x', true],
  ];
  it.each(table)('%s in %s: %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('cannot read a bad version or a bad range', () => {
    expect(satisfies('1.0', '^1.0.0')).toBe(undefined);
    expect(satisfies('1.0.0', '^1.0')).toBe(undefined);
    expect(satisfies('1.0.0', '1.0.0 ||')).toBe(undefined);
    expect(validRange('^1.0.0')).toBe(true);
    expect(validRange('latest')).toBe(false);
  });
});
