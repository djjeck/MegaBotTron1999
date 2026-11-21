// @vitest-environment happy-dom
/**
 * A collection's records in its node's panel (docs/bot-os.md D155): listed with their thumbnails,
 * added, edited (only what changed sent), moved and removed through the node's actions, each
 * refusal shown. The cast is made up: `postcard`'s hosts.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemberView } from '#src/ui/api.ts';
import { fakeApi } from '#test/fake-api.ts';
import type { RecordView } from './Collection.tsx';
import { changes, CollectionRecords } from './Collection.tsx';
import { BYTES_KEY } from './MediaField.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HASH = 'c'.repeat(64);
const FACE = { id: `sha256:${HASH}`, mime: 'image/png', width: 64, height: 64 };

/** The node's `add` action, as the graph view describes it: its input's `values`. */
const ACTIONS: MemberView[] = [
  {
    name: 'add',
    help: 'Adds a record',
    input: {
      type: 'object',
      properties: {
        values: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            role: { type: 'string', enum: ['seller', 'character'] },
            behaviour: { type: 'string', long: true },
            face: {
              type: 'object',
              properties: { data: {}, mime: { type: 'string' } },
              media: { kinds: ['image'], maxBytes: 10 * 2 ** 20 },
            },
          },
          required: ['name'],
        },
      },
    },
  },
];

const RECORDS: RecordView[] = [
  { id: 'r1', position: 0, values: { name: 'Ada', role: 'seller', face: FACE } },
  {
    id: 'r2',
    position: 1,
    values: { name: 'Bo', tags: ['quiet', 'old'], retired: true },
    incomplete: ['face is required'],
  },
];

function serve(records: RecordView[] = RECORDS) {
  return fakeApi({
    'GET /plugins/cast/state/list': [200, records],
    'GET /plugins/cast/state/schema': [200, { title: 'name', fields: [] }],
    'POST /plugins/cast/actions/add': (b) => [200, { id: 'r3', position: 2, values: b }],
    'POST /plugins/cast/actions/update': [200, {}],
    'POST /plugins/cast/actions/reorder': [200, []],
    'POST /plugins/cast/actions/remove': [409, { error: 'no record r2' }],
  });
}

const calls = (api: ReturnType<typeof fakeApi>, verb: string): string[] =>
  api.calls.filter((c) => c.startsWith(`POST /plugins/cast/actions/${verb}`));

