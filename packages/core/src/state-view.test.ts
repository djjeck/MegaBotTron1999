import { describe, expect, it } from 'vitest';
import { type JsonSchema } from './graph-view.ts';
import { labelOf, plainSchema, schemaAtPath, summaryOf, valueAtPath } from './state-view.ts';

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    bag: {
      type: 'object',
      description: 'Bag',
      properties: {
        items: {
          type: 'array',
          description: 'Items',
          items: { type: 'object', properties: { name: { type: 'string' } } },
        },
        gold: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Gold' },
        marks: { type: 'object', description: 'Marks', additionalProperties: { type: 'number' } },
      },
    },
    note: { type: 'string' },
  },
};

describe('a state’s view (bot-os.md D72)', () => {
  it('reads values and schemas by dotted path, and labels them', () => {
    const state = {
      bag: { items: [{ name: 'rope' }], gold: 4, marks: { a: 1, b: 2 } },
      note: 'hi',
    };
    expect(valueAtPath(state, undefined)).toBe(state);
    expect(valueAtPath(state, 'bag.items.0.name')).toBe('rope');
    expect(valueAtPath(state, 'note.x')).toBeUndefined();
    expect(schemaAtPath(SCHEMA, 'bag.items.0.name')).toEqual({ type: 'string' });
    expect(schemaAtPath(SCHEMA, 'bag.gold')).toEqual({ type: 'number', description: 'Gold' });
    expect(schemaAtPath(SCHEMA, 'bag.marks.a')).toEqual({ type: 'number' });
    expect(schemaAtPath(SCHEMA, 'bag.nothing')).toBeUndefined();
    expect(schemaAtPath(SCHEMA, 'note.x.y')).toBeUndefined();
    expect(schemaAtPath(SCHEMA, '')).toBe(SCHEMA);
    expect(plainSchema(undefined)).toEqual({});
    expect(plainSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toHaveProperty(
      'anyOf'
    );
    expect(labelOf(SCHEMA, 'bag.items')).toBe('Items');
    expect(labelOf(SCHEMA, 'note')).toBe('note');
    // A card's line: its first two pins, a list or a map counted, a value shown.
    const view = { schema: SCHEMA, state, pin: ['bag.items', 'bag.marks', 'bag.gold'] };
    expect(summaryOf(view)).toBe('1 Items · 2 Marks');
    expect(summaryOf({ ...view, pin: ['bag.gold', 'note', 'bag.none'] }, 3)).toBe(
      'Gold: 4 · note: hi · none: —'
    );
    expect(summaryOf({ schema: SCHEMA, state })).toBeUndefined();
  });
});
