import { describe, expect, it } from 'vitest';
import { signature, typeText } from './signature.ts';

describe('a member’s signature', () => {
  it('writes a JSON Schema as a type', () => {
    expect(typeText(undefined)).toBe('unknown');
    expect(typeText({})).toBe('unknown');
    expect(typeText({ const: 'x' })).toBe('"x"');
    expect(typeText({ type: 'string', enum: ['a', 'b'] })).toBe('"a" | "b"');
    expect(typeText({ anyOf: [{ type: 'integer' }, { type: 'null' }] })).toBe('number | null');
    expect(typeText({ oneOf: [{ type: 'boolean' }] })).toBe('boolean');
    expect(typeText({ type: 'array' })).toBe('unknown[]');
    expect(typeText({ type: 'object' })).toBe('object');
    expect(
      typeText({
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'array', items: { type: 'string' } } },
        required: ['a'],
      })
    ).toBe('{ a: number, b?: string[] }');
    const deep = (n: number): Record<string, unknown> =>
      n === 0
        ? { type: 'number' }
        : { type: 'object', properties: { x: deep(n - 1) }, required: ['x'] };
    expect(typeText(deep(4))).toBe('{ x: { x: { x: {…} } } }');
  });

  it('writes a read or an action as called', () => {
    expect(signature('state.rest', { name: 'rest', help: '', output: { type: 'number' } })).toBe(
      'state.rest() → number'
    );
    expect(signature('actions.sent', { name: 'sent', help: '', input: { type: 'object' } })).toBe(
      'actions.sent(object)'
    );
  });
});
