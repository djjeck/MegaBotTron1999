import { describe, expect, it } from 'vitest';
import { withDefaults } from './defaults.ts';

const SCHEMA = {
  type: 'object',
  properties: {
    host: { type: 'string' },
    port: { type: 'integer', default: 6667 },
    tags: { type: 'array', items: { type: 'string' }, default: ['/play'] },
    when: { type: 'object', additionalProperties: {}, default: {} },
    pace: {
      type: 'object',
      default: {},
      properties: { gap: { type: 'number', default: 17 }, night: { type: 'string' } },
    },
    full: {
      type: 'object',
      default: { gap: 20 },
      properties: {
        gap: { type: 'number', default: 17 },
        wake: { type: 'string', default: '08:30' },
      },
    },
    extra: { type: 'object', properties: { a: { type: 'number', default: 1 } } },
    needed: { type: 'object', properties: { b: { type: 'number', default: 2 } } },
    maybe: { anyOf: [{ type: 'string', default: 'x' }, { type: 'null' }] },
  },
  required: ['host', 'needed'],
};

describe('withDefaults', () => {
  it('fills each unset field from its default, nested objects within, as if typed', () => {
    expect(withDefaults(SCHEMA, undefined)).toEqual({
      port: 6667,
      tags: ['/play'],
      when: {},
      pace: { gap: 17 },
      full: { gap: 20, wake: '08:30' },
      needed: { b: 2 },
      maybe: 'x',
    });
  });

  it('never changes a value given, nor makes an optional object with no default', () => {
    const given = {
      host: 'example.net',
      port: 7000,
      pace: { night: '01:00' },
      full: 'not an object',
      tags: [],
    };
    expect(withDefaults(SCHEMA, given)).toEqual({
      host: 'example.net',
      port: 7000,
      tags: [],
      when: {},
      pace: { gap: 17, night: '01:00' },
      full: 'not an object',
      needed: { b: 2 },
      maybe: 'x',
    });
    expect(given.pace).toEqual({ night: '01:00' });
  });

  it('copies the defaults, and leaves a value alone without a schema', () => {
    const a = withDefaults(SCHEMA, undefined);
    (a['tags'] as string[]).push('/more');
    expect(withDefaults(SCHEMA, undefined)['tags']).toEqual(['/play']);
    expect(withDefaults(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(withDefaults({ type: 'object' }, undefined)).toEqual({});
  });
});
