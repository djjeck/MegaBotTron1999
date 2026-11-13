import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ManifestError, parseManifest } from './manifest.ts';

const base = { id: 'test-plugin', version: '0.1.0', kinds: ['stats'], description: 'a test' };

describe('parseManifest', () => {
  it('fills in the defaults', () => {
    expect(parseManifest(base)).toEqual({
      ...base,
      archived: false,
      inputs: {},
      outputs: { interface: { type: 'interface', plugin: 'test-plugin', members: [] } },
      games: { registers: [] },
      events: {},
      secrets: [],
      configSecrets: [],
      audit: [],
      state: { migrations: [] },
      interface: {},
    });
  });

  it('reads the shorthand as input ports, in the order of requires, and derives the outputs', () => {
    const m = parseManifest({
      ...base,
      kinds: ['connector', 'actor'],
      account: 'irc:alice',
      requires: ['game', 'irc', 'extra'],
      uses: { game: ['state.game'], loose: ['actions.go'], irc: ['state.status'] },
      reach: [
        { connector: 'irc', reads: ['#lobby'], sends: ['#lobby'], commands: ['!roll'] },
        { connector: 'tg', sends: ['-100'] },
      ],
      games: { registers: ['one', 'two'], consumes: ['game'] },
      interface: {
        state: { s: { help: 'a read', output: z.number() } },
        actions: { a: { help: 'an action', input: z.number() } },
      },
      inputs: {
        // Declared ports keep their names; the shorthand's take the next free one.
        extra: { type: 'events', namespace: 'other', optional: true },
        own: { type: 'interface', plugin: 'test-plugin', bind: { node: 'base' } },
      },
    });
    expect(m.inputs).toEqual({
      game: { type: 'interface', plugin: 'game', members: ['state.game'], optional: false },
      // The shorthand's chat, read as a chat-in input (and a chat-out output, below).
      irc: { type: 'chat-in', optional: false, bind: { node: 'irc', reads: ['#lobby'] } },
      'irc-2': { type: 'interface', plugin: 'irc', members: ['state.status'], optional: false },
      'extra-2': { type: 'interface', plugin: 'extra', members: [], optional: false },
      loose: { type: 'interface', plugin: 'loose', members: ['actions.go'], optional: false },
      tg: { type: 'chat-in', optional: true, bind: { node: 'tg', reads: [] } },
      'game-events': { type: 'events', namespace: 'game', optional: true },
      extra: { type: 'events', namespace: 'other', optional: true },
      own: {
        type: 'interface',
        plugin: 'test-plugin',
        members: [],
        optional: false,
        bind: { node: 'base' },
      },
      // A connector's own: what the plugins send through its account.
      chat: {
        type: 'chat-out',
        network: 'irc',
        optional: true,
        help: 'What the plugins send through its account',
      },
    });
    expect(m.outputs).toEqual({
      chat: { type: 'chat-in', network: 'irc' },
      irc: {
        type: 'chat-out',
        optional: false,
        bind: { node: 'irc', sends: ['#lobby'], commands: ['!roll'] },
      },
      tg: { type: 'chat-out', optional: true, bind: { node: 'tg', sends: ['-100'] } },
      'one-events': { type: 'events', namespace: 'one' },
      'two-events': { type: 'events', namespace: 'two' },
      interface: { type: 'interface', plugin: 'test-plugin', members: ['state.s', 'actions.a'] },
    });
    expect(() =>
      parseManifest({ ...base, inputs: { self: { type: 'interface', plugin: 'test-plugin' } } })
    ).toThrow(/inputs\.self: an input of its own interface needs a bind/u);
    expect(() =>
      parseManifest({ ...base, inputs: { Bad: { type: 'events', namespace: 'x' } } })
    ).toThrow(/inputs\.Bad/u);
  });

  it('reads chat-in inputs and chat-out outputs, and the old chat input as both', () => {
    const m = parseManifest({
      ...base,
      config: z.object({ match: z.string().optional() }),
      inputs: {
        heard: { type: 'chat-in', network: 'irc', when: { config: 'match' } },
        old: {
          type: 'chat',
          network: 'irc',
          help: 'module API 1',
          bind: { node: 'irc', reads: ['#a'], sends: ['#b'], commands: ['!go'] },
        },
      },
      outputs: {
        said: { type: 'chat-out', bind: { node: 'irc', sends: ['#a'] } },
        // Declared, it takes the place of the old input's half of that name.
        old: { type: 'chat-out', network: 'irc', optional: true },
      },
    });
    expect(m.inputs).toEqual({
      heard: { type: 'chat-in', network: 'irc', when: { config: 'match' }, optional: false },
      old: {
        type: 'chat-in',
        network: 'irc',
        help: 'module API 1',
        optional: false,
        bind: { node: 'irc', reads: ['#a'] },
      },
    });
    expect(m.outputs).toMatchObject({
      said: { type: 'chat-out', optional: false, bind: { node: 'irc', sends: ['#a'] } },
      old: { type: 'chat-out', network: 'irc', optional: true },
    });
    const legacy = parseManifest({
      ...base,
      inputs: { old: { type: 'chat', bind: { node: 'irc', reads: [], sends: ['#b'] } } },
    });
    expect(legacy.outputs['old']).toEqual({
      type: 'chat-out',
      optional: false,
      bind: { node: 'irc', sends: ['#b'] },
    });
    expect(() =>
      parseManifest({ ...base, inputs: { x: { type: 'chat-in', when: { config: 'nope' } } } })
    ).toThrow(/inputs\.x\.when: its config has no key nope/u);
    expect(() => parseManifest({ ...base, outputs: { interface: { type: 'chat-out' } } })).toThrow(
      /outputs\.interface: the output interface is derived/u
    );
    expect(() => parseManifest({ ...base, inputs: { interface: { type: 'chat' } } })).toThrow(
      /inputs\.interface: the output interface is derived/u
    );
    expect(() => parseManifest({ ...base, outputs: { x: { type: 'events' } } })).toThrow(
      /outputs\.x/u
    );
  });

  it('takes a full manifest', () => {
    const m = parseManifest({
      ...base,
      kinds: ['connector', 'parser'],
      account: 'irc:alice',
      secrets: ['znc_password'],
      requires: ['other'],
      games: { registers: ['dice'], consumes: ['dice'] },
      events: { 'dice.message': z.object({ text: z.string() }) },
      reach: [{ connector: 'irc', reads: ['#lobby'], sends: ['#lobby'], commands: ['!roll'] }],
      settings: z.object({ on: z.boolean().default(false) }),
      interface: {
        commands: { status: { help: 'the status' } },
        actions: { setOn: { help: 'switch it', input: z.boolean() } },
        state: { summary: { help: 'a line', output: z.string() } },
      },
    });
    expect(m.account).toBe('irc:alice');
    expect(Object.keys(m.events)).toEqual(['dice.message']);
  });

  it('names the plugin and every field wrong', () => {
    expect(() => parseManifest({ ...base, version: 'one', kinds: ['robot'] })).toThrow(
      /^plugin test-plugin: bad manifest: version: expected a semver version; kinds\.0: /u
    );
    expect(() => parseManifest({ version: '1.0.0' })).toThrow(/^plugin \(no id\): bad manifest/u);
    expect(() => parseManifest(null)).toThrow(ManifestError);
    expect(() => parseManifest({ ...base, extra: 1 })).toThrow(/extra/u);
  });

  it('keeps secrets for connectors, and accounts too', () => {
    expect(() => parseManifest({ ...base, secrets: ['token'] })).toThrow(
      /secrets: only a connector may hold secrets/u
    );
    expect(() => parseManifest({ ...base, kinds: ['connector'] })).toThrow(
      /account: a connector names its account/u
    );
    expect(() => parseManifest({ ...base, account: 'irc:alice' })).toThrow(
      /account: only a connector has an account/u
    );
    expect(() => parseManifest({ ...base, secrets: ['Bad-Name'] })).toThrow(/Docker secret name/u);
  });

  it('refuses the core id, a self requirement and events outside the namespaces registered', () => {
    expect(() => parseManifest({ ...base, id: 'core' })).toThrow(/reserved/u);
    expect(() => parseManifest({ ...base, requires: ['test-plugin'] })).toThrow(/itself/u);
    expect(() => parseManifest({ ...base, events: { 'dice.message': z.object({}) } })).toThrow(
      /events\.dice\.message: namespace dice is not among games\.registers/u
    );
    expect(() => parseManifest({ ...base, games: { registers: ['core'] } })).toThrow(/core/u);
    expect(() => parseManifest({ ...base, events: { 'no-dot': z.object({}) } })).toThrow(
      /events\.no-dot: Invalid key/u
    );
    expect(() => parseManifest({ ...base, settings: { on: true } })).toThrow(/zod object/u);
  });
});
