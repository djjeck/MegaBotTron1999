// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphEdge, Surface } from '#src/ui/api.ts';
import { fakeCore } from '#test/fake-core.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { GraphPage } from './GraphPage.tsx';
import { edgesToUpdate, monitoredSurfaces, sameChats, unlistedNote } from './Surfaces.tsx';

let restore: () => void;
beforeEach(() => {
  restore = stubReactFlow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restore();
});

const slow = { timeout: 5000 };
const LOBBY: Surface = { id: '#a', title: 'The Lobby', kind: 'group', lastActive: 2000 };
const QUEST: Surface = { id: '@QuestBot', title: 'Quest Bot', kind: 'bot', lastActive: 1000 };
const ATTIC: Surface = { id: '#attic', title: 'The Attic', kind: 'group' };
const listed = (surfaces: Surface[]) => [200, { running: true, listed: true, surfaces }] as const;

describe('chats picked from lists', () => {
  it('ticks the chats a connector monitors from its surfaces, every chat while none is set', async () => {
    const core = fakeCore({
      routes: {
        'GET /accounts/chat/surfaces': [...listed([LOBBY, QUEST])],
        'GET /accounts/chat/surfaces?search=attic': [...listed([ATTIC])],
      },
    });
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node chat · in', {}, slow));
    const details = await screen.findByLabelText('details of chat');
    const picker = within(details).getByRole('group', { name: 'chats it monitors' });
    // Every chat, by default: each one ticked.
    const lobby = (await within(picker).findByLabelText('The Lobby')) as HTMLInputElement;
    expect(lobby.checked).toBe(true);
    expect((within(picker).getByLabelText('every chat') as HTMLInputElement).checked).toBe(true);
    // Unticking one makes a list of the others.
    fireEvent.click(lobby);
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes[0]?.config).toMatchObject({ chats: ['@QuestBot'] })
    );
    // A search finds one beyond the latest; ticked, it joins the list.
    fireEvent.change(within(picker).getByLabelText('search chats'), {
      target: { value: 'attic' },
    });
    const found = await within(picker).findByRole('list', { name: 'chats found' });
    fireEvent.click(within(found).getByLabelText('The Attic'));
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes[0]?.config).toMatchObject({
        chats: ['@QuestBot', '#attic'],
      })
    );
    // Back to every chat.
    fireEvent.click(within(picker).getByLabelText('every chat'));
    await waitFor(() => expect(core.checked.at(-1)?.nodes[0]?.config?.['chats']).toBeUndefined());
  });

  it('picks an edge’s reads and senders from the connector’s monitored chats', async () => {
    const core = fakeCore({
      routes: { 'GET /accounts/chat/surfaces': [...listed([LOBBY, QUEST])] },
    });
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    await screen.findByLabelText('node chat · in', {}, slow);
    fireEvent.click(screen.getByRole('button', { name: 'edge chat.chat → actor-a.chat' }));
    const panel = await screen.findByLabelText('details of edge chat.chat → actor-a.chat');
    const reads = within(panel).getByRole('group', { name: 'reads' });
    expect(((await within(reads).findByLabelText('The Lobby')) as HTMLInputElement).checked).toBe(
      true
    );
    fireEvent.click(within(reads).getByLabelText('Quest Bot'));
    await waitFor(() =>
      expect(core.checked.at(-1)?.edges[0]).toMatchObject({ reads: ['#a', '@QuestBot'] })
    );
    // All of them, from anyone: allowed, and flagged as broad.
    fireEvent.click(within(reads).getByLabelText('all the chats it monitors'));
    expect(await within(panel).findByRole('note')).toBeDefined();
    await waitFor(() => expect(core.checked.at(-1)?.edges[0]).toMatchObject({ reads: '*' }));
    // Senders: me, and a bot by its @username.
    fireEvent.click(within(panel).getByLabelText('only these'));
    const senders = within(panel).getByRole('group', { name: 'senders list' });
    fireEvent.change(within(senders).getByLabelText('new senders list'), {
      target: { value: '@QuestBot' },
    });
    fireEvent.click(within(senders).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(core.checked.at(-1)?.edges[0]).toMatchObject({ senders: ['me', '@QuestBot'] })
    );
    expect(within(panel).queryByRole('note')).toBeNull();
    fireEvent.click(within(panel).getByLabelText('me'));
    await waitFor(() =>
      expect(core.checked.at(-1)?.edges[0]).toMatchObject({ senders: ['@QuestBot'] })
    );
    fireEvent.click(within(panel).getByLabelText('me'));
    fireEvent.click(within(senders).getByRole('button', { name: 'remove @QuestBot' }));
    fireEvent.click(within(panel).getByLabelText('anyone'));
    await waitFor(() => expect(core.checked.at(-1)?.edges[0]?.senders).toBeUndefined());
    // Back from all to a list: the monitored chats, each ticked.
    fireEvent.click(within(reads).getByLabelText('all the chats it monitors'));
    await waitFor(() =>
      expect(core.checked.at(-1)?.edges[0]).toMatchObject({ reads: ['#a', '@QuestBot'] })
    );
    // A chat-out edge: its sends ticked from the same list.
    fireEvent.click(screen.getByRole('button', { name: 'edge actor-a.chat → chat.chat' }));
    const out = await screen.findByLabelText('details of edge actor-a.chat → chat.chat');
    const sends = within(out).getByRole('group', { name: 'sends' });
    fireEvent.click(await within(sends).findByLabelText('The Lobby'));
    await waitFor(() => expect(core.checked.at(-1)?.edges[1]).toMatchObject({ sends: [] }));
  });

  it('reminds the owner of the edges to update once the draft changes the chats', async () => {
    fakeCore({ routes: { 'GET /accounts/chat/surfaces': [...listed([LOBBY, QUEST])] } });
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node chat · in', {}, slow));
    const details = await screen.findByLabelText('details of chat');
    const picker = within(details).getByRole('group', { name: 'chats it monitors' });
    const lobby = await within(picker).findByLabelText('The Lobby');
    // As saved: no reminder.
    expect(within(picker).queryByRole('note', { name: 'edges to update' })).toBeNull();
    // The Lobby dropped: the edge that still reads it is named, and opens its panel.
    fireEvent.click(lobby);
    const note = await within(picker).findByRole('note', { name: 'edges to update' });
    expect(note.textContent).toContain('update the edges that should read them too');
    fireEvent.click(within(note).getByRole('button', { name: 'chat.chat → actor-a.chat' }));
    const edge = await screen.findByLabelText('details of edge chat.chat → actor-a.chat');
    expect(within(edge).getByRole('group', { name: 'reads' })).toBeDefined();
    expect(screen.queryByLabelText('details of chat')).toBeNull();
    // Back to the node, back to every chat, as saved: the reminder goes.
    fireEvent.click(screen.getByLabelText('node chat · in'));
    const again = await screen.findByLabelText('details of chat');
    const picker2 = within(again).getByRole('group', { name: 'chats it monitors' });
    expect(within(picker2).getByRole('note', { name: 'edges to update' })).toBeDefined();
    fireEvent.click(within(picker2).getByLabelText('every chat'));
    await waitFor(() =>
      expect(within(picker2).queryByRole('note', { name: 'edges to update' })).toBeNull()
    );
  });

  it('names the chat-in edges with a list that a change of the chats leaves behind', () => {
    const edges: GraphEdge[] = [
      { from: 'chat.chat', to: 'a.chat', type: 'chat-in', reads: ['#a'] },
      { from: 'chat.chat', to: 'b.chat', type: 'chat-in', reads: ['#a', '#B'] },
      { from: 'chat.chat', to: 'c.chat', type: 'chat-in', reads: '*' },
      { from: 'other.chat', to: 'd.chat', type: 'chat-in', reads: ['#a'] },
      { from: 'a.chat', to: 'chat.chat', type: 'chat-out', sends: ['#a'] },
    ];
    const to = (saved: string[] | undefined, draft: string[] | undefined) =>
      edgesToUpdate('chat', saved, draft, edges).map((e) => e.to);
    // A chat added: the lists without it.
    expect(to(['#a'], ['#a', '#b'])).toEqual(['a.chat']);
    // A chat removed: the lists that still read it.
    expect(to(['#a', '#b'], ['#b'])).toEqual(['a.chat', 'b.chat']);
    // Every chat now: every list; from every chat to a list, those reading beyond it.
    expect(to(['#a'], undefined)).toEqual(['a.chat', 'b.chat']);
    expect(to(undefined, ['#a'])).toEqual(['b.chat']);
    expect(sameChats(['#a', '#B'], ['#b', '#A'])).toBe(true);
    expect(sameChats(['#a'], ['#a', '#b'])).toBe(false);
    expect(sameChats(undefined, [])).toBe(false);
    expect(sameChats(undefined, undefined)).toBe(true);
  });

  it('says why there is no list', () => {
    expect(unlistedNote({ state: 'loading' })).toBe('Listing its chats…');
    expect(unlistedNote({ state: 'unlisted' })).toBe(
      'This connector cannot list its chats: type them.'
    );
    expect(unlistedNote({ state: 'error', error: 'not connected' })).toBe(
      'Its chats cannot be listed now: not connected'
    );
    expect(monitoredSurfaces([LOBBY], ['#A', '#b'])).toEqual([
      LOBBY,
      { id: '#b', title: '#b', kind: 'group' },
    ]);
  });
});