describe('a collection’s records (D155)', () => {
  it('lists them, named by their title field, with thumbnails and why incomplete', async () => {
    serve();
    render(<CollectionRecords node="cast" actions={ACTIONS} />);
    const section = screen.getByLabelText('records of cast');
    expect(within(section).getByText('Reading its records…')).toBeDefined();
    const ada = await within(section).findByLabelText('record r1');
    expect(within(ada).getByText('Ada')).toBeDefined();
    expect(within(ada).getByText('role: seller')).toBeDefined();
    expect(within(ada).getByRole('img', { name: 'r1 face' }).getAttribute('src')).toBe(
      `api/plugins/cast/files/sha256-${HASH}`
    );
    const bo = within(section).getByLabelText('record r2');
    expect(within(bo).getByText('tags: quiet, old · retired: yes')).toBeDefined();
    expect(within(bo).getByText('incomplete: face is required')).toBeDefined();
    expect(within(section).getByText('2 records, 1 incomplete')).toBeDefined();
    expect((within(ada).getByLabelText('move r1 up') as HTMLButtonElement).disabled).toBe(true);
    expect((within(bo).getByLabelText('move r2 down') as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds one from a form made from its schema, a picture picked', async () => {
    const api = serve([]);
    render(<CollectionRecords node="cast" actions={ACTIONS} />);
    expect(await screen.findByText('No record yet.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Add a record' }));
    const form = screen.getByRole('group', { name: 'New record' });
    fireEvent.change(within(form).getByLabelText('name'), { target: { value: 'Cy' } });
    expect(within(form).getByLabelText('behaviour').tagName).toBe('TEXTAREA');
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'cy.png', {
      type: 'image/png',
    });
    fireEvent.change(within(form).getByLabelText('face file'), { target: { files: [png] } });
    await within(form).findByRole('img', { name: 'face preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('record added')).toBeDefined();
    const [sent] = calls(api, 'add');
    expect(JSON.parse(sent?.slice(sent.indexOf('{')) ?? '{}')).toEqual({
      values: { name: 'Cy', face: { data: { [BYTES_KEY]: 'iVBORw==' }, mime: 'image/png' } },
    });
    // The form closed, the list read again.
    expect(screen.queryByRole('group', { name: 'New record' })).toBeNull();
    expect(api.calls.filter((c) => c === 'GET /plugins/cast/state/list')).toHaveLength(2);
  });

  it('edits one, sending what changed and what was cleared; cancels', async () => {
    const api = serve();
    render(<CollectionRecords node="cast" actions={ACTIONS} />);
    const ada = await screen.findByLabelText('record r1');
    fireEvent.click(within(ada).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('group', { name: 'Record r1' });
    // Its kept picture, shown from its file.
    expect(within(form).getByRole('img', { name: 'face preview' }).getAttribute('src')).toBe(
      `api/plugins/cast/files/sha256-${HASH}`
    );
    fireEvent.change(within(form).getByLabelText('behaviour'), {
      target: { value: 'Haggles' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('r1 saved')).toBeDefined();
    const [sent] = calls(api, 'update');
    expect(JSON.parse(sent?.slice(sent.indexOf('{')) ?? '{}')).toEqual({
      id: 'r1',
      values: { behaviour: 'Haggles' },
      unset: ['face'],
    });
    fireEvent.click(
      within(screen.getByLabelText('record r2')).getByRole('button', { name: 'Edit' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(api, 'update')).toHaveLength(2));
    expect(calls(api, 'update')[1]).toBe(
      'POST /plugins/cast/actions/update {"id":"r2","values":{}}'
    );
    fireEvent.click(
      within(screen.getByLabelText('record r2')).getByRole('button', { name: 'Edit' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Record r2' })).toBeNull();
  });

  it('moves and removes one, asking first; shows a refusal', async () => {
    const api = serve();
    render(<CollectionRecords node="cast" actions={ACTIONS} />);
    const bo = await screen.findByLabelText('record r2');
    fireEvent.click(within(bo).getByLabelText('move r2 up'));
    expect(await screen.findByText('r2 moved up')).toBeDefined();
    fireEvent.click(within(screen.getByLabelText('record r1')).getByLabelText('move r1 down'));
    expect(await screen.findByText('r1 moved down')).toBeDefined();
    expect(calls(api, 'reorder')).toEqual([
      'POST /plugins/cast/actions/reorder {"id":"r2","position":0}',
      'POST /plugins/cast/actions/reorder {"id":"r1","position":1}',
    ]);
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    fireEvent.click(within(screen.getByLabelText('record r2')).getByLabelText('remove r2'));
    expect(confirm).toHaveBeenCalledWith('Remove Bo (r2)? It cannot be undone.');
    expect(calls(api, 'remove')).toEqual([]);
    fireEvent.click(within(screen.getByLabelText('record r2')).getByLabelText('remove r2'));
    expect(await screen.findByText('no record r2')).toBeDefined();
  });

  it('says why it cannot read them; names a record by its id without a title', async () => {
    fakeApi({
      'GET /plugins/cast/state/list': [409, { error: 'cast is not running' }],
      'GET /plugins/cast/state/schema': [409, { error: 'cast is not running' }],
    });
    render(<CollectionRecords node="cast" actions={[]} />);
    expect(await screen.findByText('cast is not running')).toBeDefined();
    // No add action described: no form to add with.
    expect(screen.queryByRole('button', { name: 'Add a record' })).toBeNull();
    cleanup();
    fakeApi({
      'GET /plugins/cast/state/list': [200, [{ id: 'r1', position: 0, values: { n: 3 } }]],
      'GET /plugins/cast/state/schema': [200, {}],
    });
    render(<CollectionRecords node="cast" actions={ACTIONS} />);
    const r1 = await screen.findByLabelText('record r1');
    expect(within(r1).getByText('r1', { selector: 'strong' })).toBeDefined();
    expect(within(r1).getByText('n: 3')).toBeDefined();
    expect(screen.getByText('1 record')).toBeDefined();
  });

  it('finds what changed', () => {
    expect(changes({ a: 1, b: [1], c: 'x' }, { a: 1, b: [2], d: true })).toEqual({
      values: { b: [2], d: true },
      unset: ['c'],
    });
  });
});
