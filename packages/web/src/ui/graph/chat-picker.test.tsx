// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphEdge, Surface } from '#src/ui/api.ts';
import { fakeApi } from '#test/fake-api.ts';
import { fakeCore } from '#test/fake-core.ts';
import { VIEW } from '#test/graph-view.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { ago, ChatPicker, unlistedNote } from './ChatPicker.tsx';
import { GraphPage } from './GraphPage.tsx';
import { chatConnector } from './NodeDetails.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = Date.UTC(2026, 10, 14, 12);
const DAY = 86_400_000;
const ADA: Surface = {
  id: '5',
  title: 'Ada',
  kind: 'private',
  aliases: ['@ada_x'],
  lastActive: NOW - 3 * DAY,
};
const QUEST: Surface = {
  id: '@QuestBot',
  title: 'Quest Bot',
  kind: 'bot',
  lastActive: NOW - 60_000,
};
const HALL: Surface = {
  id: '-1001',
  title: 'Guild Hall',
  kind: 'group',
  lastActive: NOW - 2 * 3_600_000,
};
const NEWS: Surface = { id: '-1002', title: 'News', kind: 'channel' };
const OWNER: Surface = {
  id: '7',
  title: 'its owner',
  kind: 'private',
  unreachable:
    'the bot cannot message its owner yet: the owner must open the bot and send it /start',
};
const view = (surfaces: Surface[], peers?: { connector: string; surfaces: Surface[] }[]) =>
  [
    200,
    { running: true, listed: true, surfaces, ...(peers === undefined ? {} : { peers }) },
  ] as const;

