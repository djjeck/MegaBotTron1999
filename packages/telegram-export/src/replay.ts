/**
 * The dev kit's replay (#60, #49): a recorded chat fed through real plugins as it was said. Given
 * one module's plugins, or a graph file in the live format, and the `Inbound`s of an export
 * (inbound.ts), it runs them on a `DevKit` (packages/core/src/devkit.ts) whose `telegram-user`
 * nodes are `FakeConnector`s, and feeds the messages in time order on its `VirtualClock`: the clock
 * runs to each message's time first, every timer due on the way at its own time, so that rests,
 * timers and answers behave as they did live. The messages go live, or as history (`playback`).
 * Out come the run's event log, its drift, the outboxes' answers (D98: each account's outbox is
 * made at the start, so that what a parser reads as an answer holds its command back, as live), and
 * the plugins' state and interface, for a test or a tool to check.
 *
 * Each `telegram-user` node is swapped for a fake connector of the same id, configuration and
 * account, which delivers what its node monitors as the connector would: a chat its `chats` lists,
 * named as listed, its other names as aliases; every chat when it lists none. Other connectors of a
 * graph file come as the caller's plugins (`fakeConnectorPlugin`). Nothing here knows of any game.
 */
import {
  TELEGRAM_USER,
  type TelegramUserConfig,
  telegramUserConfig,
} from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  definePlugin,
  DevKit,
  type DevKitOptions,
  type DriftCounts,
  FakeConnector,
  type Inbound,
  type LogEntry,
  type Plugin,
  readGraphFile,
} from '@megabottron1999/core';

/** The account a `telegram-user` node has when its graph gives it none: its manifest's. */
export const OWNER_ACCOUNT = 'telegram:owner';

export interface ReplayOptions extends Pick<
  DevKitOptions,
  'config' | 'settings' | 'documents' | 'history' | 'print' | 'validateEvents' | 'record'
> {
  /** The plugins of the run but `telegram-user` (a module's, and any other fake connector). */
  plugins: readonly Plugin[];
  /** The messages, as `telegram-user` would have delivered them (`toInbounds`); fed in time order. */
  inbounds: readonly Inbound[];
  /**
   * The run's graph: a graph file's path, in the live format (its `telegram-user` nodes swapped),
   * a graph, or a function of the default one (one node per plugin, as the manifests bind them).
   */
  graph?: string | DevKitOptions['graph'];
  /** The account's own username, without `@` (`self()`); by default, its account's name. */
  self?: string;
  /** Feeds every message live (false) or as history (true); by default, as each one says. */
  playback?: boolean;
  /** The clock's start; by default, the first message's time. */
  start?: number;
  /** Where the clock runs to after the last message, its timers run; by default, nowhere further. */
  until?: number;
}

/** A replay run: its kit, still running until `stop`, and what to check of it. */
export interface Replay {
  kit: DevKit;
  /** The fake connector of each `telegram-user` node, by node id. */
  connectors: ReadonlyMap<string, FakeConnector>;
  /** How many messages were delivered (not filtered out by a node's `chats`). */
  delivered: number;
  /** The event log of the run: its history, then every record. */
  records(): readonly LogEntry[];
  /** Drift, per parser. */
  drift(): DriftCounts[];
  /** A plugin instance's state read (`state.<name>`), as its owner's controls read it; throws on an error. */
  read(node: string, name: string, input?: unknown): unknown;
  /** A plugin instance's action (`actions.<name>`), as its owner's controls run it. */
  act(node: string, name: string, input: unknown): Promise<unknown>;
  /** Every send, by any swapped connector, in order. */
  sent(): { node: string; chat: string; text: string }[];
  stop(): Promise<void>;
}

interface Swapped {
  connector: FakeConnector;
  chats: readonly string[] | undefined;
}

/**
 * `telegram-user`, faked: each node a `FakeConnector` of its account, with the connector's limits
 * from its configuration (the real plugin's schema, so that a live graph's config is checked as
 * live), kept in `swapped` by node id.
 */
function fakeTelegramUser(swapped: Map<string, Swapped>, self: string | undefined): Plugin {
  return definePlugin({
    manifest: {
      id: TELEGRAM_USER,
      version: '0.1.0',
      kinds: ['connector'],
      description: "The owner's own Telegram account, replayed from an export",
      account: OWNER_ACCOUNT,
      config: telegramUserConfig,
      monitors: { config: 'chats', aliases: true },
    },
    create: (ctx) => {
      const account = ctx.account ?? OWNER_ACCOUNT;
      const config = ctx.config as TelegramUserConfig;
      const connector = new FakeConnector({
        account,
        self: self ?? account.slice(account.indexOf(':') + 1),
        limits: {
          commandIntervalMs: config.commandIntervalS * 1000,
          unansweredAt: config.unansweredAt,
          ...(config.unansweredAtBy === undefined ? {} : { unansweredAtBy: config.unansweredAtBy }),
        },
      });
      swapped.set(ctx.id, { connector, chats: config.chats });
      return { connector, start: () => connector.open('ready') };
    },
  });
}

