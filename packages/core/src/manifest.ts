/**
 * The manifest of a plugin (docs/bot-os-api.md §2): what it is, what it needs, and everything it
 * offers or reaches, validated with zod when the instance starts. A bad manifest names the plugin
 * and the field, and the instance does not start: it is a mistake in the image, best seen at once.
 */
import { z } from 'zod';
import { answerSchema } from './answers.ts';
import {
  COMMANDS_PORT,
  type DeclaredInput,
  type DeclaredOutput,
  inputSchema,
  type ManifestInputPort,
  type OutputPort,
  outputSchema,
  PORT_NAME,
} from './ports.ts';
import { pageSchema, widgetIssues, widgetSchema } from './widgets.ts';

export const KINDS = ['connector', 'parser', 'actor', 'stats', 'agent', 'simulator'] as const;
export type Kind = (typeof KINDS)[number];

/** A plugin's id: lower-case words and dashes; `core` is the core's. */
export const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
/** A namespace of event types: a game's, or a plugin's own id. */
const NAMESPACE = PLUGIN_ID;
/** An event type: `<namespace>.<name>`, as `dice.message`. */
export const EVENT_TYPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][A-Za-z0-9]*$/u;
/** An account: `<network>:<name>`, as `irc:alice`. */
export const ACCOUNT_ID = /^[a-z][a-z0-9-]*:[^\s:]+$/u;
/** A secret's name, as Docker names its file under /run/secrets. */
export const SECRET_NAME = /^[a-z][a-z0-9_]*$/u;

const schema = z.custom<z.ZodType>((v) => v instanceof z.ZodType, 'expected a zod schema');
const objectSchema = z.custom<z.ZodObject>(
  (v) => v instanceof z.ZodObject,
  'expected a zod object schema'
);
const fn = z.custom<(...args: never[]) => unknown>(
  (v) => typeof v === 'function',
  'expected a function'
);
const name = z.string().regex(/^[a-z][A-Za-z0-9_]*$/u, 'expected a name such as fooBar');
/** A node's own manifest, from its config and its id (`node`, bot-os.md D74). */
export type NodeManifest = (config: Readonly<Record<string, unknown>>, id: string) => unknown;
const nodeFn = z.custom<NodeManifest>((v) => typeof v === 'function', 'expected a function');
/** What a node's config makes it do that its owner may not mean (`warns`, bot-os.md D138). */
export type ConfigWarnings = (config: Readonly<Record<string, unknown>>) => string[];
const warnsFn = z.custom<ConfigWarnings>((v) => typeof v === 'function', 'expected a function');

/** A command, by its first word: `/play`. */
const BOT_COMMAND = /^\/\w+$/u;
const botCommandName = z.string().regex(BOT_COMMAND, 'expected a command, as /play');

/**
 * A command of a game bot, as its readiness state declares it (bot-os.md D132, D137, D140, D141): a
 * turn (`turn`: its readiness the bot's rest), or another with its mechanics, in generic terms; by
 * its name, with the other names the bot takes it by (`aliases`), one command whichever is sent.
 */
const botCommandSchema = z.strictObject({
  command: botCommandName,
  /** Its other names, in the order its parser declares them (D140): never addressed (`/x@Bot`). */
  aliases: z.array(botCommandName).optional(),
  /** The bot's turn, whose readiness is the bot's rest. */
  turn: z.literal(true).optional(),
  /** Held for so many minutes after a success. */
  cooldownMin: z.number().positive().optional(),
  /** Ready only once a message of the bot announces it (`pattern`), for `forMin` minutes. */
  unlock: z
    .strictObject({
      pattern: z.string().optional(),
      forMin: z.number().positive().optional(),
    })
    .optional(),
  /** What its success does to another command's hold: ends it, or shortens it. */
  effects: z
    .array(
      z.strictObject({
        command: botCommandName,
        clear: z.literal(true).optional(),
        shortenMin: z.number().positive().optional(),
      })
    )
    .optional(),
  /** It needs the person to answer or choose (a minigame, a shop): never played blindly. */
  interactive: z.literal(true).optional(),
});
/** A command of a game bot, with its mechanics, as its parser declares it (D137). */
export type BotCommand = z.output<typeof botCommandSchema>;

