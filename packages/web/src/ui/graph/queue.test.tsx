// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntryView } from '#src/ui/api.ts';
import { fakeCore } from '#test/fake-core.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { GraphPage } from './GraphPage.tsx';
import { cancelText } from './Queue.tsx';

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
const T = Date.parse('2026-11-12T09:00:00Z');

const ENTRY: QueueEntryView = {
  chat: '#a',
  text: '/inventory',
  command: '/inventory',
  queuedAt: T,
  waitingUntil: Date.parse('2099-01-01T09:05:00Z'),
  intervalS: 300,
  nodes: [
    {
      plugin: 'actor-a',
      origin: 'stock',
      cancel: { on: ['parser.changed'], when: { sections: 'inventory' }, deadline: T + 600_000 },
    },
    { plugin: 'actor-b', origin: 'actor-b' },
  ],
};

describe('the queue in the editor (D73)', () => {
  it('sets a command’s spacing on a chat-out edge, taken out with its command', async () => {
    const core = fakeCore();
    const out = () => core.checked.at(-1)?.edges.find((e) => e.from === 'actor-a.chat');
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'edge actor-a.chat → chat.chat' }, slow)
    );
    const panel = await screen.findByLabelText('details of edge actor-a.chat → chat.chat');
    // No command named: nothing to space.
    expect(within(panel).queryByRole('group', { name: 'spacing' })).toBeNull();
    fireEvent.change(within(panel).getByLabelText('new commands'), {
      target: { value: '/inventory' },
    });
    fireEvent.keyDown(within(panel).getByLabelText('new commands'), { key: 'Enter' });
    const field = await within(panel).findByLabelText('seconds between two /inventory');
    fireEvent.change(field, { target: { value: '300' } });
    await waitFor(() =>
      expect(out()).toMatchObject({
        commands: ['/inventory'],
        minIntervalS: { '/inventory': 300 },
      })
    );
    // Emptied: the connector's default.
    fireEvent.change(field, { target: { value: '' } });
    await waitFor(() => expect(out()).not.toHaveProperty('minIntervalS'));
    fireEvent.change(field, { target: { value: '60' } });
    await waitFor(() => expect(out()).toMatchObject({ minIntervalS: { '/inventory': 60 } }));
    fireEvent.click(within(panel).getByRole('button', { name: 'remove /inventory' }));
    await waitFor(() => expect(out()).not.toHaveProperty('minIntervalS'));
  });

  it('shows what waits in a running connector’s queue, its nodes and their cancels', async () => {
    let answer: [number, unknown] = [200, { account: 'chat:me', entries: [ENTRY] }];
    fakeCore({ routes: { 'GET /plugins/chat/queue': () => answer } });
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node chat · out', {}, slow));
    const queue = await screen.findByLabelText('queue of chat');
    expect(within(queue).getByText('/inventory')).toBeDefined();
    expect(within(queue).getByText(/waits until 09:05:00 UTC/u)).toBeDefined();
    expect(within(queue).getByText('(300 s between two /inventory)')).toBeDefined();
    expect(within(queue).getByText(/on parser.changed \(sections = "inventory"\)/u)).toBeDefined();
    expect(within(queue).getByText('no cancel')).toBeDefined();
    expect(within(queue).getByText(/\(stock\)/u)).toBeDefined();
    answer = [200, { entries: [] }];
    fireEvent.click(screen.getByLabelText('node parser'));
    fireEvent.click(await screen.findByLabelText('node chat · out'));
    await screen.findByText('Nothing waits.');
    answer = [409, { error: 'not now' }];
    fireEvent.click(screen.getByLabelText('node parser'));
    fireEvent.click(await screen.findByLabelText('node chat · out'));
    await screen.findByText('not now');
  });

  it('words a node’s cancel conditions', () => {
    expect(cancelText(undefined)).toBe('no cancel');
    expect(cancelText({ on: ['a.b', 'c.d'], test: true, deadline: T })).toBe(
      'on a.b, c.d · a test of its own · by 09:00:00'
    );
    expect(cancelText({ deadline: T })).toBe('by 09:00:00');
  });
});