/**
 * A message as a node delivers it: named as its `chats` lists it (by its name or an alias), its
 * other names as aliases; undefined for a chat the node does not monitor. Every chat, as it is,
 * when the node lists none.
 */
export function asMonitored(m: Inbound, chats: readonly string[] | undefined): Inbound | undefined {
  if (chats === undefined) return m;
  const names = [m.chat, ...(m.aliases ?? [])];
  const lower = names.map((n) => n.toLowerCase());
  const listed = chats.find((c) => lower.includes(c.toLowerCase()));
  if (listed === undefined) return undefined;
  const aliases = names.filter((n) => n.toLowerCase() !== listed.toLowerCase());
  const { aliases: _, ...rest } = m;
  return { ...rest, chat: listed, ...(aliases.length === 0 ? {} : { aliases }) };
}

/** Lets the plugins' pending promises run (a handler's awaits, a send's queue). */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Replays the messages through the plugins (see the top of the file). Throws when the kit does not
 * start (a graph refused, a plugin failed), and when a message's account is none of the swapped
 * nodes' and there is more than one.
 */
export async function replay(o: ReplayOptions): Promise<Replay> {
  const swapped = new Map<string, Swapped>();
  const inbounds = [...o.inbounds].sort((a, b) => a.time - b.time);
  const graph =
    typeof o.graph === 'string' ? (readGraphFile(o.graph) as DevKitOptions['graph']) : o.graph;
  const kit = new DevKit({
    start: o.start ?? inbounds[0]?.time ?? 0,
    plugins: [fakeTelegramUser(swapped, o.self), ...o.plugins],
    ...(graph === undefined ? {} : { graph }),
    ...(o.config === undefined ? {} : { config: o.config }),
    ...(o.settings === undefined ? {} : { settings: o.settings }),
    ...(o.documents === undefined ? {} : { documents: o.documents }),
    ...(o.history === undefined ? {} : { history: o.history }),
    ...(o.print === undefined ? {} : { print: o.print }),
    ...(o.validateEvents === undefined ? {} : { validateEvents: o.validateEvents }),
    ...(o.record === undefined ? {} : { record: o.record }),
  });
  await kit.start();
  // Each account's outbox, as a live instance has it for its senders: the answers its parsers
  // read are kept there (D98), whether or not a node of the run sends.
  for (const s of swapped.values()) kit.core.outbox(s.connector.account);
  await settle();
  const advance = async (t: number): Promise<void> => {
    for (let at = kit.clock.nextAt(); at !== undefined && at <= t; at = kit.clock.nextAt()) {
      kit.clock.runNext();
      await settle();
    }
    kit.clock.advanceTo(t);
  };
  const nodes = [...swapped.values()];
  let delivered = 0;
  for (const m of inbounds) {
    await advance(m.time);
    const to = nodes.filter((n) => n.connector.account === m.account);
    if (to.length === 0 && nodes.length !== 1)
      throw new Error(
        `replay: message ${m.id ?? '?'} is of ${m.account}, and the graph's telegram-user nodes are of ${nodes.map((n) => n.connector.account).join(', ') || 'none'}`
      );
    for (const n of to.length === 0 ? nodes : to) {
      const seen = asMonitored(m, n.chats);
      if (seen === undefined) continue;
      const { account: _a, network: _n, ...heard } = seen;
      n.connector.hear({ ...heard, ...(o.playback === undefined ? {} : { playback: o.playback }) });
      delivered++;
      await settle();
    }
  }
  if (o.until !== undefined) await advance(o.until);
  return {
    kit,
    connectors: new Map([...swapped].map(([id, s]) => [id, s.connector])),
    delivered,
    records: () => kit.log.records,
    drift: () => kit.core.drift(),
    read: (node, name, input) => {
      const r = kit.core.controls.read(node, name, input);
      if ('error' in r) throw new Error(`replay: ${node}.${name}: ${r.error}`);
      return r.value;
    },
    act: (node, name, input) => kit.core.controls.act(node, name, input),
    sent: () =>
      [...swapped].flatMap(([node, s]) =>
        s.connector.sent.map((x) => ({ node, chat: x.chat, text: x.text }))
      ),
    stop: () => kit.stop(),
  };
}
