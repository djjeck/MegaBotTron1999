// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { heardTypes, payloadFields, Payloads } from './Payloads.tsx';

afterEach(cleanup);

describe('an event’s payload', () => {
  it('is read as dotted paths, an object opened to a depth, a list not', () => {
    const deep = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            b: {
              type: 'object',
              properties: {
                c: { type: 'object', properties: { d: { type: 'object', properties: { e: {} } } } },
              },
            },
          },
        },
        list: { type: 'array', items: { type: 'number' } },
        empty: { type: 'object', properties: {} },
      },
      required: ['list'],
    };
    expect(payloadFields(deep)).toEqual([
      { path: 'a.b.c.d', type: '{ e?: unknown }', optional: true },
      { path: 'list', type: 'number[]', optional: false },
      { path: 'empty', type: 'object', optional: true },
    ]);
    expect(payloadFields(undefined)).toEqual([]);
  });

  it('is listed per event type, saying when there is none or no field', () => {
    const { rerender } = render(<Payloads types={[]} />);
    expect(screen.getByText('no event type')).toBeDefined();
    rerender(<Payloads types={[{ type: 'dice.idle', schema: { type: 'object' } }]} />);
    expect(screen.getByText('(no field)')).toBeDefined();
  });

  it('is narrowed to the type its node’s config names', () => {
    const types = [{ type: 'dice.roll' }, { type: 'dice.idle' }];
    const input = {
      type: 'events',
      config: 'on',
      label: 'events of dice',
      optional: false,
    } as const;
    expect(heardTypes(types, input, { on: 'dice.roll' })).toEqual([{ type: 'dice.roll' }]);
    expect(heardTypes(types, input, { on: 'dice' })).toEqual(types);
    expect(heardTypes(types, undefined, { on: 'dice.roll' })).toEqual(types);
  });
});
