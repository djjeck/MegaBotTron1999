// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailablePlugin, Graph, PluginView } from '#src/ui/api.ts';
import { GraphPage } from '#src/ui/graph/GraphPage.tsx';
import { fakeCore } from '#test/fake-core.ts';
import { AVAILABLE, status } from '#test/graph-view.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { ApiPanel, ScriptEditor } from './ScriptEditor.tsx';
import { fieldsOf, freeName, listOf, renamed, ScriptPorts } from './ScriptPorts.tsx';
import { scriptApi } from './types.ts';

// Monaco needs a browser: a text area stands in for it, its diagnostics read from the text.
vi.mock('./ScriptCode.tsx', () => ({
  default: (p: {
    value: string;
    dts: string;
    onChange: (v: string) => void;
    onDiagnostics: (d: { syntax: string[]; types: string[] }) => void;
  }) => {
    const tell = (v: string) =>
      p.onDiagnostics({
        syntax: v.includes('((') ? ['line 1: ")" expected'] : [],
        types: v.includes('nope') ? ["line 1: Cannot find name 'nope'"] : [],
      });
    return (
      <textarea
        aria-label="code"
        data-dts={p.dts}
        defaultValue={p.value}
        ref={(el) => {
          if (el !== null && el.dataset['told'] === undefined) {
            el.dataset['told'] = '1';
            setTimeout(() => tell(p.value), 0);
          }
        }}
        onChange={(e) => {
          p.onChange(e.target.value);
          tell(e.target.value);
        }}
      />
    );
  },
}));

let restore: () => void;
beforeEach(() => {
  restore = stubReactFlow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restore();
});

const parser = AVAILABLE.find((p) => p.plugin === 'parser') as AvailablePlugin;

const CONFIG = {
  inputs: {
    'game-events': { type: 'events', namespace: 'game' },
    board: { type: 'interface', plugin: 'parser', members: ['state.board'] },
  },
  outputs: { chat: { type: 'chat-out', commands: ['/look'], minIntervalS: { '/look': 30 } } },
  events: { looked: { help: 'An item looked at', fields: { item: 'string' } } },
  code: "on('game.win', () => log('won'));\n",
  limits: { callMs: 1000, memoryMb: 64 },
};

const SCRIPT: AvailablePlugin = {
  id: 'script',
  plugin: 'script',
  version: '0.1.0',
  description: 'Runs TypeScript typed in the editor',
  kinds: ['actor'],
  configSchema: { type: 'object', properties: { code: { type: 'string', default: '' } } },
  inputs: {},
  outputs: {},
  interface: { reads: [], actions: [], commands: [] },
  secrets: [],
  configSecrets: [],
  events: [],
};

/** The script node as the check describes it, from its config (D74). */
const LOOK_VIEW: PluginView = {
  ...SCRIPT,
  inputs: {
    'game-events': { type: 'events', namespace: 'game', label: 'events of game', optional: false },
    board: {
      type: 'interface',
      plugin: 'parser',
      members: ['state.board'],
      label: 'interface of parser',
      optional: false,
    },
  },
  outputs: {
    chat: {
      type: 'chat-out',
      commands: ['/look'],
      minIntervalS: { '/look': 30 },
      label: 'chat-out of any network',
      optional: false,
    },
    events: {
      type: 'events',
      namespace: 'look',
      types: [{ type: 'look.looked', help: 'An item looked at' }],
      label: 'events of look',
      optional: false,
    },
  },
};

const api = scriptApi({
  node: { id: 'look', plugin: 'script', config: CONFIG },
  nodes: [{ id: 'parser', plugin: 'parser' }],
  edges: [{ from: 'parser.events', to: 'look.game-events' }],
  viewOf: () => parser,
  available: [parser],
});