/** The picker over a value it keeps, as a form would. */
function Harness(props: {
  initial: string[];
  single?: boolean;
  optional?: boolean;
  kinds?: Surface['kind'][];
  sender?: boolean;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <>
      <ChatPicker
        label="chat"
        connector="bot"
        value={value}
        set={setValue}
        now={NOW}
        {...(props.single === true ? { single: true } : {})}
        {...(props.optional === true ? { optional: true } : {})}
        {...(props.kinds === undefined ? {} : { kinds: props.kinds })}
        {...(props.sender === true ? { sender: true } : {})}
      />
      <output aria-label="value">{JSON.stringify(value)}</output>
    </>
  );
}
const valueOf = () => screen.getByLabelText('value').textContent;
const rows = () =>
  within(screen.getByRole('list', { name: 'chat chats' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe('the chat picker (D96)', () => {
  it('shows each chat by name, its kind by an icon, the picked ones first, when last active', async () => {
    fakeApi({ 'GET /accounts/bot/surfaces?peers=1': [...view([QUEST, HALL, NEWS, ADA])] });
    render(<Harness initial={['@ADA_X']} />);
    await screen.findByLabelText('Guild Hall');
    // Ada, saved by @username, found by it and shown by name, first; then the latest.
    expect(rows()).toEqual([
      'personAda@ada_x3 days ago',
      'botQuest Bot@QuestBot1 min ago',
      'groupGuild Hall2 h ago',
      'channelNews',
    ]);
    const icons = screen.getAllByRole('img').map((x) => x.getAttribute('class'));
    expect(icons).toEqual([
      'chat-kind chat-kind-private',
      'chat-kind chat-kind-bot',
      'chat-kind chat-kind-group',
      'chat-kind chat-kind-channel',
    ]);
    // A group's id never shows.
    expect(screen.queryByText('-1001')).toBeNull();
    fireEvent.click(screen.getByLabelText('Guild Hall'));
    expect(valueOf()).toBe('["@ADA_X","-1001"]');
    fireEvent.click(screen.getByLabelText('Ada'));
    expect(valueOf()).toBe('["-1001"]');
  });

  it('picks one, of the kinds asked, finds it by id, and clears it with None when optional', async () => {
    fakeApi({
      'GET /accounts/bot/surfaces?peers=1': [...view([QUEST, HALL, ADA])],
      'GET /accounts/bot/surfaces?search=5&peers=1': [...view([ADA])],
      'GET /accounts/bot/surfaces?search=zzz&peers=1': [...view([])],
    });
    render(<Harness initial={[]} single optional kinds={['private']} />);
    await screen.findByLabelText('Ada');
    // Nothing picked: None is.
    expect((screen.getByLabelText('no chat') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('Guild Hall')).toBeNull();
    fireEvent.change(screen.getByLabelText('search chat'), { target: { value: '5' } });
    await waitFor(() => expect(rows()).toEqual(['personAda@ada_x3 days ago']));
    fireEvent.click(screen.getByLabelText('Ada'));
    expect(valueOf()).toBe('["5"]');
    expect((screen.getByLabelText('Ada') as HTMLInputElement).type).toBe('radio');
    fireEvent.change(screen.getByLabelText('search chat'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No chat matches.')).toBeDefined();
    expect((screen.getByLabelText('no chat') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('no chat'));
    expect(valueOf()).toBe('[]');
    expect((screen.getByLabelText('no chat') as HTMLInputElement).checked).toBe(true);
  });

  it('offers no None for a single pick that must hold a chat, and None where none can be listed', async () => {
    fakeApi({ 'GET /accounts/bot/surfaces?peers=1': [...view([ADA])] });
    const { unmount } = render(<Harness initial={['5']} single kinds={['private']} />);
    await screen.findByLabelText('Ada');
    expect(screen.queryByLabelText('no chat')).toBeNull();
    unmount();
    fakeApi({
      'GET /accounts/bot/surfaces?peers=1': [200, { running: false, listed: false, surfaces: [] }],
    });
    render(<Harness initial={['5']} single optional />);
    await screen.findByText('Apply first to list its chats.');
    fireEvent.click(screen.getByLabelText('no chat'));
    expect(valueOf()).toBe('[]');
  });

  it('says why its connector cannot reach a chat, and asks it of a chat another connector knows', async () => {
    const bob: Surface = { id: '@bob_y', title: 'Bob', kind: 'private', aliases: ['6'] };
    const cara: Surface = { id: '@cara_z', title: 'Cara', kind: 'private', aliases: ['8'] };
    const api = fakeApi({
      'GET /accounts/bot/surfaces?peers=1': [
        ...view([OWNER], [{ connector: 'me', surfaces: [bob, cara] }]),
      ],
      'GET /accounts/bot/surfaces?search=6&limit=500': [
        ...view([{ id: '6', title: 'Bob', kind: 'private', aliases: ['@bob_y'] }]),
      ],
      'GET /accounts/bot/surfaces?search=8&limit=500': [...view([])],
    });
    render(<Harness initial={[]} />);
    expect(
      await screen.findByText(/the owner must open the bot and send it \/start/u)
    ).toBeDefined();
    expect(
      screen.getAllByText(/bot has never seen this chat \(me knows it\)/u).map((x) => x.textContent)
    ).toHaveLength(2);
    // Bob: the bot can reach him once asked, so his id goes.
    fireEvent.click(screen.getByLabelText('Bob'));
    await waitFor(() => expect(valueOf()).toBe('["6"]'));
    expect(api.calls).toContain('GET /accounts/bot/surfaces?search=6&limit=500');
    // Cara: it cannot; picked all the same, by her id, and the row says why.
    fireEvent.click(screen.getByLabelText('Cara'));
    await waitFor(() => expect(valueOf()).toBe('["6","8"]'));
    expect(
      await screen.findByText(/bot cannot reach this chat: a person must message it first/u)
    ).toBeDefined();
  });

  it('picks people to recognise with no word on reaching them, a peer’s at once (D100)', async () => {
    const bob: Surface = { id: '@bob_y', title: 'Bob', kind: 'private', aliases: ['6'] };
    const dan: Surface = { id: '9', title: 'Dan', kind: 'private' };
    const api = fakeApi({
      'GET /accounts/bot/surfaces?peers=1': [
        ...view([OWNER], [{ connector: 'me', surfaces: [bob] }]),
      ],
      'GET /accounts/bot/surfaces?search=9&limit=500&peers=1': [
        ...view([], [{ connector: 'me', surfaces: [dan] }]),
      ],
    });
    render(<Harness initial={['9']} sender />);
    // A saved one the bot never saw, shown by the name its peer has for them.
    expect(await screen.findByLabelText('Dan')).toBeDefined();
    expect(screen.getByLabelText('its owner')).toBeDefined();
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(screen.getByLabelText('Bob'));
    await waitFor(() => expect(valueOf()).toBe('["9","6"]'));
    expect(screen.getByLabelText('Bob')).toBeDefined();
    expect(api.calls.filter((c) => c.includes('search=6'))).toEqual([]);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shows what is picked while there is no list, and takes a typed chat only where none can be', async () => {
    fakeApi({
      'GET /accounts/bot/surfaces?peers=1': [200, { running: true, listed: false, surfaces: [] }],
    });
    render(<Harness initial={['#a']} />);
    expect(
      await screen.findByText('This connector cannot list its chats: type them.')
    ).toBeDefined();
    fireEvent.change(screen.getByLabelText('new chat'), { target: { value: ' #b ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(valueOf()).toBe('["#a","#b"]');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(valueOf()).toBe('["#a","#b"]');
    fireEvent.click(screen.getByLabelText('#a'));
    expect(valueOf()).toBe('["#b"]');
    cleanup();
    fakeApi({
      'GET /accounts/bot/surfaces?peers=1': [200, { running: false, listed: false, surfaces: [] }],
    });
    render(<Harness initial={['#a']} />);
    expect(await screen.findByText('Apply first to list its chats.')).toBeDefined();
    expect(screen.queryByLabelText('new chat')).toBeNull();
    cleanup();
    fakeApi({ 'GET /accounts/bot/surfaces?peers=1': [409, { error: 'not connected' }] });
    render(<Harness initial={[]} />);
    expect(await screen.findByText('Its chats cannot be listed now: not connected')).toBeDefined();
    cleanup();
    render(
      <ChatPicker
        label="x"
        connector={undefined}
        noConnector="Wire it first."
        value={[]}
        set={vi.fn()}
      />
    );
    expect(screen.getByText('Wire it first.')).toBeDefined();
    expect(unlistedNote({ state: 'not-running' })).toBe('Apply first to list its chats.');
  });

  it('says when, in days', () => {
    expect([
      ago(undefined, NOW),
      ago(NOW - 10_000, NOW),
      ago(NOW - 5 * 60_000, NOW),
      ago(NOW - 3 * 3_600_000, NOW),
      ago(NOW - DAY - 1, NOW),
      ago(NOW - 12 * DAY, NOW),
    ]).toEqual([undefined, 'just now', '5 min ago', '3 h ago', '1 day ago', '12 days ago']);
  });
});

describe('a config key that names a chat (D96)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = stubReactFlow();
  });
  afterEach(() => restore());

  it('finds its connector: its own node, or along its chat edge', () => {
    const edges: GraphEdge[] = [
      { from: 'a.out', to: 'bot.chat', type: 'chat-out', sends: [] },
      { from: 'irc.chat', to: 'a.in', type: 'chat-in', reads: '*' },
    ];
    expect(chatConnector('bot', { key: 'owner' }, edges)).toBe('bot');
    expect(chatConnector('a', { key: 'chat', output: 'out' }, edges)).toBe('bot');
    expect(chatConnector('a', { key: 'in', input: 'in' }, edges)).toBe('irc');
    expect(chatConnector('a', { key: 'chat', output: 'other' }, edges)).toBeUndefined();
    expect(chatConnector('b', { key: 'in', input: 'in' }, edges)).toBeUndefined();
  });

  it('picks a connector’s owner by id, a node’s chat along its edge, or a template', async () => {
    const graph = structuredClone(VIEW);
    const chat = graph.nodes[0];
    const actor = graph.nodes[2];
    if (chat === undefined || actor === undefined) throw new Error('no fixture');
    const props = (chat.configSchema as { properties: Record<string, unknown> }).properties;
    props['owner'] = { type: 'integer', description: 'its owner' };
    chat.configChats = [{ key: 'owner', kinds: ['private'] }];
    actor.configSchema = {
      type: 'object',
      properties: {
        to: { type: 'string' },
        // A list, or one chat as saved before (the reactor's in, #7): picked as a list.
        group: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
      },
    };
    actor.configChats = [
      { key: 'to', output: 'chat', template: true },
      { key: 'group', input: 'chat' },
    ];
    const core = fakeCore({
      available: graph.nodes.map(({ id: _, config: __, ...p }) => ({ ...p, id: p.plugin })),
      routes: {
        'GET /graph/view': [200, graph],
        'GET /accounts/chat/surfaces?peers=1': [...view([ADA, HALL])],
      },
    });
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node chat · in', {}, { timeout: 5000 }));
    const details = await screen.findByLabelText('details of chat');
    const owner = within(details).getByRole('group', { name: 'owner' });
    fireEvent.click(await within(owner).findByLabelText('Ada'));
    await waitFor(() => expect(core.checked.at(-1)?.nodes[0]?.config).toMatchObject({ owner: 5 }));
    expect(within(owner).queryByLabelText('Guild Hall')).toBeNull();

    fireEvent.click(screen.getByLabelText('node actor-a'));
    const node = await screen.findByLabelText('details of actor-a');
    const to = within(node).getByRole('group', { name: 'to' });
    fireEvent.click(await within(to).findByLabelText('Guild Hall'));
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes[2]?.config).toMatchObject({ to: '-1001' })
    );
    fireEvent.change(within(node).getByLabelText('to template'), { target: { value: '{chat}' } });
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes[2]?.config).toMatchObject({ to: '{chat}' })
    );
    expect((within(to).getByLabelText('Guild Hall') as HTMLInputElement).checked).toBe(false);
    const group = within(node).getByRole('group', { name: 'group' });
    fireEvent.click(await within(group).findByLabelText('Ada'));
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes[2]?.config).toMatchObject({ group: ['5'] })
    );
    fireEvent.click(within(group).getByLabelText('Ada'));
    await waitFor(() => expect(core.checked.at(-1)?.nodes[2]?.config?.['group']).toBeUndefined());
    fireEvent.change(within(node).getByLabelText('to template'), { target: { value: '' } });
    await waitFor(() => expect(core.checked.at(-1)?.nodes[2]?.config?.['to']).toBeUndefined());
  }, 15_000);
});
