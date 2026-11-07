// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '#test/fake-api.ts';
import { DRIFT, status, VIEW } from '#test/graph-view.ts';
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

describe('GraphPage', () => {
  it('draws each node with its ports and live state, and each binding as an edge', async () => {
    fakeApi({
      'GET /graph/view': [200, VIEW],
      'GET /status': [200, status()],
      'GET /drift': [200, DRIFT],
    });
    const { container } = render(<GraphPage loggedOut={loggedOut} />);
    const actor = await screen.findByLabelText('node actor-a');
    expect(within(actor).getAllByText('actor')).toHaveLength(2);
    await waitFor(() => expect(within(actor).getByText('running')).toBeDefined());
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
    expect(out.style.background).toBe('#2f7ed8');
    // The edges: one per binding, the optional one dashed.
    await waitFor(() => expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(3));
    const dashed = container.querySelector('.react-flow__edge.optional path') as SVGElement | null;
    expect(dashed?.style.strokeDasharray).toBe('6 4');
    expect(screen.getByText('optional input')).toBeDefined();
  });

  it('shows a node’s details: config and settings in forms, and its interface', async () => {
    fakeApi({
      'GET /graph/view': [200, VIEW],
      'GET /status': [200, status()],
      'GET /drift': [200, DRIFT],
    });
    render(<GraphPage loggedOut={loggedOut} />);
    fireEvent.click(await screen.findByLabelText('node actor-a'));
    const details = await screen.findByLabelText('details of actor-a');
    expect(within(details).getByText('plays the game')).toBeDefined();
    expect(within(details).getByText('dry-run')).toBeDefined();
    expect(within(details).getByText('no config')).toBeDefined();
    expect((within(details).getByLabelText('loud') as HTMLInputElement).checked).toBe(true);
    expect((within(details).getByLabelText('level') as HTMLInputElement).value).toBe('2');
    expect(within(details).getByText('interface of parser')).toBeDefined();
    expect(within(details).getByText('poke <who>')).toBeDefined();
    expect(within(details).getByText('(owner’s)')).toBeDefined();
    expect(within(details).getByRole('group', { name: 'bump input' })).toBeDefined();
    expect(within(details).queryByRole('group', { name: 'stay input' })).toBeNull();

    fireEvent.click(screen.getByLabelText('node chat'));
    const chat = await screen.findByLabelText('details of chat');
    expect(within(chat).getByText('chat:me')).toBeDefined();
    expect(within(chat).getByText('no settings')).toBeDefined();
    expect((within(chat).getByLabelText('host') as HTMLInputElement).value).toBe('example.test');

    fireEvent.click(screen.getByLabelText('node parser'));
    const parser = await screen.findByLabelText('details of parser');
    expect(within(parser).getByText('10 read, 2 unread (1 recent)')).toBeDefined();
  });

  it('kills the nodes selected, once confirmed, and reinstates a killed one', async () => {
    let killed = false;
    const api = fakeApi({
      'GET /graph/view': [200, VIEW],
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
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<GraphPage loggedOut={loggedOut} />);
    fireEvent.click(await screen.findByLabelText('node actor-a'));
    // Cmd held: a second node joins the selection.
    fireEvent.keyDown(document, { key: 'Meta' });
    fireEvent.click(screen.getByLabelText('node parser'), { metaKey: true });
    fireEvent.keyUp(document, { key: 'Meta' });
    const kill = await screen.findByRole('button', { name: 'Kill selected (2)' });
    expect(screen.getByText('Selected: parser, actor-a')).toBeDefined();
    expect(screen.queryByLabelText(/^details of/u)).toBeNull();
    fireEvent.click(kill);
    expect(confirm).toHaveBeenCalledWith("Kill parser, actor-a: run each one's safety stop?");
    expect(api.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    confirm.mockReturnValue(true);
    fireEvent.click(kill);
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      'parser: parser is not running; actor-a killed: actor-a: read-only'
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

  it('kills one node from its details, and keeps a killed node’s forms as they were', async () => {
    let killed = false;
    fakeApi({
      'GET /graph/view': [200, VIEW],
      'GET /status': () => [200, status(killed, true)],
      'GET /drift': [200, []],
      'POST /plugins/actor-a/kill': () => {
        killed = true;
        return [200, { result: 'actor-a killed' }];
      },
      'POST /plugins/actor-a/resume': [409, { error: 'the bot is off: `cli.ts on` first' }],
    });
    vi.stubGlobal('confirm', () => true);
    render(<GraphPage loggedOut={loggedOut} />);
    expect(await screen.findByText('instance off')).toBeDefined();
    fireEvent.click(await screen.findByLabelText('node actor-a'));
    const details = await screen.findByLabelText('details of actor-a');
    const before = within(details).getByRole('group', { name: 'settings' }).outerHTML;
    fireEvent.click(await within(details).findByRole('button', { name: 'Kill actor-a' }));
    expect(await within(details).findByText('Killed: it sends nothing until reinstated.'));
    expect(within(details).getByRole('group', { name: 'settings' }).outerHTML).toBe(before);
    fireEvent.click(within(details).getByRole('button', { name: 'Reinstate' }));
    expect(await screen.findByText('actor-a: the bot is off: `cli.ts on` first')).toBeDefined();
  });

  it('says when the graph is not loaded yet, or cannot be read', async () => {
    fakeApi({ 'GET /graph/view': [200, null], 'GET /status': [500, {}], 'GET /drift': [200, []] });
    render(<GraphPage loggedOut={loggedOut} />);
    expect(await screen.findByText('The instance has not loaded its graph yet.')).toBeDefined();
    cleanup();
    fakeApi({});
    render(<GraphPage loggedOut={loggedOut} />);
    expect(await screen.findByText('not found')).toBeDefined();
  });

  it('says why the status cannot be read', async () => {
    fakeApi({
      'GET /graph/view': [200, VIEW],
      'GET /status': [500, { error: 'broken' }],
      'GET /drift': [200, []],
    });
    render(<GraphPage loggedOut={loggedOut} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'broken');
    expect(within(screen.getByLabelText('node actor-a')).getByText('…')).toBeDefined();
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
    expect(screen.getAllByText('(optional)')).toHaveLength(6);
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
