// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { listItems, recordValues, scalarTypes } from './ListFields.tsx';
import { SchemaForm } from './SchemaForm.tsx';

afterEach(cleanup);

/** A form of `schema` that keeps its value, as the editor's draft does, seen in `state.value`. */
function editing(schema: Record<string, unknown>, start: Record<string, unknown> = {}) {
  const state = { value: start };
  function Form() {
    const [value, setValue] = useState(start);
    return (
      <SchemaForm
        legend="config"
        schema={schema}
        value={value}
        onChange={(v) => {
          state.value = v;
          setValue(v);
        }}
      />
    );
  }
  render(<Form />);
  return { state };
}

describe('the schemas drawn as rows', () => {
  it('knows a plain type, a list of them, a union of them, and nothing else', () => {
    expect(scalarTypes(undefined)).toBeUndefined();
    expect(scalarTypes({})).toBeUndefined();
    expect(scalarTypes({ type: 'string' })).toEqual(['string']);
    expect(scalarTypes({ type: ['string', 'null'] })).toEqual(['string', 'null']);
    expect(scalarTypes({ anyOf: [{ type: 'number' }, { type: 'boolean' }] })).toEqual([
      'number',
      'boolean',
    ]);
    expect(scalarTypes({ anyOf: [{ type: 'number' }, { type: 'object' }] })).toBeUndefined();
    expect(scalarTypes({ oneOf: [{ type: 'number' }, {}] })).toBeUndefined();
    expect(listItems({ type: 'array', items: { type: 'string' } })).toEqual({ type: 'string' });
    expect(listItems({ type: 'array', items: { type: 'boolean' } })).toBeUndefined();
    expect(listItems({ type: 'array' })).toBeUndefined();
    expect(listItems({ type: 'string' })).toBeUndefined();
    expect(recordValues({ type: 'object', additionalProperties: { type: 'number' } })).toEqual([
      'number',
    ]);
    expect(recordValues({ type: 'object', additionalProperties: true })).toBeUndefined();
    expect(
      recordValues({ type: 'object', properties: {}, additionalProperties: { type: 'number' } })
    ).toBeUndefined();
  });
});

describe('a list as rows', () => {
  it('holds numbers, and is taken away once emptied when it has no default', () => {
    const { state } = editing({
      type: 'object',
      properties: { ports: { type: 'array', items: { type: 'integer' } } },
    });
    expect(screen.getByText('none')).toBeDefined();
    fireEvent.click(screen.getByLabelText('add to ports'));
    // An empty row says nothing yet: nothing is written.
    expect(state.value).toEqual({});
    const first = screen.getByLabelText('ports 1') as HTMLInputElement;
    expect(first.type).toBe('number');
    fireEvent.change(first, { target: { value: '7000' } });
    expect(state.value).toEqual({ ports: [7000] });
    fireEvent.click(screen.getByLabelText('remove ports 1'));
    expect(state.value).toEqual({});
  });

  it('picks each item among its choices', () => {
    const { state } = editing({
      type: 'object',
      properties: { kinds: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
    });
    fireEvent.click(screen.getByLabelText('add to kinds'));
    fireEvent.change(screen.getByLabelText('kinds 1'), { target: { value: 'b' } });
    expect(state.value).toEqual({ kinds: ['b'] });
  });

  it('shows a value set otherwise as its rows, when it changes from outside', () => {
    const schema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    };
    const { rerender } = render(<SchemaForm legend="c" schema={schema} value={{ tags: ['x'] }} />);
    expect((screen.getByLabelText('tags 1') as HTMLInputElement).value).toBe('x');
    rerender(<SchemaForm legend="c" schema={schema} value={{ tags: ['y', 'z'] }} />);
    expect((screen.getByLabelText('tags 2') as HTMLInputElement).value).toBe('z');
  });
});

describe('a record as rows', () => {
  const WHEN = {
    type: 'object',
    properties: {
      when: {
        type: 'object',
        default: {},
        propertyNames: { type: 'string' },
        additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
        description: 'fields by path',
      },
    },
  };

  it('shows each key and value, its type picked', () => {
    render(
      <SchemaForm
        legend="config"
        schema={WHEN}
        value={{ when: { kind: 'gain', n: 2, ok: true, gone: null } }}
      />
    );
    expect((screen.getByLabelText('when 1 key') as HTMLInputElement).value).toBe('kind');
    expect((screen.getByLabelText('when 1 value') as HTMLInputElement).value).toBe('gain');
    expect((screen.getByLabelText('when 2 type') as HTMLSelectElement).value).toBe('number');
    expect((screen.getByLabelText('when 3 value') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('when 4 type') as HTMLSelectElement).value).toBe('null');
    expect(screen.queryByLabelText('when 4 value')).toBeNull();
    expect(screen.queryByLabelText('remove when 1')).toBeNull();
    expect(screen.getByText('fields by path')).toBeDefined();
  });

  it('adds, types, retypes and removes rows', () => {
    const { state } = editing(WHEN, { when: {} });
    fireEvent.click(screen.getByLabelText('add to when'));
    // A row with no key says nothing yet.
    fireEvent.change(screen.getByLabelText('when 1 value'), { target: { value: 'gain' } });
    expect(state.value).toEqual({ when: {} });
    fireEvent.change(screen.getByLabelText('when 1 key'), { target: { value: 'outcome.kind' } });
    expect(state.value).toEqual({ when: { 'outcome.kind': 'gain' } });
    fireEvent.click(screen.getByLabelText('add to when'));
    fireEvent.change(screen.getByLabelText('when 2 key'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('when 2 type'), { target: { value: 'number' } });
    // A number not typed yet says nothing.
    expect(state.value).toEqual({ when: { 'outcome.kind': 'gain' } });
    fireEvent.change(screen.getByLabelText('when 2 value'), { target: { value: '3' } });
    expect(state.value).toEqual({ when: { 'outcome.kind': 'gain', n: 3 } });
    fireEvent.change(screen.getByLabelText('when 2 type'), { target: { value: 'boolean' } });
    expect(state.value).toEqual({ when: { 'outcome.kind': 'gain', n: false } });
    fireEvent.click(screen.getByLabelText('when 2 value'));
    expect(state.value).toEqual({ when: { 'outcome.kind': 'gain', n: true } });
    fireEvent.change(screen.getByLabelText('when 2 type'), { target: { value: 'null' } });
    expect(state.value).toEqual({ when: { 'outcome.kind': 'gain', n: null } });
    // A key set twice: the later row wins, and says so.
    fireEvent.change(screen.getByLabelText('when 2 key'), { target: { value: 'outcome.kind' } });
    expect(screen.getByText('outcome.kind is set above: this row is the one kept')).toBeDefined();
    expect(state.value).toEqual({ when: { 'outcome.kind': null } });
    fireEvent.click(screen.getByLabelText('remove when 2'));
    fireEvent.click(screen.getByLabelText('remove when 1'));
    // Emptied, with an empty default: taken away.
    expect(state.value).toEqual({});
  });

  it('holds one type with no choice of it', () => {
    const { state } = editing({
      type: 'object',
      properties: {
        spacing: { type: 'object', additionalProperties: { type: 'boolean' } },
      },
    });
    fireEvent.click(screen.getByLabelText('add to spacing'));
    expect(screen.queryByLabelText('spacing 1 type')).toBeNull();
    fireEvent.change(screen.getByLabelText('spacing 1 key'), { target: { value: 'a' } });
    expect(state.value).toEqual({ spacing: { a: false } });
  });
});
