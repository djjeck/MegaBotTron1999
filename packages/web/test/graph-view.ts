/**
 * A made-up instance for the graph view's tests, as `GET /graph/view`, `GET /status` and
 * `GET /drift` give it: a chat connector, a parser of a game, and an actor bound to both.
 */
import {
  type AvailablePlugin,
  type DriftCounts,
  type GraphViewData,
  type PluginControl,
  type Status,
} from '#src/ui/api.ts';

const PORT_TYPES: GraphViewData['portTypes'] = {
  chat: { id: 'chat', description: 'a chat', shape: 'circle', colour: '#2f7ed8' },
  events: { id: 'events', description: 'events', shape: 'diamond', colour: '#d97b29' },
  interface: { id: 'interface', description: 'an interface', shape: 'square', colour: '#3a9a5b' },
};

const none = { reads: [], actions: [], commands: [] };
const declares = { secrets: [], configSecrets: [], events: [] };

export const VIEW: GraphViewData = {
  portTypes: PORT_TYPES,
  graph: {
    version: 1,
    nodes: [
      { id: 'chat', plugin: 'chat', config: { host: 'example.test' } },
      { id: 'parser', plugin: 'parser' },
      { id: 'actor-a', plugin: 'actor' },
    ],
    edges: [
      { from: 'chat.chat', to: 'actor-a.chat', type: 'chat', reads: ['#a'], sends: ['#a'] },
      { from: 'parser.events', to: 'actor-a.game-events', type: 'events' },
      { from: 'parser.interface', to: 'actor-a.parser', type: 'interface' },
    ],
  },
  nodes: [
    {
      id: 'chat',
      plugin: 'chat',
      version: '1.0.0',
      description: 'a chat network',
      kinds: ['connector'],
      account: 'chat:me',
      config: { host: 'example.test' },
      configSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'the server' },
          port: { type: 'integer', default: 6667 },
          tls: { type: 'boolean', default: true },
          flavour: { type: 'string', enum: ['plain', 'fancy'] },
          channels: { type: 'array', items: { type: 'string' }, default: ['#a'] },
          note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          limits: {
            type: 'object',
            description: 'how fast it sends',
            properties: { burst: { type: 'number', default: 3 } },
          },
        },
        required: ['host'],
      },
      inputs: {},
      outputs: { chat: { type: 'chat', network: 'chat', label: 'chat of chat', optional: false } },
      interface: none,
      secrets: ['chat_password'],
      configSecrets: ['token'],
      events: [],
    },
    {
      id: 'parser',
      plugin: 'parser',
      version: '0.1.0',
      description: 'reads the game',
      kinds: ['parser'],
      inputs: {},
      outputs: {
        events: { type: 'events', namespace: 'game', label: 'events of game', optional: false },
        interface: {
          type: 'interface',
          plugin: 'parser',
          members: ['state.board'],
          label: 'interface of parser',
          optional: false,
        },
      },
      interface: {
        reads: [{ name: 'board', help: 'the board', output: { type: 'array' } }],
        actions: [],
        commands: [],
      },
      ...declares,
      events: ['game.message', 'game.win'],
    },
    {
      id: 'actor-a',
      plugin: 'actor',
      version: '0.2.0',
      description: 'plays the game',
      kinds: ['actor'],
      settingsSchema: {
        type: 'object',
        properties: { loud: { type: 'boolean', default: false }, level: { type: 'number' } },
      },
      inputs: {
        chat: { type: 'chat', label: 'chat of any network', optional: false },
        parser: {
          type: 'interface',
          plugin: 'parser',
          members: ['state.board'],
          label: 'interface of parser',
          optional: false,
        },
        'game-events': {
          type: 'events',
          namespace: 'game',
          label: 'events of game',
          optional: true,
          help: 'what happens',
        },
      },
      outputs: {},
      interface: {
        reads: [{ name: 'status', help: 'how it is', output: { type: 'object' } }],
        actions: [
          {
            name: 'bump',
            help: 'counts up',
            input: { type: 'object', properties: { by: { type: 'integer' } }, required: ['by'] },
          },
          { name: 'stay', help: 'stays', input: { type: 'object' } },
        ],
        commands: [{ name: 'poke', help: 'pokes it', args: '<who>', owner: true }],
      },
      ...declares,
    },
  ],
};

/** The chat connector's config schema has a key that names a secret. */
const chatSchema = VIEW.nodes[0]?.configSchema as { properties: Record<string, unknown> };
chatSchema.properties['token'] = { type: 'string', description: 'the secret it logs in with' };

/** The plugins the instance offers, as `GET /available` gives them: the chat from the image, the game's from a module. */
export const AVAILABLE: AvailablePlugin[] = VIEW.nodes.map(({ id: _, config: __, ...p }) => ({
  ...p,
  id: p.plugin,
  ...(p.plugin === 'chat' ? {} : { module: 'game' }),
}));

const plugin = (id: string, more: Partial<PluginControl> = {}): PluginControl => ({
  id,
  plugin: id,
  description: id,
  kinds: [],
  state: 'running',
  settings: {},
  reads: [],
  actions: [],
  ...more,
});

/** The status, with the actor killed or not. */
export const status = (killed = false, off = false): Status => ({
  off,
  plugins: [
    plugin('chat'),
    plugin('parser'),
    plugin('actor-a', {
      plugin: 'actor',
      mode: 'dry-run',
      settings: { 'actor-a.loud': true, level: 2 },
      ...(killed ? { state: 'paused', reason: 'killed by the owner', killed: true } : {}),
    }),
  ],
});

export const DRIFT: DriftCounts[] = [
  { parser: 'parser', read: 10, unread: 2, recent: 1, tripped: false },
];
