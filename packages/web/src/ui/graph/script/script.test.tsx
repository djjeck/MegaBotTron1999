// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailablePlugin, Graph, PluginView } from '#src/ui/api.ts';
import { freeName } from '#src/ui/graph/draft.ts';
import { GraphPage } from '#src/ui/graph/GraphPage.tsx';
import { fakeCore } from '#test/fake-core.ts';
import { AVAILABLE, status } from '#test/graph-view.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { ApiPanel, ScriptEditor } from './ScriptEditor.tsx';
import { fieldsOf, listOf, renamed, ScriptPorts } from './ScriptPorts.tsx';
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
    // Escape, once the code changed, asks first.
    vi.stubGlobal('confirm', () => true);
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
      <ScriptPorts
        id="look"
        edges={[]}
        config={config}
        change={change}
        plugins={[parser, LOOK_VIEW]}
        errors={errors}
      />
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
    // Renamed once left, not at each keystroke.
    expect(Object.keys(config['inputs'] as object)).toEqual(['game-events', 'board']);
    fireEvent.blur(screen.getByLabelText('port of events input game-events'));
    again();
    expect(Object.keys(config['inputs'] as object)).toEqual(['heard', 'board']);
    fireEvent.click(screen.getByRole('button', { name: '+ events input' }));
    again();
    expect((config['inputs'] as Record<string, unknown>)['events']).toEqual({
      type: 'events',
      namespace: '',
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
    fireEvent.change(screen.getByLabelText('plugin of board'), {
      target: { value: '\u0000other' },
    });
    again();
    fireEvent.change(screen.getByLabelText('plugin of board, typed'), {
      target: { value: ' elsewhere ' },
    });
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
    expect((config['inputs'] as Record<string, unknown>)['interface']).toEqual({
      type: 'interface',
      members: [],
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
    // A name taken is refused, marked, and put back.
    const taken = screen.getByLabelText('port of chat-out output chat-2') as HTMLInputElement;
    fireEvent.change(taken, { target: { value: 'chat' } });
    expect(taken.getAttribute('aria-invalid')).toBe('true');
    expect(taken.title).toBe('chat is taken');
    fireEvent.keyDown(taken, { key: 'Enter' });
    expect(taken.value).toBe('chat-2');
    fireEvent.change(taken, { target: { value: ' ' } });
    expect(taken.title).toBe('a name is needed');
    fireEvent.keyDown(taken, { key: 'Escape' });
    expect(taken.value).toBe('chat-2');
    expect(Object.keys(config['outputs'] as object)).toEqual(['chat', 'chat-2']);
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
    fireEvent.keyDown(screen.getByLabelText('name of event done'), { key: 'Enter' });
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

  it('offers every namespace and plugin to a new input, none picked, and takes one typed', () => {
    let config: Record<string, unknown> = {};
    const other: PluginView = {
      ...LOOK_VIEW,
      id: 'other',
      plugin: 'other',
      outputs: {
        events: { type: 'events', namespace: 'arena', types: [], label: 'events of arena' },
      },
      interface: { reads: [{ name: 'score' }], actions: [], commands: [] },
    } as unknown as PluginView;
    const view = () => (
      <ScriptPorts
        id="look"
        edges={[]}
        config={config}
        change={(c) => (config = c)}
        plugins={[parser, LOOK_VIEW, other]}
        errors={{}}
      />
    );
    const { rerender } = render(view());
    fireEvent.click(screen.getByRole('button', { name: '+ events input' }));
    rerender(view());
    fireEvent.click(screen.getByRole('button', { name: '+ interface input' }));
    rerender(view());
    const choices = (label: string) =>
      [...(screen.getByLabelText(label) as HTMLSelectElement).options].map((o) => o.textContent);
    const namespace = screen.getByLabelText('namespace of events') as HTMLSelectElement;
    expect(namespace.value).toBe('');
    expect(choices('namespace of events')).toEqual([
      'pick a namespace',
      'arena',
      'game',
      'look',
      'other…',
    ]);
    expect(choices('plugin of interface')).toEqual(['any plugin', 'other', 'parser', 'other…']);
    // One picked; then one no plugin offers yet, typed.
    fireEvent.change(namespace, { target: { value: 'look' } });
    rerender(view());
    expect((config['inputs'] as Record<string, unknown>)['events']).toEqual({
      type: 'events',
      namespace: 'look',
    });
    expect(screen.queryByLabelText('namespace of events, typed')).toBeNull();
    fireEvent.change(namespace, { target: { value: '\u0000other' } });
    rerender(view());
    fireEvent.change(screen.getByLabelText('namespace of events, typed'), {
      target: { value: 'dungeon' },
    });
    rerender(view());
    expect((config['inputs'] as Record<string, unknown>)['events']).toEqual({
      type: 'events',
      namespace: 'dungeon',
    });
    // Picked again from the list, the text box goes.
    fireEvent.change(namespace, { target: { value: 'arena' } });
    rerender(view());
    expect(screen.queryByLabelText('namespace of events, typed')).toBeNull();
  });

  it('keeps the focus in a port’s name, and in a namespace typed, while the owner types', () => {
    let config: Record<string, unknown> = { ...CONFIG };
    const view = () => (
      <ScriptPorts
        id="look"
        edges={[]}
        config={config}
        change={(c) => (config = c)}
        plugins={[parser, LOOK_VIEW]}
        errors={{}}
      />
    );
    const { rerender } = render(view());
    const typeInto = (field: HTMLInputElement, text: string): void => {
      field.focus();
      for (const ch of text) {
        fireEvent.change(field, { target: { value: field.value + ch } });
        rerender(view());
        expect(document.activeElement).toBe(field);
        expect(field.isConnected).toBe(true);
      }
    };
    const name = screen.getByLabelText('port of events input game-events') as HTMLInputElement;
    typeInto(name, '-new');
    expect(name.value).toBe('game-events-new');
    // Enter renames it: the same row, the same field, focused still.
    fireEvent.keyDown(name, { key: 'Enter' });
    rerender(view());
    expect(Object.keys(config['inputs'] as object)).toEqual(['game-events-new', 'board']);
    expect(screen.getByLabelText('port of events input game-events-new')).toBe(name);
    expect(document.activeElement).toBe(name);
    // A namespace typed, one not offered, stays in its text box even once it reads as one offered.
    config = { inputs: { heard: { type: 'events', namespace: 'gam' } } };
    rerender(view());
    const typed = screen.getByLabelText('namespace of heard, typed') as HTMLInputElement;
    typeInto(typed, 'e-x');
    expect(config['inputs']).toEqual({ heard: { type: 'events', namespace: 'game-x' } });
  });

  it('starts from nothing when no plugin offers anything', () => {
    let config: Record<string, unknown> = {};
    render(
      <ScriptPorts
        id="look"
        edges={[]}
        config={{}}
        change={(c) => (config = c)}
        plugins={[]}
        errors={{}}
      />
    );
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
    // Every key typed in it is the editor's: none taken by the map's keys (Space to pan, Shift,
    // Ctrl or Cmd to select). Monaco types in an element that is not a text field, as this one.
    const typing = dialog.querySelector('.script-body') as HTMLElement;
    for (const [key, keyCode] of [
      [' ', 'Space'],
      ['Shift', 'ShiftLeft'],
      ['Control', 'ControlLeft'],
      ['Meta', 'MetaLeft'],
      ['Delete', 'Delete'],
      ['Backspace', 'Backspace'],
      ['ArrowLeft', 'ArrowLeft'],
      ['Enter', 'Enter'],
    ] as const) {
      const down = new KeyboardEvent('keydown', {
        key,
        code: keyCode,
        bubbles: true,
        cancelable: true,
      });
      typing.dispatchEvent(down);
      expect(down.defaultPrevented, key).toBe(false);
      typing.dispatchEvent(new KeyboardEvent('keyup', { key, code: keyCode, bubbles: true }));
    }
    expect(screen.getByLabelText('node look')).toBeDefined();
    // Escape is Monaco's while it uses it (a suggestion open), and asks first once code changed.
    const used = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    typing.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    typing.dispatchEvent(used);
    expect(screen.getByRole('dialog', { name: 'script of look' })).toBe(dialog);
    fireEvent.change(code, { target: { value: "on('game.win', () => log('again'));" } });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(confirm).toHaveBeenCalledWith('Discard the changes to this script?');
    expect(screen.getByRole('dialog', { name: 'script of look' })).toBe(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'script of look' })).toBeNull()
    );
    await waitFor(() =>
      expect(checked.at(-1)?.nodes.find((n) => n.id === 'look')?.config?.['code']).toBe(
        "on('game.win', () => log('again'));"
      )
    );
    // Exported as a plugin (D79): its file and its module.json, downloaded or copied.
    fireEvent.click(within(panel).getByRole('button', { name: 'Export as plugin' }));
    const exported = await screen.findByRole('dialog', { name: 'export of look' });
    const plugin = within(exported).getByRole('region', { name: 'look.ts' });
    expect(plugin.textContent).toContain('id: "look"');
    expect(plugin.textContent).toContain("on('game.win', () => log('again'));");
    expect(within(exported).getByRole('region', { name: 'module.json' }).textContent).toContain(
      '"provides": "@example/look"'
    );
    const urls: unknown[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (b: unknown) => (urls.push(b), 'blob:x'),
        revokeObjectURL: () => {},
      })
    );
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t: string) => (copied.push(t), Promise.resolve()) },
      configurable: true,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(within(plugin).getByRole('button', { name: 'Download look.ts' }));
    fireEvent.click(within(plugin).getByRole('button', { name: 'Copy' }));
    expect(urls).toHaveLength(1);
    expect(click).toHaveBeenCalled();
    expect(copied[0]).toContain('definePlugin');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'export of look' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Export as plugin' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'export of look' })).getByRole('button', {
        name: 'Close',
      })
    );
    expect(screen.queryByRole('dialog', { name: 'export of look' })).toBeNull();
    expect(status).toBeDefined();
  });

  it('takes an edge dropped on it from an output it has no input for, adding one (D80)', async () => {
    const graph: Graph = {
      version: 2,
      nodes: [
        { id: 'parser', plugin: 'parser' },
        { id: 'look', plugin: 'script', config: { inputs: {} } },
      ],
      edges: [],
    };
    const core = fakeCore({
      file: graph,
      available: [
        ...AVAILABLE,
        { ...SCRIPT, configInputs: { key: 'inputs', types: ['events', 'interface'] } },
      ],
      status: { off: false, plugins: [] },
    });
    core.running = graph;
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    const look = await screen.findByLabelText('node look', {}, { timeout: 5000 });
    const parserCard = screen.getByLabelText('node parser');
    const handle = within(parserCard).getByTestId('port out interface');
    // Dragged from the parser's interface output, dropped on the script's card, not a port.
    const at = { clientX: 400, clientY: 300 };
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(look);
    fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, at);
    fireEvent.mouseUp(document, at);
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes.find((n) => n.id === 'look')?.config).toEqual({
        inputs: { parser: { type: 'interface', plugin: 'parser', members: [] } },
      })
    );
    expect(core.checked.at(-1)?.edges).toEqual([
      { from: 'parser.interface', to: 'look.parser', type: 'interface' },
    ]);
    expect(screen.getByRole('status').textContent).toBe(
      'look: input parser added to its inputs for parser.interface: pick the members it uses in its panel'
    );
    // An events input of the namespace it has takes the edge; dropped elsewhere, nothing.
    core.file = {
      ...graph,
      nodes: [
        { id: 'parser', plugin: 'parser' },
        {
          id: 'look',
          plugin: 'script',
          config: { inputs: { g: { type: 'events', namespace: 'game' } } },
        },
      ],
    };
    cleanup();
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    await screen.findByLabelText('node look', {}, { timeout: 5000 });
    const drag = (): void => {
      const events = within(screen.getByLabelText('node parser')).getByTestId('port out events');
      fireEvent.mouseDown(events, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(document, at);
      fireEvent.mouseUp(document, at);
    };
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null);
    drag();
    expect(screen.queryByRole('status')).toBeNull();
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(screen.getByLabelText('node look'));
    drag();
    expect((await screen.findByRole('status')).textContent).toBe('parser.events bound to look.g');
    await waitFor(() =>
      expect(core.checked.at(-1)?.edges).toEqual([
        { from: 'parser.events', to: 'look.g', type: 'events' },
      ])
    );
  });

  it('moves the edges of a port renamed in its panel, in the same change', async () => {
    const graph: Graph = {
      version: 2,
      nodes: [
        { id: 'parser', plugin: 'parser' },
        { id: 'look', plugin: 'script', config: CONFIG },
        { id: 'chat', plugin: 'chat', config: { host: 'example.test' } },
      ],
      edges: [
        { from: 'parser.events', to: 'look.game-events', type: 'events' },
        { from: 'look.chat', to: 'chat.chat', type: 'chat-out', commands: ['/look'] },
      ],
    };
    const core = fakeCore({
      file: graph,
      available: [...AVAILABLE, SCRIPT],
      status: { off: false, plugins: [] },
    });
    core.running = graph;
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node look', {}, { timeout: 5000 }));
    const panel = await screen.findByLabelText('details of look');
    const rename = (label: string, to: string): void => {
      const field = within(panel).getByLabelText(label);
      fireEvent.change(field, { target: { value: to } });
      fireEvent.keyDown(field, { key: 'Enter' });
    };
    rename('port of events input game-events', 'heard');
    rename('port of chat-out output chat', 'say');
    await waitFor(() =>
      expect(core.checked.at(-1)?.edges).toEqual([
        { from: 'parser.events', to: 'look.heard', type: 'events' },
        { from: 'look.say', to: 'chat.chat', type: 'chat-out', commands: ['/look'] },
      ])
    );
    const look = core.checked.at(-1)?.nodes.find((n) => n.id === 'look')?.config;
    expect(Object.keys(look?.['inputs'] as object)).toEqual(['heard', 'board']);
    expect(Object.keys(look?.['outputs'] as object)).toEqual(['say']);
  });
  it('removes a port in its panel with its edges, in the same change, once asked (D84)', async () => {
    const graph: Graph = {
      version: 2,
      nodes: [
        { id: 'parser', plugin: 'parser' },
        { id: 'look', plugin: 'script', config: CONFIG },
        { id: 'chat', plugin: 'chat', config: { host: 'example.test' } },
      ],
      edges: [
        { from: 'parser.events', to: 'look.game-events', type: 'events' },
        { from: 'parser.interface', to: 'look.board', type: 'interface' },
        { from: 'look.chat', to: 'chat.chat', type: 'chat-out', commands: ['/look'] },
      ],
    };
    const core = fakeCore({
      file: graph,
      available: [...AVAILABLE, SCRIPT],
      status: { off: false, plugins: [] },
    });
    core.running = graph;
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node look', {}, { timeout: 5000 }));
    const panel = await screen.findByLabelText('details of look');
    const remove = within(panel).getByRole('button', { name: 'remove interface input board' });
    expect(remove.textContent).toBe('Remove');
    expect(remove.title).toBe('Remove interface input board and its edge (parser.interface)');
    // Asked first, as it has an edge: refused, nothing changes.
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    fireEvent.click(remove);
    expect(confirm).toHaveBeenCalledWith(
      'Remove interface input board? Its edge goes with it: parser.interface.'
    );
    expect(within(panel).queryByRole('group', { name: 'interface input board' })).not.toBeNull();
    vi.stubGlobal('confirm', () => true);
    fireEvent.click(remove);
    fireEvent.click(within(panel).getByRole('button', { name: 'remove chat-out output chat' }));
    await waitFor(() =>
      expect(core.checked.at(-1)?.edges).toEqual([
        { from: 'parser.events', to: 'look.game-events', type: 'events' },
      ])
    );
    const look = core.checked.at(-1)?.nodes.find((n) => n.id === 'look')?.config;
    expect(Object.keys(look?.['inputs'] as object)).toEqual(['game-events']);
    expect(look?.['outputs']).toEqual({});
    // A port with no edge goes at once, unasked; one of the same name later is a new row.
    const asked = vi.fn(() => true);
    vi.stubGlobal('confirm', asked);
    fireEvent.click(within(panel).getByRole('button', { name: '+ interface input' }));
    fireEvent.click(
      await within(panel).findByRole('button', { name: 'remove interface input interface' })
    );
    expect(asked).not.toHaveBeenCalled();
  });

  it('asks which input takes an edge dropped on it when several would (D84)', async () => {
    const graph: Graph = {
      version: 2,
      nodes: [
        { id: 'parser', plugin: 'parser' },
        {
          id: 'look',
          plugin: 'script',
          config: {
            inputs: {
              moves: { type: 'events', namespace: 'game' },
              wins: { type: 'events', namespace: 'game' },
            },
          },
        },
      ],
      edges: [],
    };
    const core = fakeCore({
      file: graph,
      available: [
        ...AVAILABLE,
        { ...SCRIPT, configInputs: { key: 'inputs', types: ['events', 'interface'] } },
      ],
      status: { off: false, plugins: [] },
    });
    core.running = graph;
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    const look = await screen.findByLabelText('node look', {}, { timeout: 5000 });
    const handle = within(screen.getByLabelText('node parser')).getByTestId('port out events');
    const at = { clientX: 400, clientY: 300 };
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(look);
    fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, at);
    fireEvent.mouseUp(document, at);
    expect((await screen.findByRole('status')).textContent).toBe(
      'look has several inputs that take parser.events: moves, wins; drop it on the port of one'
    );
    expect(core.checked.at(-1)?.edges ?? []).toEqual([]);
  });
});