export const manifestSchema = z
  .strictObject({
    id: z
      .string()
      .regex(PLUGIN_ID, 'expected lower-case words and dashes')
      .refine((id) => id !== 'core', '`core` is reserved for the core'),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u, 'expected a semver version'),
    kinds: z.array(z.enum(KINDS)).min(1),
    description: z.string().min(1),
    /**
     * An archive (bot-os.md D32): kept in the repository, built and tested, but refused in every
     * instance's graph; only a run that says `allowArchived` (a test, the dev kit, a manual-test
     * tool) runs it.
     */
    archived: z.boolean().default(false),
    /**
     * Its input ports, by name (§2.1): what it consumes, each of a port type, with the binding the
     * programmatic wiring gives it by default.
     */
    inputs: z
      .record(z.string().regex(PORT_NAME, 'expected lower-case words and dashes'), inputSchema)
      .default({}),
    /**
     * Its declared output ports, by name (§2.1): its chat-outs, what it sends through a connector's
     * account, each with the binding the programmatic wiring gives it by default. Its other
     * outputs (a connector's chat-in, its events, its interface) are derived.
     */
    outputs: z
      .record(z.string().regex(PORT_NAME, 'expected lower-case words and dashes'), outputSchema)
      .default({}),
    /** Shorthand (§2.1): the plugins it needs started first, by id, read as input ports. */
    requires: z.array(z.string().regex(PLUGIN_ID)).default([]),
    games: z
      .strictObject({
        registers: z.array(z.string().regex(NAMESPACE)).default([]),
        consumes: z.array(z.string().regex(NAMESPACE)).default([]),
      })
      .default({ registers: [], consumes: [] }),
    events: z
      .record(z.string().regex(EVENT_TYPE, 'expected <namespace>.<name>'), schema)
      .default({}),
    /**
     * A parser's: which of its own events answer which commands (bot-os.md D98, #59), the first
     * that matches an event its answer; a node's send of one of them to a chat it reads waits for
     * that answer (`answers.ts`, docs/bot-os-api.md §4.6).
     */
    answers: z.array(answerSchema).default([]),
    uses: z.record(z.string().regex(PLUGIN_ID), z.array(z.string().min(1))).default({}),
    config: objectSchema.optional(),
    settings: objectSchema.optional(),
    secrets: z.array(z.string().regex(SECRET_NAME, 'expected a Docker secret name')).default([]),
    /**
     * The keys of its `config` whose values name a secret (docs/bot-os-api.md §4.9): a connector
     * that several nodes run, each with a credential of its own that its node's config names.
     */
    configSecrets: z.array(z.string().min(1)).default([]),
    /**
     * The keys of its `config` whose values are sensitive (docs/bot-os-api.md §2.1, bot-os.md
     * D124): sealed in the graph's file and its history under `bot_os_key`, opened for the running
     * node only, never shown back (the editor writes them, and says whether they are set).
     */
    configSensitive: z.array(z.string().min(1)).default([]),
    /**
     * A connector that logs in from its node (docs/bot-os-api.md §4.5, bot-os.md D116): its
     * instance offers a `login` and keeps the credentials in its store, not in Docker secrets
     * (D118); without them it runs, needing a login.
     */
    login: z.boolean().default(false),
    /**
     * A connector to a model that bills by the call (docs/bot-os-api.md §4.5, bot-os.md D117): it
     * spends money, so the editor marks its node with a `$`, and it logs each call with its cost.
     */
    model: z.boolean().default(false),
    /**
     * Whether a connector's account has a chat (docs/bot-os-api.md §2.1, bot-os.md D148): by
     * default, it reads and sends, and has a chat-in output and a chat-out input, both `chat`. A
     * service connector (an API's account, as `anthropic`) says `false`: it reads and sends
     * nothing, has neither, and offers what it makes through its interface alone.
     */
    chat: z.boolean().default(true),
    /**
     * The steps that bring its store from each older version to the next (docs/bot-os-api.md §4.2):
     * the store's version is the number of them.
     */
    state: z.strictObject({ migrations: z.array(fn).default([]) }).default({ migrations: [] }),
    /**
     * A parser's threshold of unrecoverable drift (docs/bot-os-api.md §4.7): more than `unreadAt`
     * unread messages within `windowMin` minutes; by default 5 in 15 (bot-os.md D21).
     */
    drift: z
      .strictObject({
        unreadAt: z.number().int().min(0),
        windowMin: z.number().int().min(1),
      })
      .optional(),
    /** A connector's account (docs/bot-os-api.md §4.5). */
    account: z.string().regex(ACCOUNT_ID, 'expected <network>:<name>').optional(),
    /**
     * Each node's own manifest (bot-os.md D74), for a plugin whose ports its node's config declares
     * (a script node): called with the node's config, as its schema makes it (as written when the
     * schema refuses it), and the node's id; what it returns is the node's manifest, checked as
     * any, of the same id. Its ports, kinds, registered namespaces and event types are the node's
     * everywhere: the check, the edges, the bus, the drift, the queue and the editor.
     */
    node: nodeFn.optional(),
    /**
     * What a node's config makes it do that its owner may not mean (bot-os.md D138): called with
     * the node's config as written (`{}` without one), each line returned a warning of the check
     * (`node <id>: <line>`), which refuses nothing; the editor shows it on the node.
     */
    warns: warnsFn.optional(),
    /**
     * Where its nodes' own inputs are declared, for a plugin whose ports its node's config declares
     * (`node`, bot-os.md D80): the key of its config that holds them, a record of input ports by
     * name written as a manifest's, and the types of input it takes there. The editor adds one
     * there when the owner drops an edge on such a node from an output it has no input for.
     */
    configInputs: z
      .strictObject({
        key: z.string().min(1),
        types: z.array(z.enum(['events', 'interface'])).min(1),
      })
      .optional(),
    /**
     * A connector's: which chats its node monitors, as its config says (bot-os.md D89), so that the
     * check warns of a chat-in edge that reads a chat its connector does not monitor. `'all'`: every
     * chat it hears; `{ config: key }`: the key of its config that holds the chat (a string) or the
     * chats (a list of strings), unset meaning every chat. Chats compare without case. Undeclared:
     * unknown, and nothing is warned of. `aliases`: a chat may go by several names (an id, a
     * `@username`; D90): the check asks its running connector (`Connector.chatNames`) which, and
     * warns of none it cannot tell.
     */
    monitors: z
      .union([
        z.literal('all'),
        z.strictObject({
          config: z.string().regex(/^[A-Za-z_$][\w$]*$/u, 'expected a config key'),
          aliases: z.literal(true).optional(),
        }),
      ])
      .optional(),
    /**
     * The keys of its `config` that name a chat (bot-os.md D96), so that the editor picks each from
     * its connector's chats rather than have the owner type an id: the connector is its own node (a
     * connector's `owner`), or the one at the other end of its chat-out `output` or chat-in `input`
     * edge. A string, or a list of them, holds the chats as the connector names them (`Surface.id`);
     * a number, a chat by its numeric id. `kinds`: the kinds of chat it takes (a bot's owner is a
     * `private` chat); `template`: a `{path}` template may stand for the chat instead (a reaction's);
     * `owner`: a connector's key that names its account's owner's chat, the one its `owner()` gives
     * (`telegram-bot`'s `owner`), which the editor fills into a new edge from an output that sends
     * there when it names no chat (`owner`, D97). A key with an `output` or an `input` that holds a
     * chat (not a template) is copied by the editor into that edge's `sends` or `reads` as the owner
     * picks it, and replaced there when the pick changes (D97): the edge is what lets it send.
     * `sender`: the key names people it recognises, not chats it sends to or reads (a
     * `telegram-bot`'s `onlyPeople` and `blockPeople`, D128), so the picker says nothing of
     * whether the connector can reach them, and the editor writes them on no edge.
     */
    configChats: z
      .array(
        z.strictObject({
          key: z.string().regex(/^[A-Za-z_$][\w$]*$/u, 'expected a config key'),
          output: z.string().min(1).optional(),
          input: z.string().min(1).optional(),
          kinds: z
            .array(z.enum(['private', 'group', 'channel', 'bot']))
            .min(1)
            .optional(),
          template: z.literal(true).optional(),
          owner: z.literal(true).optional(),
          sender: z.literal(true).optional(),
        })
      )
      .default([]),
    /**
     * A game bot's readiness state's: its bot's commands, in order, the turns first, each with its
     * mechanics (bot-os.md D132, D137, D141), so that the editor knows them without the node
     * running: a player's checklist (`configPlays`) offers them, and says what each will do. Data
     * only: what the state makes of them is its own (`statePlugin`'s `readiness`).
     */
    botCommands: z.array(botCommandSchema).optional(),
    /**
     * A game bot's readiness state's: its bot's username, without `@` (bot-os.md D139, D141), so
     * that the editor can name a command addressed to it (`/play@QuestBot`), as a player in a group
     * may send it.
     */
    botUsername: z.string().regex(/^\w+$/u, 'expected a username, without @').optional(),
    /**
     * A player's (bot-os.md D137, D140): the key of its config that lists the commands it plays
     * (`[{ command, whileHeld?, whenReady?, forms? }]`, unset: the defaults), picked from the
     * `botCommands` of the node its interface `input` binds; and its chat-out `output`, whose edge
     * the editor keeps allowing the forms it may send them as.
     */
    configPlays: z
      .strictObject({
        key: z.string().regex(/^[A-Za-z_$][\w$]*$/u, 'expected a config key'),
        input: z.string().min(1),
        output: z.string().min(1),
      })
      .optional(),
    /**
     * It hears the owner's notices (bot-os.md D91, `ctx.notices`): what the core and the plugins
     * raise for the owner's attention, for a node that tells the owner (`owner-notice`).
     */
    notices: z.boolean().default(false),
    /**
     * It adds lines to the owner's summary, or reads the summary for a node that tells it (bot-os.md
     * D92, `ctx.summary`).
     */
    summary: z.boolean().default(false),
    /**
     * Keys of its config whose every change a save of the graph records in the event log
     * (`core.config`, bot-os.md D75): who saved it, when, and its SHA-256, never its value (a
     * script node's code).
     */
    audit: z.array(z.string().min(1)).default([]),
    interface: z
      .strictObject({
        commands: z.record(
          name,
          z.strictObject({
            help: z.string(),
            args: z.string().optional(),
            /** Other names it answers to, in no menu. */
            aliases: z.array(name).default([]),
            /** Its description in the players' menus, in their language; unlisted without. */
            menu: z.string().min(1).optional(),
            /** The owner's alone: answered to the owner only, in the owner's chat. */
            owner: z.boolean().default(false),
            /** In no menu, the owner's included: a button's action, or typed by hand. */
            hidden: z.boolean().default(false),
          })
        ),
        actions: z.record(
          name,
          z.strictObject({ help: z.string(), input: schema, output: schema.optional() })
        ),
        /** Reads, by name; one may take an input (an object, its fields its arguments). */
        state: z.record(
          name,
          z.strictObject({ help: z.string(), input: schema.optional(), output: schema })
        ),
      })
      .partial()
      .default({}),
    /**
     * Its node's widget (bot-os.md D112, `widgets.ts`): one section, made from one of its reads,
     * that the editor draws in a line on each of its nodes' cards.
     */
    widget: widgetSchema.optional(),
    /**
     * Its node's full page (D112): a title and its sections, made from its reads, for what does
     * not fit on its card, opened from its node's panel.
     */
    page: pageSchema.optional(),
  })
  .superRefine((m, ctx) => {
    const reads = m.interface.state ?? {};
    if (m.widget !== undefined)
      for (const i of widgetIssues(m.widget, reads))
        ctx.addIssue({ code: 'custom', path: ['widget', ...i.path], message: i.message });
    m.page?.sections.forEach((s, n) => {
      for (const i of widgetIssues(s, reads))
        ctx.addIssue({
          code: 'custom',
          path: ['page', 'sections', n, ...i.path],
          message: i.message,
        });
    });
    const connector = m.kinds.includes('connector');
    if (m.secrets.length > 0 && !connector)
      ctx.addIssue({
        code: 'custom',
        path: ['secrets'],
        message: 'only a connector may hold secrets (P9)',
      });
    if (m.login && !connector)
      ctx.addIssue({
        code: 'custom',
        path: ['login'],
        message: 'only a connector logs in (P9)',
      });
    if (m.model && !connector)
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'only a connector reaches a model (bot-os.md D52)',
      });
    if (m.configSecrets.length > 0 && !connector)
      ctx.addIssue({
        code: 'custom',
        path: ['configSecrets'],
        message: 'only a connector may hold secrets (P9)',
      });
    if (!m.chat && !connector)
      ctx.addIssue({
        code: 'custom',
        path: ['chat'],
        message: 'only a connector has a chat to drop (D148)',
      });
    if (!m.chat && m.monitors !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['monitors'],
        message: 'a connector with no chat monitors none (D148)',
      });
    if (!m.chat && Object.values(m.outputs).some((p) => p.type === 'commands'))
      ctx.addIssue({
        code: 'custom',
        path: ['outputs'],
        message: 'a connector with no chat serves no chat commands (D148)',
      });
    if (connector && m.account === undefined)
      ctx.addIssue({ code: 'custom', path: ['account'], message: 'a connector names its account' });
    if (!connector && m.account !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['account'],
        message: 'only a connector has an account',
      });
    if (m.configInputs !== undefined && m.node === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['configInputs'],
        message: 'only a plugin whose nodes make their own manifest (node) declares them',
      });
    if (m.configInputs !== undefined && !Object.hasOwn(m.config?.shape ?? {}, m.configInputs.key))
      ctx.addIssue({
        code: 'custom',
        path: ['configInputs', 'key'],
        message: `its config has no key ${m.configInputs.key}`,
      });
    if (m.monitors !== undefined && !connector)
      ctx.addIssue({
        code: 'custom',
        path: ['monitors'],
        message: 'only a connector monitors chats',
      });
    if (typeof m.monitors === 'object' && !Object.hasOwn(m.config?.shape ?? {}, m.monitors.config))
      ctx.addIssue({
        code: 'custom',
        path: ['monitors', 'config'],
        message: `its config has no key ${m.monitors.config}`,
      });
    for (const [i, c] of m.configChats.entries()) {
      const where = ['configChats', i];
      if (!Object.hasOwn(m.config?.shape ?? {}, c.key))
        ctx.addIssue({
          code: 'custom',
          path: [...where, 'key'],
          message: `its config has no key ${c.key}`,
        });
      if (c.owner === true && (c.output !== undefined || c.input !== undefined))
        ctx.addIssue({
          code: 'custom',
          path: [...where, 'owner'],
          message: "only a connector's own key names its owner's chat",
        });
      if (c.output !== undefined && c.input !== undefined)
        ctx.addIssue({ code: 'custom', path: where, message: 'an output or an input, not both' });
      else if (c.output === undefined && c.input === undefined && !connector)
        ctx.addIssue({
          code: 'custom',
          path: where,
          message:
            'only a connector names its own chats: name the output or input to its connector',
        });
      else if (
        c.output !== undefined &&
        m.node === undefined &&
        m.outputs[c.output]?.type !== 'chat-out'
      )
        ctx.addIssue({
          code: 'custom',
          path: [...where, 'output'],
          message: `it has no chat-out output ${c.output}`,
        });
      else if (
        c.input !== undefined &&
        m.node === undefined &&
        m.inputs[c.input]?.type !== 'chat-in'
      )
        ctx.addIssue({
          code: 'custom',
          path: [...where, 'input'],
          message: `it has no chat-in input ${c.input}`,
        });
    }
    if (m.configPlays !== undefined) {
      const { key, input, output } = m.configPlays;
      if (!Object.hasOwn(m.config?.shape ?? {}, key))
        ctx.addIssue({
          code: 'custom',
          path: ['configPlays', 'key'],
          message: `its config has no key ${key}`,
        });
      if (m.inputs[input]?.type !== 'interface')
        ctx.addIssue({
          code: 'custom',
          path: ['configPlays', 'input'],
          message: `it has no interface input ${input}`,
        });
      if (m.outputs[output]?.type !== 'chat-out')
        ctx.addIssue({
          code: 'custom',
          path: ['configPlays', 'output'],
          message: `it has no chat-out output ${output}`,
        });
    }
    // A name, or an alias (D140), names one command only.
    const names = new Set<string>();
    m.botCommands?.forEach((c, i) => {
      [c.command, ...(c.aliases ?? [])].forEach((name, j) => {
        if (names.has(name.toLowerCase()))
          ctx.addIssue({
            code: 'custom',
            path: j === 0 ? ['botCommands', i, 'command'] : ['botCommands', i, 'aliases', j - 1],
            message: `${name} is declared twice`,
          });
        names.add(name.toLowerCase());
      });
    });
    if (m.requires.includes(m.id))
      ctx.addIssue({
        code: 'custom',
        path: ['requires'],
        message: 'a plugin cannot require itself',
      });
    for (const type of Object.keys(m.events)) {
      const ns = type.slice(0, type.indexOf('.'));
      if (!m.games.registers.includes(ns))
        ctx.addIssue({
          code: 'custom',
          path: ['events', type],
          message: `namespace ${ns} is not among games.registers`,
        });
    }
    m.answers.forEach((a, i) => {
      if (!Object.hasOwn(m.events, a.event))
        ctx.addIssue({
          code: 'custom',
          path: ['answers', i, 'event'],
          message: `${a.event} is not among its events`,
        });
    });
    if (m.games.registers.includes('core'))
      ctx.addIssue({
        code: 'custom',
        path: ['games', 'registers'],
        message: 'the core namespace is the core’s',
      });
    for (const [port, p] of Object.entries(m.outputs)) {
      if (p.type === 'chat-out' && p.many === true && p.single !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', port],
          message: 'an output of one chat (single) has one edge, not many',
        });
      const pattern = p.type === 'chat-out' ? p.single?.pattern : undefined;
      if (pattern !== undefined && regexProblem(pattern) !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', port, 'single', 'pattern'],
          message: `expected a regular expression: ${regexProblem(pattern)}`,
        });
    }
    for (const [port, p] of Object.entries(m.inputs)) {
      if (p.type === 'chat-in' && p.sameAs !== undefined && m.node === undefined) {
        const out = m.outputs[p.sameAs];
        if (out?.type !== 'chat-out' || out.single === undefined)
          ctx.addIssue({
            code: 'custom',
            path: ['inputs', port, 'sameAs'],
            message: `it has no chat-out output ${p.sameAs} of one chat (single)`,
          });
      }
      if (p.type === 'interface' && p.plugin === m.id && p.bind === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['inputs', port],
          message: 'an input of its own interface needs a bind',
        });
      if (
        p.type === 'events' &&
        typeof p.namespace !== 'string' &&
        !Object.hasOwn(m.config?.shape ?? {}, p.namespace.config)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['inputs', port, 'namespace'],
          message: `its config has no key ${p.namespace.config}`,
        });
      if (
        (p.type === 'chat-in' || p.type === 'events') &&
        p.when !== undefined &&
        !Object.hasOwn(m.config?.shape ?? {}, p.when.config)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['inputs', port, 'when'],
          message: `its config has no key ${p.when.config}`,
        });
    }
    for (const [port, p] of Object.entries(m.outputs))
      if (p.type === 'commands' && !connector)
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', port],
          message: 'only a connector serves commands (D109)',
        });
    if (
      Object.keys(m.interface.commands ?? {}).length > 0 &&
      Object.hasOwn(m.inputs, COMMANDS_PORT)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['inputs', COMMANDS_PORT],
        message: `the input ${COMMANDS_PORT} is derived from its commands (D109): name it otherwise`,
      });
    const derived = new Set([
      'interface',
      ...(m.account === undefined || !m.chat ? [] : ['chat']),
      ...m.games.registers.map((ns) =>
        m.games.registers.length === 1 ? 'events' : `${ns}-events`
      ),
    ]);
    for (const port of Object.keys(m.outputs))
      if (derived.has(port))
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', port],
          message: `the output ${port} is derived: name its chat-out otherwise`,
        });
  })
  .transform(normalise);

