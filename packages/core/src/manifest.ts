/**
 * The manifest of a plugin (docs/bot-os-api.md §2): what it is, what it needs, and everything it
 * offers or reaches, validated with zod when the instance starts. A bad manifest names the plugin
 * and the field, and the instance does not start: it is a mistake in the image, best seen at once.
 */
import { z } from 'zod';
import { type InputPort, inputSchema, type OutputPort, PORT_NAME } from './ports.ts';

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
    uses: z.record(z.string().regex(PLUGIN_ID), z.array(z.string().min(1))).default({}),
    reach: z
      .array(
        z.strictObject({
          connector: z.string().regex(PLUGIN_ID),
          reads: z.array(z.string().min(1)).default([]),
          sends: z.array(z.string().min(1)).default([]),
          /** The commands it may send there, by their first word (`!roll`); none: any text. */
          commands: z.array(z.string().min(1)).optional(),
        })
      )
      .default([]),
    config: objectSchema.optional(),
    settings: objectSchema.optional(),
    secrets: z.array(z.string().regex(SECRET_NAME, 'expected a Docker secret name')).default([]),
    /**
     * The keys of its `config` whose values name a secret (docs/bot-os-api.md §4.9): a connector
     * that several nodes run, each with a credential of its own that its node's config names.
     */
    configSecrets: z.array(z.string().min(1)).default([]),
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
        state: z.record(name, z.strictObject({ help: z.string(), output: schema })),
      })
      .partial()
      .default({}),
  })
  .superRefine((m, ctx) => {
    const connector = m.kinds.includes('connector');
    if (m.secrets.length > 0 && !connector)
      ctx.addIssue({
        code: 'custom',
        path: ['secrets'],
        message: 'only a connector may hold secrets (P9)',
      });
    if (m.configSecrets.length > 0 && !connector)
      ctx.addIssue({
        code: 'custom',
        path: ['configSecrets'],
        message: 'only a connector may hold secrets (P9)',
      });
    if (connector && m.account === undefined)
      ctx.addIssue({ code: 'custom', path: ['account'], message: 'a connector names its account' });
    if (!connector && m.account !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['account'],
        message: 'only a connector has an account',
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
    if (m.games.registers.includes('core'))
      ctx.addIssue({
        code: 'custom',
        path: ['games', 'registers'],
        message: 'the core namespace is the core’s',
      });
    for (const [port, p] of Object.entries(m.inputs))
      if (p.type === 'interface' && p.plugin === m.id && p.bind === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['inputs', port],
          message: 'an input of its own interface needs a bind',
        });
  })
  .transform(normalise);

/**
 * The manifest with its shorthand read as input ports (§2.1), and its output ports derived:
 * `requires` with `reach` a chat input named after the connector, `requires` with `uses` (or
 * alone) an interface input named after the plugin, `games.consumes` an optional events input
 * `<namespace>-events`. A port declared in `inputs` under one of these names is left as written.
 */
function normalise<
  M extends {
    id: string;
    account?: string | undefined;
    requires: string[];
    uses: Record<string, string[]>;
    reach: {
      connector: string;
      reads: string[];
      sends: string[];
      commands?: string[] | undefined;
    }[];
    games: { registers: string[]; consumes: string[] };
    inputs: Record<string, InputPort>;
    interface: {
      state?: Record<string, unknown> | undefined;
      actions?: Record<string, unknown> | undefined;
    };
  },
>(m: M) {
  const { requires, uses, reach, games, inputs: declared, ...rest } = m;
  const inputs: Record<string, InputPort> = {};
  const add = (name: string, port: InputPort): void => {
    let n = name;
    for (let i = 2; Object.hasOwn(inputs, n) || Object.hasOwn(declared, n); i++) n = `${name}-${i}`;
    inputs[n] = port;
  };
  const chatOf = (r: (typeof reach)[number], optional: boolean): InputPort => ({
    type: 'chat',
    optional,
    bind: {
      node: r.connector,
      reads: r.reads,
      sends: r.sends,
      ...(r.commands === undefined ? {} : { commands: r.commands }),
    },
  });
  // In the order of `requires`, which the load order follows.
  for (const id of requires) {
    const r = reach.find((x) => x.connector === id);
    if (r !== undefined) add(id, chatOf(r, false));
    if (r === undefined || Object.hasOwn(uses, id))
      add(id, { type: 'interface', plugin: id, members: uses[id] ?? [], optional: false });
  }
  // A plugin used is required, as one required is.
  for (const [id, members] of Object.entries(uses))
    if (!requires.includes(id))
      add(id, { type: 'interface', plugin: id, members, optional: false });
  for (const r of reach) if (!requires.includes(r.connector)) add(r.connector, chatOf(r, true));
  for (const ns of games.consumes)
    add(`${ns}-events`, { type: 'events', namespace: ns, optional: true });
  const all = { ...inputs, ...declared };
  const outputs: Record<string, OutputPort> = {};
  if (m.account !== undefined)
    outputs['chat'] = { type: 'chat', network: m.account.slice(0, m.account.indexOf(':')) };
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
