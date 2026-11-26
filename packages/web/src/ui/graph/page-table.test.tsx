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
import { CarouselCell, carouselIndex, fromRow, ownerFields, pictureSrc } from './TableRow.tsx';
import { rowKeys } from './Widget.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HASH = 'd'.repeat(64);

const manifest = parseManifest({
  id: 'postcard',
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
            ads: z.array(z.string()).optional(),
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
          { path: 'ads', label: 'Ads', show: 'carousel' },
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
    ads: ['ad-1.png', 'ad-2.png', 'ad-3.png'],
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

  it('shows a row’s list of pictures one at a time, going round, its place kept as it reads again (D163)', async () => {
    let cards: unknown[] = CARDS;
    fakeApi({
      'GET /graph/view': [200, VIEW],
      'GET /plugins/postcard/state/cards': () => [200, cards],
      'GET /plugins/postcard/state/hosts': [200, { hosts: [] }],
      'POST /plugins/postcard/actions/repaint': () => (
        (cards = [{ ...CARDS[0], ads: ['ad-0.png', 'ad-1.png', 'ad-2.png', 'ad-3.png'] }]),
        [200, { ok: true }]
      ),
    });
    vi.stubGlobal('confirm', () => true);
    render(<NodePage loggedOut={() => {}} section="postcard" />);
    const ads = await screen.findByRole('group', { name: 'Ads of harbour' });
    const shown = (): string | null =>
      within(ads).getByRole('img').closest('a')?.getAttribute('href') ?? null;
    expect(shown()).toBe('api/plugins/postcard/files/ad-1.png');
    expect(within(ads).getByRole('img').getAttribute('alt')).toBe('Ads of harbour, 1 of 3');
    expect(within(ads).getByText('1 / 3')).toBeDefined();
    fireEvent.click(within(ads).getByRole('button', { name: 'Previous of Ads of harbour' }));
    expect(within(ads).getByText('3 / 3')).toBeDefined();
    expect(shown()).toBe('api/plugins/postcard/files/ad-3.png');
    fireEvent.click(within(ads).getByRole('button', { name: 'Next of Ads of harbour' }));
    fireEvent.click(within(ads).getByRole('button', { name: 'Next of Ads of harbour' }));
    expect(shown()).toBe('api/plugins/postcard/files/ad-2.png');
    // A row of none: an empty cell.
    expect(screen.queryByRole('group', { name: 'Ads of market' })).toBeNull();
    // The row changes (a picture more, before it): drawn anew, it still shows the same picture.
    fireEvent.click(screen.getByRole('button', { name: 'Re-roll harbour' }));
    await waitFor(() => expect(screen.getByText('3 / 4')).toBeDefined());
    const again = screen.getByRole('group', { name: 'Ads of harbour' });
    expect(within(again).getByRole('img').getAttribute('src')).toBe(
      'api/plugins/postcard/files/ad-2.png'
    );
  });

  it('shows a list of one picture as it is, and none as nothing', () => {
    const { container } = render(<CarouselCell srcs={[]} alt="Ads of x" />);
    expect(container.innerHTML).toBe('');
    render(<CarouselCell srcs={['one.png']} alt="Ads of y" />);
    expect(screen.getByRole('img', { name: 'Ads of y' }).getAttribute('src')).toBe('one.png');
    expect(screen.queryByRole('button')).toBeNull();
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

  it('says an action’s answer under its own row: a row gone takes it along, not to the next', async () => {
    let gone = false;
    fakeApi({
      'GET /graph/view': [200, VIEW],
      'GET /plugins/postcard/state/cards': () => [200, gone ? CARDS.slice(1) : CARDS],
      'GET /plugins/postcard/state/hosts': [200, { hosts: [] }],
      'POST /plugins/postcard/actions/repaint': () => ((gone = true), [200, { removed: true }]),
    });
    vi.stubGlobal('confirm', () => true);
    render(<NodePage loggedOut={() => {}} section="postcard" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-roll harbour' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Re-roll harbour' })).toBeNull()
    );
    expect(screen.getByRole('button', { name: 'Re-roll market' })).toBeDefined();
    expect(screen.queryByText('{"removed":true}')).toBeNull();
  });

  it('keys each row by what it holds, a repeat apart', () => {
    expect(rowKeys([{ a: 1 }, { a: 2 }, { a: 1 }])).toEqual([
      '0:{"a":1}',
      '0:{"a":2}',
      '1:{"a":1}',
    ]);
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
    // A carousel's picture: itself while in its list, else its place, within the list.
    expect(carouselIndex(['a', 'b'], undefined)).toBe(0);
    expect(carouselIndex([], { src: 'a', index: 3 })).toBe(0);
    expect(carouselIndex(['x', 'a'], { src: 'a', index: 0 })).toBe(1);
    expect(carouselIndex(['x', 'y'], { src: 'a', index: 5 })).toBe(1);
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
