// @vitest-environment happy-dom
/**
 * A node page's table (docs/bot-os.md D157, #77): a picture from the node's files beside its row,
 * and buttons that run the node's actions with the row's values, the owner picking the rest in the
 * shared form (a host from a read's options, the row's own preselected). The page is described by
 * the core itself from a made-up `postcard`'s manifest, as `GET /graph/view` serves it.
 */
import { describeNodes, parseManifest } from '@megabottron1999/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { GraphViewData } from '#src/ui/api.ts';
import { NodePage } from '#src/ui/pages/NodePage.tsx';
import { fakeApi } from '#test/fake-api.ts';
import { PORT_TYPES } from '#test/graph-view.ts';
import { optionsOf } from './OptionsField.tsx';
import { fromRow, ownerFields, pictureSrc } from './TableRow.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HASH = 'd'.repeat(64);

const manifest = parseManifest({
  id: 'postcard',
  version: '0.1.0',
  kinds: ['actor'],
  description: 'Paints a card per place',
  interface: {
    state: {
      cards: {
        help: 'Its cards',
        output: z.array(
          z.object({
            place: z.string().describe('Place'),
            prompt: z.string().describe('Prompt'),
            picture: z.string().optional(),
            face: z.unknown().optional(),
            host: z.string().optional(),
          })
        ),
      },
      hosts: {
        help: 'Who may host a card',
        output: z.object({ hosts: z.array(z.object({ id: z.string(), name: z.string() })) }),
      },
    },
    actions: {
      repaint: {
        help: 'Paints a card again',
        input: z.strictObject({ place: z.string(), what: z.enum(['ad', 'scene']) }),
      },
      rehost: {
        help: 'Gives a card another host',
        input: z.strictObject({
          place: z.string(),
          host: z
            .string()
            .meta({ options: { read: 'hosts', path: 'hosts', value: 'id', label: 'name' } }),
        }),
      },
    },
  },
  page: {
    title: 'Cards',
    sections: [
      {
        show: 'table',
        read: 'cards',
        label: 'Cards',
        columns: [
          'place',
          'prompt',
          { path: 'picture', label: 'Picture', show: 'image' },
          { path: 'face', label: 'Face', show: 'image', from: 'media' },
        ],
        actions: [
          {
            label: 'Re-roll',
            action: 'repaint',
            input: { place: '$row.place', what: 'ad' },
            confirm: 'Re-roll this picture?',
          },
          {
            label: 'Rehost',
            action: 'rehost',
            input: { place: '$row.place' },
            current: { host: '$row.host' },
          },
        ],
      },
    ],
  },
});

const graph: GraphViewData['graph'] = {
  version: 2,
  nodes: [{ id: 'postcard', plugin: 'postcard' }],
  edges: [],
};
const VIEW = JSON.parse(
  JSON.stringify({
    graph,
    portTypes: PORT_TYPES,
    nodes: describeNodes([{ id: 'postcard', manifest }], graph),
  })
) as GraphViewData;

const CARDS = [
  {
    place: 'harbour',
    prompt: 'A quiet harbour at dawn',
    picture: 'card-abc.png',
    face: { id: `sha256:${HASH}`, mime: 'image/png' },
    host: 'h1',
  },
  { place: 'market', prompt: 'A busy market' },
];

function serve(repaint: [number, unknown] = [200, { ok: true }]) {
  return fakeApi({
    'GET /graph/view': [200, VIEW],
    'GET /plugins/postcard/state/cards': [200, CARDS],
    'GET /plugins/postcard/state/hosts': [
      200,
      {
        hosts: [
          { id: 'h1', name: 'Ada' },
          { id: 'h2', name: 'Bo' },
        ],
      },
    ],
    'POST /plugins/postcard/actions/repaint': repaint,
    'POST /plugins/postcard/actions/rehost': (b) => [200, { place: 'harbour', ...(b as object) }],
  });
}

const posts = (api: ReturnType<typeof fakeApi>, action: string): string[] =>
  api.calls.filter((c) => c.startsWith(`POST /plugins/postcard/actions/${action}`));

