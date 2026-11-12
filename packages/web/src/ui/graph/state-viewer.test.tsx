// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonSchema, StateView } from '#src/ui/api.ts';
import { fakeCore } from '#test/fake-core.ts';
import { status } from '#test/graph-view.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { GraphPage } from './GraphPage.tsx';
import { freshnessText, plainOf, schemaAt, StateViewer, text, valueAt } from './StateViewer.tsx';

const T = Date.parse('2026-11-10T12:00:00Z');

/** A made-up game's player state, as the core writes its zod schema. */
const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    inventory: {
      description: 'Inventory',
      type: 'object',
      properties: {
        items: {
          description: 'Items',
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Item' },
              count: { type: 'number', description: 'Count' },
            },
          },
        },
        gold: { type: 'number', description: 'Gold' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    profile: {
      description: 'Profile',
      type: 'object',
      properties: {
        level: { type: 'number', description: 'Level' },
        title: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Title' },
        skills: {
          description: 'Skills',
          type: 'object',
          additionalProperties: { type: 'number' },
        },
        guild: {
          type: 'object',
          properties: { name: { type: 'string' }, rank: { type: 'number' } },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
};

const VIEW: StateView = {
  schema: SCHEMA,
  state: {
    inventory: {
      items: [
        { name: 'rope', count: 2 },
        { name: 'lamp', count: 10 },
        { name: 'map', count: 1, worn: true },
      ],
      gold: 40,
      tags: ['heavy', 'old'],
    },
    profile: {
      level: 3,
      title: null,
      skills: { climbing: 4, swimming: 1, lore: { deep: 1 } },
      guild: { name: 'Lanterns', rank: 2 },
    },
    notes: [],
    extra: 'kept',
  },
  updatedAt: T,
  freshness: {
    inventory: {
      snapshot: { t: T - 60_000, event: 'quest.inventory' },
      deltas: 3,
      uncertain: 1,
      updated: { t: T, event: 'quest.loss' },
    },
    profile: { deltas: 1, uncertain: 0, updated: { t: T, event: 'quest.level' } },
  },
  pin: ['inventory.items', 'profile.level'],
};

let restore: () => void;
beforeEach(() => {
  restore = stubReactFlow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restore();
});

const rows = (table: HTMLElement): string[][] =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) =>
      within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent ?? '')
    );

