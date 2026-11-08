// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore } from '#test/fake-core.ts';
import { status, VIEW } from '#test/graph-view.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { GraphPage } from './GraphPage.tsx';
import { layout } from './layout.ts';
import { SchemaForm } from './SchemaForm.tsx';

let restore: () => void;
beforeEach(() => {
  restore = stubReactFlow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restore();
});

const loggedOut = vi.fn();
/** Each wait with room: the whole suite runs at once, and React Flow draws a render late. */
const slow = { timeout: 5000 };

describe('GraphPage', () => {
  it('draws each node with its ports and live state, and each binding as an edge', async () => {
    fakeCore();
    const { container } = render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    const actor = await screen.findByLabelText('node actor-a', {}, slow);
    expect(within(actor).getAllByText('actor')).toHaveLength(2);
    await waitFor(() => expect(within(actor).getByText('running')).toBeDefined(), slow);
    expect(within(actor).getByText('dry-run')).toBeDefined();
    const parser = screen.getByLabelText('node parser');
    expect(within(parser).getByText('drift 1/2')).toBeDefined();
    // Each port in its type's shape and colour, inputs left and outputs right.
    const events = within(actor).getByTestId('port in game-events');
    expect(events.className).toContain('diamond');
    expect(events.className).toContain('optional');
    expect(events.className).toContain('react-flow__handle-left');
    expect(events.getAttribute('title')).toBe(
      'game-events: events of game (optional) — what happens'
    );
    const out = within(screen.getByLabelText('node chat')).getByTestId('port out chat');
    expect(out.className).toContain('circle');
    expect(out.className).toContain('react-flow__handle-right');
    await waitFor(() => expect(out.style.background).toBe('#2f7ed8'), slow);
    // The edges: one per binding, the optional one dashed.
    await waitFor(() => expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(3));
    const dashed = container.querySelector('.react-flow__edge.optional path') as SVGElement | null;
    expect(dashed?.style.strokeDasharray).toBe('6 4');
    expect(screen.getByText('optional input')).toBeDefined();
  });

  it('shows a node’s details: its instance, forms, and interface', async () => {
    fakeCore({
      instances: [
        { id: 'chat', plugin: 'chat', created: 1, referenced: Date.UTC(2026, 10, 1), used: true },
      ],
    });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node actor-a', {}, slow));
    const details = await screen.findByLabelText('details of actor-a');
    expect(within(details).getByText('plays the game')).toBeDefined();
    expect(within(details).getByText('dry-run')).toBeDefined();
    expect(within(details).getByText('no config')).toBeDefined();
    expect(within(details).getByText('(fresh: made at its first start)')).toBeDefined();
    expect((within(details).getByLabelText('loud') as HTMLInputElement).checked).toBe(false);
    expect(within(details).getByText('interface of parser')).toBeDefined();
    expect(within(details).getByText('poke <who>')).toBeDefined();
    expect(within(details).getByText('(owner’s)')).toBeDefined();
    expect(within(details).getByRole('group', { name: 'bump input' })).toBeDefined();
    expect(within(details).queryByRole('group', { name: 'stay input' })).toBeNull();

    fireEvent.click(screen.getByLabelText('node chat'));
    const chat = await screen.findByLabelText('details of chat');
    expect(within(chat).getByText('(kept; last referenced 2026-11-01 00:00)')).toBeDefined();
    expect((within(chat).getByLabelText('account') as HTMLInputElement).placeholder).toBe(
      'chat:me'
    );
    expect(within(chat).getByText('no settings')).toBeDefined();
    expect(within(chat).getByText('Secrets it reads: chat_password')).toBeDefined();
    expect((within(chat).getByLabelText('host') as HTMLInputElement).value).toBe('example.test');

    fireEvent.click(screen.getByLabelText('node parser'));
    const parser = await screen.findByLabelText('details of parser');
    expect(within(parser).getByText('10 read, 2 unread (1 recent)')).toBeDefined();
  });

  it('kills the nodes selected, once confirmed, and reinstates a killed one', async () => {
    let killed = false;
    const { api } = fakeCore({
      routes: {
        'GET /status': () => [200, status(killed)],
        'GET /drift': [200, []],
        'POST /plugins/actor-a/kill': () => {
          killed = true;
          return [200, { result: 'actor-a killed: actor-a: read-only' }];
        },
        'POST /plugins/parser/kill': [409, { error: 'parser is not running' }],
        'POST /plugins/actor-a/resume': () => {
          killed = false;
          return [200, { resumed: 'actor-a' }];
        },
      },
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node actor-a', {}, slow));
    await waitFor(() =>
      expect(within(screen.getByLabelText('node actor-a')).getByText('running')).toBeDefined()
    );
    // Cmd held: a second node joins the selection.
    fireEvent.keyDown(document, { key: 'Meta' });
    fireEvent.click(screen.getByLabelText('node parser'), { metaKey: true });
    fireEvent.keyUp(document, { key: 'Meta' });
    const kill = await screen.findByRole('button', { name: 'Kill selected (2)' });
    expect(screen.getByText('Selected: parser, actor-a')).toBeDefined();
    expect(screen.queryByLabelText(/^details of/u)).toBeNull();
    fireEvent.click(kill);
    expect(confirm).toHaveBeenCalledWith("Kill parser, actor-a: run each one's safety stop?");
    expect(api.calls.filter((c) => c.includes('/kill'))).toEqual([]);
    confirm.mockReturnValue(true);
    fireEvent.click(kill);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'parser: parser is not running; actor-a killed: actor-a: read-only'
      )
    );
    // Drawn disabled, with its reinstatement at hand.
    const actor = screen.getByLabelText('node actor-a');
    await waitFor(() => expect(actor.getAttribute('aria-disabled')).toBe('true'));
    expect(actor.className).toContain('killed');
    expect(within(actor).getByText('killed')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Kill selected (1)' })).toBeDefined();
    fireEvent.click(within(actor).getByRole('button', { name: 'Reinstate' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveProperty('textContent', 'actor-a reinstated')
    );
    await waitFor(() => expect(actor.getAttribute('aria-disabled')).toBe('false'));
    expect(api.calls).toContain('POST /plugins/actor-a/resume {}');
  });

  it('kills one node from its details, and keeps a killed node’s config editable', async () => {
    let killed = false;
    const { checked } = fakeCore({
      routes: {
        'GET /status': () => [
          200,
          {
            off: true,
            plugins: status().plugins.map((p) =>
              p.id === 'chat' && killed
                ? { ...p, state: 'paused', reason: 'killed by the owner', killed: true }
                : p
            ),
          },
        ],
        'POST /plugins/chat/kill': () => {
          killed = true;
          return [200, { result: 'chat killed' }];
        },
        'POST /plugins/chat/resume': [409, { error: 'the bot is off: `cli.ts on` first' }],
      },
    });
    vi.stubGlobal('confirm', () => true);
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    expect(await screen.findByText('instance off', {}, slow)).toBeDefined();
    fireEvent.click(await screen.findByLabelText('node chat', {}, slow));
    const details = await screen.findByLabelText('details of chat');
    await waitFor(() => expect(within(details).getByRole('button', { name: 'Kill chat' })));
    fireEvent.click(within(details).getByRole('button', { name: 'Kill chat' }));
    expect(
      await within(details).findByText('Killed: it sends nothing until reinstated.', {}, slow)
    );
    fireEvent.click(within(details).getByRole('button', { name: 'Reinstate' }));
    expect(await screen.findByText('chat: the bot is off: `cli.ts on` first')).toBeDefined();
    const host = within(details).getByLabelText('host') as HTMLInputElement;
    fireEvent.change(host, { target: { value: 'other.test' } });
    await waitFor(() => expect(checked.at(-1)?.nodes[0]?.config).toEqual({ host: 'other.test' }));
  });

  it('says when the saved graph cannot be read, or does not read', async () => {
    fakeCore({ routes: { 'GET /graph/file': [500, { error: 'the disk is gone' }] } });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    expect(await screen.findByText('the disk is gone', {}, slow)).toBeDefined();
    cleanup();
    fakeCore({
      routes: {
        'GET /graph/file': [
          200,
          { exists: true, error: 'graph.json is not JSON: x', differs: true },
        ],
      },
    });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    expect(
      await screen.findByText(
        'graph.json is not JSON: x. Saving a graph here replaces it.',
        {},
        slow
      )
    ).toBeDefined();
  });

  it('says why the status cannot be read', async () => {
    fakeCore({ routes: { 'GET /status': [500, { error: 'broken' }], 'GET /drift': [200, []] } });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    // The alert can come before React Flow has measured and drawn the nodes, and both take longer
    // than the default second when the whole suite runs: each is awaited, with room.
    expect(await screen.findByRole('alert', {}, slow)).toHaveProperty('textContent', 'broken');
    const actor = await screen.findByLabelText('node actor-a', {}, slow);
    expect(within(actor).getByText('not running')).toBeDefined();
  });

  it('shows first that the saved graph was refused at start', async () => {
    fakeCore({
      status: {
        ...status(),
        graph: { refused: [{ text: 'plugin gone: not offered', node: 'gone' }] },
      },
    });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    const alert = await screen.findByRole('alert', {}, slow);
    await waitFor(() => expect(alert.textContent).toContain('refused at the last start'));
    expect(within(alert).getByText('plugin gone: not offered')).toBeDefined();
  });
});

describe('SchemaForm', () => {
  it('makes a field of each property, its value or its default, read-only', () => {
    const chat = VIEW.nodes[0];
    render(<SchemaForm legend="config" schema={chat?.configSchema ?? {}} value={chat?.config} />);
    const host = screen.getByLabelText('host') as HTMLInputElement;
    expect([host.value, host.readOnly, host.type]).toEqual(['example.test', true, 'text']);
    expect(screen.getByText('the server')).toBeDefined();
    expect((screen.getByLabelText('port') as HTMLInputElement).value).toBe('6667');
    expect((screen.getByLabelText('tls') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('flavour') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('channels') as HTMLTextAreaElement).value).toBe('[\n  "#a"\n]');
    expect((screen.getByLabelText('note') as HTMLInputElement).type).toBe('text');
    expect((screen.getByLabelText('burst') as HTMLInputElement).value).toBe('3');
    expect(screen.getByRole('group', { name: 'limits' })).toBeDefined();
    // Every field but the one given is at its default, or optional.
    expect(screen.getAllByText('default')).toHaveLength(4);
    expect(screen.getAllByText('(optional)')).toHaveLength(7);
  });

  it('edits each field: a value set, emptied (its default back), a secret named, JSON typed', () => {
    const chat = VIEW.nodes[0];
    let value: Record<string, unknown> = { host: 'example.test', token: 'old_secret' };
    const changed = vi.fn((v: Record<string, unknown>) => {
      value = v;
    });
    const form = () => (
      <SchemaForm
        legend="config"
        schema={chat?.configSchema ?? {}}
        value={value}
        onChange={changed}
        secretKeys={['token']}
        secretNames={['token_a']}
        errors={{ host: ['expected a host'] }}
      />
    );
    const { rerender } = render(form());
    expect(screen.getByText('expected a host')).toBeDefined();
    fireEvent.change(screen.getByLabelText('port'), { target: { value: '7000' } });
    expect(value).toMatchObject({ port: 7000 });
    rerender(form());
    fireEvent.change(screen.getByLabelText('port'), { target: { value: '' } });
    expect(value).not.toHaveProperty('port');
    rerender(form());
    fireEvent.click(screen.getByLabelText('tls'));
    expect(value).toMatchObject({ tls: false });
    rerender(form());
    fireEvent.change(screen.getByLabelText('flavour'), { target: { value: 'fancy' } });
    expect(value).toMatchObject({ flavour: 'fancy' });
    rerender(form());
    fireEvent.change(screen.getByLabelText('flavour'), { target: { value: '' } });
    expect(value).not.toHaveProperty('flavour');
    rerender(form());
    // A secret: a choice of the names provided, the one it names now kept among them.
    const token = screen.getByLabelText('token') as HTMLSelectElement;
    expect([...token.options].map((o) => o.value)).toEqual(['', 'token_a', 'old_secret']);
    fireEvent.change(token, { target: { value: 'token_a' } });
    expect(value).toMatchObject({ token: 'token_a' });
    rerender(form());
    fireEvent.change(screen.getByLabelText('token'), { target: { value: '' } });
    expect(value).not.toHaveProperty('token');
    rerender(form());
    // JSON: kept as typed until it reads.
    const channels = screen.getByLabelText('channels') as HTMLTextAreaElement;
    fireEvent.change(channels, { target: { value: '["#b"' } });
    fireEvent.blur(channels);
    expect(screen.getByText('not JSON: unchanged')).toBeDefined();
    fireEvent.change(channels, { target: { value: '["#b"]' } });
    fireEvent.blur(channels);
    expect(value).toMatchObject({ channels: ['#b'] });
    rerender(form());
    fireEvent.blur(screen.getByLabelText('channels'));
    fireEvent.change(screen.getByLabelText('channels'), { target: { value: ' ' } });
    fireEvent.blur(screen.getByLabelText('channels'));
    expect(value).not.toHaveProperty('channels');
    rerender(form());
    // A nested object.
    fireEvent.change(screen.getByLabelText('burst'), { target: { value: '5' } });
    expect(value).toMatchObject({ limits: { burst: 5 } });
    rerender(form());
    fireEvent.change(screen.getByLabelText('host'), { target: { value: 'b.test' } });
    expect(value).toMatchObject({ host: 'b.test' });
  });

  it('says when there is nothing to set', () => {
    render(<SchemaForm legend="empty" schema={{ type: 'object' }} />);
    expect(screen.getByText('nothing to set')).toBeDefined();
  });
});

describe('layout', () => {
  it('puts each node a column past what feeds it, leaving loops out', () => {
    const placed = layout(
      ['a', 'b', 'c', 'd'],
      [
        { from: 'a.out', to: 'b.in' },
        { from: 'b.out', to: 'c.in' },
        { from: 'a.out', to: 'c.other' },
        { from: 'c.out', to: 'b.back' },
        { from: 'gone.out', to: 'd.in' },
        { from: 'd.out', to: 'd.self' },
      ],
      () => 100
    );
    expect(Object.fromEntries(placed)).toEqual({
      a: { x: 0, y: 0 },
      b: { x: 320, y: 0 },
      c: { x: 640, y: 0 },
      d: { x: 0, y: 140 },
    });
  });
});