/** Why `pattern` is not a regular expression, or undefined. */
function regexProblem(pattern: string): string | undefined {
  try {
    new RegExp(pattern, 'u');
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * The manifest with its shorthand read as ports (§2.1), and its output ports derived: `requires`
 * with `uses` (or alone) an interface input named after the plugin, `games.consumes` an optional
 * events input `<namespace>-events`. A port declared in `inputs` under one of these names is left
 * as written.
 *
 * A connector (its `account`) has a chat-in output and a chat-out input, both named `chat`, unless
 * it has no chat (`chat: false`, D148).
 */
function normalise<
  M extends {
    id: string;
    account?: string | undefined;
    chat: boolean;
    requires: string[];
    uses: Record<string, string[]>;
    games: { registers: string[]; consumes: string[] };
    inputs: Record<string, DeclaredInput>;
    outputs: Record<string, DeclaredOutput>;
    interface: {
      state?: Record<string, unknown> | undefined;
      actions?: Record<string, unknown> | undefined;
      commands?: Record<string, unknown> | undefined;
    };
  },
>(m: M) {
  const { requires, uses, games, inputs: declared, outputs: declaredOut, ...rest } = m;
  const inputs: Record<string, DeclaredInput> = {};
  const add = (name: string, port: DeclaredInput): void => {
    let n = name;
    for (let i = 2; Object.hasOwn(inputs, n) || Object.hasOwn(declared, n); i++) n = `${name}-${i}`;
    inputs[n] = port;
  };
  // In the order of `requires`, which the load order follows; a plugin used is required too.
  for (const id of requires)
    add(id, { type: 'interface', plugin: id, members: uses[id] ?? [], optional: false });
  for (const [id, members] of Object.entries(uses))
    if (!requires.includes(id))
      add(id, { type: 'interface', plugin: id, members, optional: false });
  for (const ns of games.consumes)
    add(`${ns}-events`, { type: 'events', namespace: ns, optional: true });
  const all: Record<string, ManifestInputPort> = { ...inputs, ...declared };
  // Its chat commands, served through the edges to this input (D109).
  const commands = Object.keys(m.interface.commands ?? {});
  if (commands.length > 0)
    all[COMMANDS_PORT] = {
      type: 'commands',
      commands,
      optional: true,
      help: 'Its chat commands: the connectors that answer them, where, and to whom',
    };
  const outputs: Record<string, OutputPort> = {};
  if (m.account !== undefined) {
    const network = m.account.slice(0, m.account.indexOf(':'));
    // A connector's commands output is of its account's network (D109).
    for (const [name, p] of Object.entries(declaredOut))
      if (p.type === 'commands') outputs[name] = { ...p, network };
    if (m.chat) outputs['chat'] = { type: 'chat-in', network };
    if (m.chat && !Object.hasOwn(all, 'chat'))
      all['chat'] = {
        type: 'chat-out',
        network,
        optional: true,
        help: 'What the plugins send through its account',
      };
  }
  for (const [name, p] of Object.entries(declaredOut))
    if (!Object.hasOwn(outputs, name)) outputs[name] = p;
  for (const ns of games.registers)
    outputs[games.registers.length === 1 ? 'events' : `${ns}-events`] = {
      type: 'events',
      namespace: ns,
    };
  outputs['interface'] = {
    type: 'interface',
    plugin: m.id,
    members: [
      ...Object.keys(m.interface.state ?? {}).map((n) => `state.${n}`),
      ...Object.keys(m.interface.actions ?? {}).map((n) => `actions.${n}`),
    ],
  };
  return { ...rest, games: { registers: games.registers }, inputs: all, outputs };
}

/** A manifest as a plugin writes it. */
export type ManifestInput = z.input<typeof manifestSchema>;
/** A manifest as the core holds it, with its defaults filled in. */
export type Manifest = z.output<typeof manifestSchema>;

export class ManifestError extends Error {}

/** `raw` as a valid manifest, or a ManifestError naming the plugin and every field wrong. */
export function parseManifest(raw: unknown): Manifest {
  const result = manifestSchema.safeParse(raw);
  if (result.success) return result.data;
  const id =
    typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string'
      ? (raw as { id: string }).id
      : '(no id)';
  const problems = result.error.issues.map(
    (i) => `${i.path.length > 0 ? i.path.map(String).join('.') : '(manifest)'}: ${i.message}`
  );
  throw new ManifestError(`plugin ${id}: bad manifest: ${problems.join('; ')}`);
}