describe('the state viewer (D72)', () => {
  it('draws any state from its schema: pins first, tables, maps, sections and lines', () => {
    render(<StateViewer view={VIEW} />);
    const pinned = screen.getByLabelText('pinned');
    // A list of objects: a table, its columns the schema's labels, then what the items add.
    const table = within(pinned).getByRole('table', { name: 'Items' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent)
    ).toEqual(['Item', 'Count', 'worn']);
    expect(rows(table)).toEqual([
      ['rope', '2', '—'],
      ['lamp', '10', '—'],
      ['map', '1', 'true'],
    ]);
    // Sorted by a column, numbers as numbers; again, the other way.
    fireEvent.click(within(table).getByRole('button', { name: 'Count' }));
    expect(rows(table).map((r) => r[0])).toEqual(['map', 'rope', 'lamp']);
    fireEvent.click(within(table).getByRole('button', { name: /Count/u }));
    expect(rows(table).map((r) => r[0])).toEqual(['lamp', 'rope', 'map']);
    expect(within(table).getAllByRole('columnheader')[1]?.getAttribute('aria-sort')).toBe(
      'descending'
    );
    fireEvent.click(within(table).getByRole('button', { name: 'Item' }));
    expect(rows(table).map((r) => r[0])).toEqual(['lamp', 'map', 'rope']);
    // Searched across its cells.
    fireEvent.change(within(pinned).getByLabelText('search Items'), { target: { value: 'ro' } });
    expect(rows(table)).toEqual([['rope', '2', '—']]);
    fireEvent.change(within(pinned).getByLabelText('search Items'), { target: { value: 'zz' } });
    expect(within(pinned).getByText('nothing matches')).toBeTruthy();
    // A pinned value: a labelled line.
    expect(within(pinned).getByText('Level').parentElement?.textContent).toBe('Level 3');
    // The sections, each with its freshness.
    expect(screen.getByText(/snapshot 2026-11-10 11:59 \(quest.inventory\)/u).textContent).toBe(
      'snapshot 2026-11-10 11:59 (quest.inventory) · 3 changes since, 1 uncertain · updated 2026-11-10 12:00 (quest.loss)'
    );
    expect(screen.getByText(/no snapshot · 1 change · updated/u)).toBeTruthy();
    // A map: its keys and values; a nested value within, as its own table.
    const skills = screen.getByRole('table', { name: 'Skills' });
    expect(
      within(skills)
        .getAllByRole('rowheader')
        .map((h) => h.textContent)
    ).toEqual(['climbing', 'swimming', 'lore', 'deep']);
    // A nested object: a section that folds, its fields within, labelled by their keys.
    expect(screen.getByText('guild').closest('details')?.textContent).toBe(
      'guildname Lanternsrank 2'
    );
    // A list of plain values, an empty one, a null, and a key the schema does not name.
    expect(screen.getByText('heavy, old')).toBeTruthy();
    expect(screen.getAllByText('empty').length).toBeGreaterThan(0);
    expect(screen.getByText('Title').parentElement?.textContent).toBe('Title —');
    expect(screen.getByText('extra').parentElement?.textContent).toBe('extra kept');
    expect(screen.getByText('Updated 2026-11-10 12:00 UTC')).toBeTruthy();
  });

  it('draws a state with no pin, never changed, and an empty one', () => {
    render(<StateViewer view={{ schema: { type: 'object' }, state: 7 }} />);
    expect(screen.getByText('Never changed')).toBeTruthy();
    expect(screen.queryByLabelText('pinned')).toBeNull();
  });

  it('reads the schema and the values by path, and words the freshness', () => {
    expect(schemaAt(SCHEMA, 'inventory.items.0.name')).toEqual({
      type: 'string',
      description: 'Item',
    });
    expect(schemaAt(SCHEMA, 'profile.skills.climbing')).toEqual({ type: 'number' });
    expect(schemaAt(SCHEMA, 'profile.title')).toEqual({ type: 'string', description: 'Title' });
    expect(schemaAt(SCHEMA, 'nothing.here')).toBeUndefined();
    expect(valueAt(VIEW.state, 'inventory.items.1.name')).toBe('lamp');
    expect(valueAt(VIEW.state, 'inventory.gold.x')).toBeUndefined();
    expect(plainOf(undefined)).toEqual({});
    expect(plainOf({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toHaveProperty('anyOf');
    expect(text({ a: 1 })).toBe('{"a":1}');
    expect(freshnessText(undefined)).toBeUndefined();
    expect(freshnessText({ deltas: 2, uncertain: 2 })).toBe('no snapshot · 2 changes, 2 uncertain');
    expect(freshnessText({ snapshot: { t: T, event: 'x.y' }, deltas: 1, uncertain: 0 })).toBe(
      'snapshot 2026-11-10 12:00 (x.y) · 1 change since'
    );
  });

  it('shows a running node’s state in its panel, and its line on its card', async () => {
    const st = status();
    const parser = st.plugins[1];
    if (parser !== undefined) parser.summary = '3 Items · Level: 3';
    let answer: [number, unknown] = [200, VIEW];
    fakeCore({ status: st, routes: { 'GET /plugins/parser/view': () => answer } });
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    const card = await screen.findByLabelText('node parser', {}, { timeout: 5000 });
    await waitFor(() => expect(within(card).getByText('3 Items · Level: 3')).toBeTruthy());
    fireEvent.click(card);
    const details = await screen.findByLabelText('details of parser');
    const state = await within(details).findByLabelText('state of parser');
    expect(within(state).getAllByRole('table', { name: 'Items' })).toHaveLength(2);
    // A node that keeps no state has no such section.
    fireEvent.click(await screen.findByLabelText('node actor-a'));
    const actor = await screen.findByLabelText('details of actor-a');
    await waitFor(() => expect(within(actor).queryByLabelText('state of actor-a')).toBeNull());
    // One that cannot say now says why.
    answer = [409, { error: 'parser is not running' }];
    fireEvent.click(await screen.findByLabelText('node parser'));
    await screen.findByText('parser is not running');
  });
});