describe('a node page’s table (D157)', () => {
  it('shows a row’s pictures, from its files and its media, each opening whole', async () => {
    serve();
    render(<NodePage loggedOut={() => {}} section="postcard" />);
    const table = await screen.findByRole('table', { name: 'Cards' });
    const picture = await within(table).findByRole('img', { name: 'Picture of harbour' });
    expect(picture.getAttribute('src')).toBe('api/plugins/postcard/files/card-abc.png');
    expect(picture.closest('a')?.getAttribute('href')).toBe(
      'api/plugins/postcard/files/card-abc.png'
    );
    expect(within(table).getByRole('img', { name: 'Face of harbour' }).getAttribute('src')).toBe(
      `api/plugins/postcard/files/sha256-${HASH}`
    );
    // A row without one: an empty cell.
    expect(within(table).queryByRole('img', { name: 'Picture of market' })).toBeNull();
  });

  it('runs a row’s action with its values, asking first, then reads the table again', async () => {
    const api = serve();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    render(<NodePage loggedOut={() => {}} section="postcard" />);
    const button = await screen.findByRole('button', { name: 'Re-roll harbour' });
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith('Re-roll this picture?');
    expect(posts(api, 'repaint')).toEqual([]);
    const before = api.calls.filter((c) => c === 'GET /plugins/postcard/state/cards').length;
    fireEvent.click(button);
    expect(await screen.findByText('{"ok":true}')).toBeDefined();
    expect(posts(api, 'repaint')).toEqual([
      'POST /plugins/postcard/actions/repaint {"place":"harbour","what":"ad"}',
    ]);
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c === 'GET /plugins/postcard/state/cards').length
      ).toBeGreaterThan(before)
    );
  });

  it('says why an action refused', async () => {
    serve([409, { error: 'the painter is busy' }]);
    vi.stubGlobal('confirm', () => true);
    render(<NodePage loggedOut={() => {}} section="postcard" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-roll market' }));
    expect(await screen.findByText('the painter is busy')).toBeDefined();
  });

  it('opens a form for what the owner picks: a choice of a read’s options, the row’s own preselected', async () => {
    const api = serve();
    render(<NodePage loggedOut={() => {}} section="postcard" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rehost harbour' }));
    const form = screen.getByRole('group', { name: 'Rehost harbour' });
    // The row gives `place`: only `host` is the owner's.
    expect(within(form).queryByLabelText('place')).toBeNull();
    const host = within(form).getByLabelText('host') as HTMLSelectElement;
    await waitFor(() => expect(host.disabled).toBe(false));
    expect([...host.options].map((o) => o.textContent)).toEqual(['', 'Ada', 'Bo']);
    expect(host.value).toBe('h1');
    fireEvent.change(host, { target: { value: 'h2' } });
    fireEvent.click(within(form.parentElement as HTMLElement).getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(posts(api, 'rehost')).toEqual([
        'POST /plugins/postcard/actions/rehost {"host":"h2","place":"harbour"}',
      ])
    );
    // Done: the form closed.
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Rehost harbour' })).toBeNull());
    // A row without a host: nothing preselected; Cancel closes it.
    fireEvent.click(screen.getByRole('button', { name: 'Rehost market' }));
    const other = screen.getByRole('group', { name: 'Rehost market' });
    expect((within(other).getByLabelText('host') as HTMLSelectElement).value).toBe('');
    fireEvent.click(
      within(other.parentElement as HTMLElement).getByRole('button', { name: 'Cancel' })
    );
    expect(screen.queryByRole('group', { name: 'Rehost market' })).toBeNull();
  });

  it('builds what it needs from a row and a read', () => {
    const row = { place: 'harbour', at: { x: 1 } };
    expect(fromRow('$row.place', row)).toBe('harbour');
    expect(fromRow('$row', row)).toBe(row);
    expect(fromRow('$row.at.x', row)).toBe(1);
    expect(fromRow('ad', row)).toBe('ad');
    expect(pictureSrc('n', 'files', '')).toBeUndefined();
    expect(pictureSrc('n', 'media', { data: { $bytes: 'AAAA' }, mime: 'image/png' })).toBe(
      'data:image/png;base64,AAAA'
    );
    expect(pictureSrc('n', 'media', { id: 'nope', mime: 'image/png' })).toBeUndefined();
    expect(pictureSrc('n', 'media', 'x')).toBeUndefined();
    expect(ownerFields(undefined, [])).toBeUndefined();
    expect(ownerFields({ type: 'string' }, [])).toBeUndefined();
    expect(ownerFields({ type: 'object', properties: { a: {} } }, ['a'])).toBeUndefined();
    expect(
      optionsOf(
        { list: [{ id: 'h1' }, { id: 2, name: { x: 1 } }, { name: 'none' }, 'loose'] },
        {
          read: 'r',
          path: 'list',
          value: 'id',
          label: 'name',
        }
      )
    ).toEqual([
      { value: 'h1', label: 'h1' },
      { value: '2', label: '2' },
    ]);
    expect(optionsOf(['a', 'b'], { read: 'r' })).toEqual([
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b' },
    ]);
  });
});