describe('the script editor', () => {
  it('lists the API beside the code: ports, members, event types, outputs, its own', () => {
    render(<ApiPanel api={api} />);
    const panel = screen.getByRole('complementary', { name: 'script API' });
    expect(panel.textContent).toContain('game.message');
    expect(panel.textContent).toContain('a line of the game');
    expect(panel.textContent).toContain('state.board() → string[]');
    expect(panel.textContent).toContain('enqueue("chat", chat, text)');
    expect(panel.textContent).toContain('/look, not bound');
    expect(panel.textContent).toContain('publish("look.looked", { item: string })');
    expect(panel.textContent).toContain('on(type, fn)');
    cleanup();
    render(
      <ApiPanel
        api={{
          events: [{ port: 'e', namespace: 'none', from: [], types: [] }],
          interfaces: [{ port: 'i', members: [{ name: 'state.x', unknown: true }] }],
          outputs: [],
          own: [],
        }}
      />
    );
    expect(screen.getByText('No event type known in it.')).toBeDefined();
    expect(screen.getByText(/not offered there/u)).toBeDefined();
    expect(screen.getByText('No chat-out output.')).toBeDefined();
  });

  it('keeps code that parses, refuses code that does not, and shows type errors', async () => {
    const keep = vi.fn();
    const close = vi.fn();
    render(
      <ScriptEditor
        id="look"
        code={CONFIG.code}
        api={api}
        problems={['config code: does not parse']}
        keep={keep}
        close={close}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'script of look' });
    const code = (await within(dialog).findByLabelText('code')) as HTMLTextAreaElement;
    expect(code.dataset['dts']).toContain('declare function on<');
    expect(within(dialog).getByText('config code: does not parse')).toBeDefined();
    await waitFor(() => expect(within(dialog).getByRole('status').textContent).toBe('No errors'));
    const keepButton = within(dialog).getByRole('button', { name: 'Keep' }) as HTMLButtonElement;
    expect(keepButton.disabled).toBe(true);
    fireEvent.change(code, { target: { value: 'on((' } });
    expect(within(dialog).getByRole('status').textContent).toBe(
      '1 syntax error: it cannot be kept'
    );
    expect(keepButton.disabled).toBe(true);
    fireEvent.change(code, { target: { value: 'nope; nope();' } });
    expect(within(dialog).getByRole('status').textContent).toBe('1 type error');
    expect(within(dialog).getByRole('list', { name: 'errors' }).textContent).toContain(
      "Cannot find name 'nope'"
    );
    fireEvent.click(keepButton);
    expect(keep).toHaveBeenCalledWith('nope; nope();');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('a script node’s ports, in its panel', () => {
  it('names and lists as the form needs', () => {
    expect(freeName('chat', ['chat', 'chat-2'])).toBe('chat-3');
    expect(freeName('x', [])).toBe('x');
    expect(renamed({ a: 1, b: 2 }, 'a', 'c')).toEqual({ c: 1, b: 2 });
    expect(listOf(' /a, ,/b ')).toEqual(['/a', '/b']);
    expect(fieldsOf('item: string, n:, x')).toEqual({ item: 'string', n: 'unknown', x: 'unknown' });
  });

  it('edits each kind of port, its own events and its limits, as config', () => {
    let config: Record<string, unknown> = { ...CONFIG };
    const change = vi.fn((c: Record<string, unknown>) => {
      config = c;
    });
    const view = (errors: Record<string, string[]> = {}) => (
      <ScriptPorts config={config} change={change} plugins={[parser, LOOK_VIEW]} errors={errors} />
    );
    const { rerender } = render(view({ inputs: ['input port x: bad'] }));
    const again = () => rerender(view());
    expect(screen.getByText('input port x: bad')).toBeDefined();
    // Events: a namespace, optional, renamed, added, removed.
    fireEvent.change(screen.getByLabelText('namespace of game-events'), {
      target: { value: 'look' },
    });
    again();
    fireEvent.click(screen.getByLabelText('game-events is optional'));
    again();
    expect(config['inputs']).toMatchObject({
      'game-events': { type: 'events', namespace: 'look', optional: true },
    });
    fireEvent.change(screen.getByLabelText('port of events input game-events'), {
      target: { value: 'heard' },
    });
    again();
    expect(Object.keys(config['inputs'] as object)).toEqual(['heard', 'board']);
    fireEvent.click(screen.getByRole('button', { name: '+ events input' }));
    again();
    expect((config['inputs'] as Record<string, unknown>)['events']).toEqual({
      type: 'events',
      namespace: 'game',
    });
    fireEvent.click(screen.getByLabelText('remove events input events'));
    again();
    // An interface: its members picked from what its plugin offers.
    const members = screen.getByLabelText('members of board');
    fireEvent.click(within(members).getByLabelText('actions.reset'));
    again();
    expect((config['inputs'] as Record<string, { members: string[] }>)['board']?.members).toEqual([
      'state.board',
      'actions.reset',
    ]);
    fireEvent.click(
      within(screen.getByLabelText('members of board')).getByLabelText('state.board')
    );
    again();
    fireEvent.click(screen.getByLabelText('board is optional'));
    again();
    fireEvent.change(screen.getByLabelText('plugin of board'), { target: { value: 'elsewhere' } });
    again();
    fireEvent.blur(screen.getByLabelText('members of board, by name'), {
      target: { value: 'state.x, actions.y' },
    });
    again();
    expect((config['inputs'] as Record<string, unknown>)['board']).toEqual({
      type: 'interface',
      plugin: 'elsewhere',
      members: ['state.x', 'actions.y'],
      optional: true,
    });
    fireEvent.change(screen.getByLabelText('plugin of board'), { target: { value: '' } });
    again();
    expect((config['inputs'] as Record<string, unknown>)['board']).not.toHaveProperty('plugin');
    fireEvent.click(screen.getByRole('button', { name: '+ interface input' }));
    again();
    expect((config['inputs'] as Record<string, unknown>)['parser']).toEqual({
      type: 'interface',
      plugin: 'parser',
      members: ['state.board'],
    });
    // Outputs: commands, spacing, added and removed.
    fireEvent.blur(screen.getByLabelText('commands of chat'), { target: { value: '/look, /inv' } });
    again();
    fireEvent.change(screen.getByLabelText('seconds between two /inv'), {
      target: { value: '60' },
    });
    again();
    expect((config['outputs'] as Record<string, unknown>)['chat']).toEqual({
      type: 'chat-out',
      commands: ['/look', '/inv'],
      minIntervalS: { '/look': 30, '/inv': 60 },
    });
    fireEvent.change(screen.getByLabelText('seconds between two /inv'), { target: { value: '' } });
    again();
    fireEvent.change(screen.getByLabelText('seconds between two /look'), { target: { value: '' } });
    again();
    expect((config['outputs'] as Record<string, unknown>)['chat']).not.toHaveProperty(
      'minIntervalS'
    );
    fireEvent.click(screen.getByRole('button', { name: '+ chat-out output' }));
    again();
    fireEvent.change(screen.getByLabelText('port of chat-out output chat-2'), {
      target: { value: 'chat' },
    });
    fireEvent.click(screen.getByLabelText('remove chat-out output chat-2'));
    again();
    expect(Object.keys(config['outputs'] as object)).toEqual(['chat']);
    // Its own events.
    fireEvent.change(screen.getByLabelText('help of event looked'), {
      target: { value: 'Looked at' },
    });
    again();
    fireEvent.blur(screen.getByLabelText('fields of event looked'), {
      target: { value: 'item: string, n: number' },
    });
    again();
    fireEvent.click(screen.getByRole('button', { name: '+ event' }));
    again();
    fireEvent.change(screen.getByLabelText('name of event done'), {
      target: { value: 'finished' },
    });
    again();
    expect(config['events']).toEqual({
      looked: { help: 'Looked at', fields: { item: 'string', n: 'number' } },
      finished: { help: 'What it did', fields: {} },
    });
    fireEvent.click(screen.getByLabelText('remove event finished'));
    again();
    // Its limits.
    fireEvent.change(screen.getByLabelText('time limit in ms'), { target: { value: '250' } });
    again();
    fireEvent.change(screen.getByLabelText('memory limit in MB'), { target: { value: '32' } });
    again();
    expect(config['limits']).toEqual({ callMs: 250, memoryMb: 32 });
  });

  it('starts from nothing when no plugin offers anything', () => {
    let config: Record<string, unknown> = {};
    render(<ScriptPorts config={{}} change={(c) => (config = c)} plugins={[]} errors={{}} />);
    fireEvent.click(screen.getByRole('button', { name: '+ interface input' }));
    expect(config['inputs']).toEqual({ interface: { type: 'interface', members: [] } });
    fireEvent.click(screen.getByRole('button', { name: '+ events input' }));
    expect((screen.getByLabelText('time limit in ms') as HTMLInputElement).value).toBe('1000');
  });
});

describe('a script node in the graph editor', () => {
  it('is drawn with the ports its config declares, and opens its code in the editor', async () => {
    const graph: Graph = {
      version: 2,
      nodes: [
        { id: 'parser', plugin: 'parser' },
        { id: 'look', plugin: 'script', config: CONFIG },
      ],
      edges: [{ from: 'parser.events', to: 'look.game-events', type: 'events' }],
    };
    const checked: Graph[] = [];
    const core = fakeCore({
      file: graph,
      available: [...AVAILABLE, SCRIPT],
      status: { off: false, plugins: [] },
      routes: {
        'POST /graph/check': (body) => {
          checked.push(body as Graph);
          return [
            200,
            {
              ok: false,
              problems: [
                { text: 'plugin look: config code: does not parse', node: 'look', config: 'code' },
              ],
              diff: {
                nodes: { added: [], removed: [], changed: [] },
                edges: { added: [], removed: [], changed: [] },
              },
              views: { look: LOOK_VIEW },
              text: JSON.stringify(body).slice(0, 10),
            },
          ];
        },
      },
    });
    core.running = graph;
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    const node = await screen.findByLabelText('node look', {}, { timeout: 5000 });
    fireEvent.click(node);
    const panel = await screen.findByLabelText('details of look');
    await waitFor(() =>
      expect(within(panel).getByRole('list', { name: 'commands it sends' }).textContent).toContain(
        '/look'
      )
    );
    expect(within(panel).queryByRole('heading', { name: 'Script' })).not.toBeNull();
    expect(within(panel).getByLabelText('problems of its code').textContent).toContain(
      'does not parse'
    );
    expect(within(panel).getByText(/2 lines of TypeScript/u)).toBeDefined();
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit script' }));
    const dialog = await screen.findByRole('dialog', { name: 'script of look' });
    const code = (await within(dialog).findByLabelText('code')) as HTMLTextAreaElement;
    fireEvent.change(code, { target: { value: "on('game.win', () => log('again'));" } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'script of look' })).toBeNull()
    );
    await waitFor(() =>
      expect(checked.at(-1)?.nodes.find((n) => n.id === 'look')?.config?.['code']).toBe(
        "on('game.win', () => log('again'));"
      )
    );
    expect(status).toBeDefined();
  });
});
