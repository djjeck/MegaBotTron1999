/**
 * A plugin as its author writes it (docs/bot-os-api.md §1): a manifest, and `create`, which makes
 * the running instance from the context the core gives it. A plugin keeps no global state: all it
 * holds hangs off its instance, so that tests can make as many as they like.
 */
import { type BusHandle } from './bus.ts';
import { type Clock } from './clock.ts';
import { type Buttons, type CommandHandler } from './commands.ts';
import {
  type ChatSurface,
  type Connector,
  type ConnectorHandle,
  type ReadFilter,
} from './connector.ts';
import { type OwnCost } from './costs.ts';
import { type DriftReporter } from './drift.ts';
import { type LogCursor, type LogEntry, type LogTail } from './event-log.ts';
import { type ManifestInput } from './manifest.ts';
import { type Mode, type OutboxHandle } from './outbox.ts';
import { type Render } from './render.ts';
import { type Scheduler } from './scheduler.ts';
import { type SettingValue } from './settings.ts';
import { type StateView } from './state-view.ts';
import { type Store } from './store.ts';

/** A plugin's log lines, on stdout, prefixed with its id. */
export interface Logger {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

/** What the core gives a plugin; everything in it is bound to that plugin (§4). */
export interface PluginContext {
  readonly id: string;
  readonly log: Logger;
  readonly clock: Clock;
  /** Its own documents, under `<data>/plugins/<id>/` (§4.2). */
  readonly store: Store;
  /**
   * A connector's secrets (§4.9, P9): those its manifest declares, from the Docker secrets. Other
   * kinds of plugin receive none.
   */
  readonly secrets?: { get(name: string): string };
  /**
   * A connector's readers (§4.5, bot-os.md D62, D66): what each chat-in edge leaving its node reads,
   * as the graph says, of the nodes that read now (starting or running: not disabled, stopped,
   * inactive or failed), so that it fetches back only the chats some running reader needs. Asked
   * again, it says what holds then. Other kinds of plugin receive none.
   */
  readers?(): ReadFilter[];
  /** Its configuration, as the deployment set it and its schema made it (§2). */
  readonly config: Readonly<Record<string, unknown>>;
  /** Its own durable timers, which fire through its instance's `onTimer` (§4.3). */
  readonly scheduler: Scheduler;
  /** Publishes the event types it registers, and hears those of the namespaces it consumes (§4.4). */
  readonly bus: BusHandle;
  /**
   * A handle on the connector its chat-in input `port` is bound to (§2.1, §4.5): it reads the
   * chats the edge reads and tells the status, it cannot send. `port` may also name the connector
   * instance the edge binds. Refused if no edge binds one.
   */
  connector(port: string): ConnectorHandle;
  /**
   * Its way out through the outbox of the account its chat-out output `port` is bound to (§4.6):
   * within what the edge sends to and the commands it allows, a dry run when the edge is one
   * (`mode()` says which). `port` may also name the connector instance or the account. Refused if
   * no edge binds one.
   */
  outbox(port: string): OutboxHandle;
  /**
   * The interface its input `port` is bound to (§2.1 `interface`, P6): only the members the input
   * uses, as the other instance offers them; `port` may also name the instance bound. Refused for
   * an input it does not have, unbound, or whose other end is not running.
   */
  use<T = PluginInterface>(port: string): T;
  /**
   * As `use`, for an optional input: undefined while it is unbound or its other end is not running
   * (a helper's data that the plugin can do without).
   */
  useOptional<T = PluginInterface>(port: string): T | undefined;
  /** Its runtime settings (§2): the owner's values as kept, and a change, kept and put in force. */
  readonly settings: PluginSettingsHandle;
  /** A parser's reports of the messages it read and could not read (§4.7). */
  readonly drift: DriftReporter;
  /**
   * Tells the owner (§4.8), with buttons that each run a command again (§2); nothing while the
   * instance is off.
   */
  notify(text: string, buttons?: Buttons): void;
  /**
   * Its mode, as module API 1 knew it (deprecated, bot-os.md D64): derived, `dry-run` when every
   * chat-out edge of its node is a dry run (or it has none), `live` otherwise. `set('read-only')`,
   * the owner's or a safety stop, stops the node (`stop`); `set('dry-run' | 'live')` is refused
   * and logged, since a node's state and its edges' dry runs change only in the editor;
   * `onChange` hears `read-only` when the node is stopped.
   */
  readonly mode: PluginMode;
  /**
   * Stops its node (bot-os.md D64), its safety stop: its sends refused from now on, its `pause`
   * heard, and the stop kept in its instance across restarts, until the owner clears it in the
   * editor.
   */
  stop(reason: string): void;
  /**
   * Fails its node at runtime (§3), for what it cannot run on (a script that hung, or ran out of
   * memory): its events, messages and timers cut at once, its sends refused, its `stop` called,
   * and the nodes that require it failed too; the owner is told, with why. A failure is not kept
   * across restarts: the next start starts it again.
   */
  fail(reason: string): void;
  /** Whether the owner turned the instance off (§4.11). */
  off(): boolean;
  /**
   * Module API 1 (deprecated, D64): refused and logged, false; a stop is cleared only by the owner,
   * in the editor.
   */
  resume(): boolean;
  /** What `serialise` returned at the last stop, if anything (§3). */
  readonly restored?: unknown;
  /** The render service (§4.13): SVG to PNG. */
  readonly render: Render;
  /**
   * The event log, read back (§4.4): the records of the namespaces it registers, of its plugin's
   * own, and of those its events inputs consume; of one type (`dice.roll`) or namespace (`dice`),
   * or of all of them; over the whole log or since a time. For a replay of recent history at
   * `ready`, or a fresh instance reading the whole log once.
   */
  readonly events: {
    read(query?: EventQuery): LogEntry[];
    /**
     * What was written to the log after `cursor` (bot-os.md D72), of the types or namespaces
     * `types` (all it may read without), filtered as `read` filters them, each with where it sits;
     * and the cursor past everything read, kept or not: for a reader that resumes where it left
     * the log, as the state plugins do. The bus gives each event's place as it delivers it.
     */
    after(cursor: LogCursor, options?: { types?: readonly string[] }): LogTail;
  };
  /**
   * Writes a record to the event log (§4.4), `{ type, t, instance, ...fields }`, `t` now and
   * `instance` its node's instance (§2.2): of a type in a
   * namespace it registers or of its plugin's id (`dice-roller.turn`), with no schema; the bus's
   * events are written as they are published.
   */
  record(type: string, fields: Record<string, unknown>): void;
  /** A connector's account (§4.5): its node's, or its manifest's. */
  readonly account?: string;
}

/** Which of the event log's records a plugin reads (`ctx.events.read`). */
export interface EventQuery {
  /** A type (`dice.roll`) or a namespace (`dice`); all it may read without. */
  type?: string;
  /** From this time (ms); the log's first day without. */
  since?: number;
  /** Up to this time (ms); now without. */
  until?: number;
  /**
   * Every instance's records: without it, only its own instance's records of its own namespaces,
   * and those of the nodes its events inputs bind (records with no instance, written before records
   * carried one, always).
   */
  all?: boolean;
}

/** A plugin's mode, as its context gives it (module API 1, deprecated, bot-os.md D64). */
export interface PluginMode {
  /** `dry-run` when every chat-out edge of its node is a dry run (or it has none), else `live`. */
  get(): Mode;
  /** `read-only` stops the node; another is refused, with why. */
  set(mode: Mode, by?: 'owner' | 'safety'): string | undefined;
  /** Hears `read-only` when the node is stopped. */
  onChange(listener: (mode: Mode) => void): void;
}

/** A plugin's settings, as its context gives them. */
export interface PluginSettingsHandle {
  /** The owner's values, as kept (a key never set has none: its default holds). */
  kept(): Record<string, SettingValue>;
  /** Sets one, from its text form or a value: kept, put in force, and heard; why not, or undefined. */
  set(key: string, raw: unknown): string | undefined;
}

/**
 * What a plugin offers others through `use` (§2 `interface`): its typed reads (`state`) and its
 * actions, by the names its manifest declares.
 */
export interface PluginInterface {
  /** Its reads; one that declares an input takes it, as its schema makes it. */
  state?: Record<string, (input: never) => unknown>;
  actions?: Record<string, (input: never) => unknown>;
}

/** The hooks of a running plugin, all optional (§3). */
export interface Instance {
  start?(): void | Promise<void>;
  /**
   * Every plugin has started, in load order (§3): for the work that needs the plugins that use
   * this one in place, such as a replay of the history they hear.
   */
  ready?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  /** State cheap to lose but costly to rebuild, kept at stop and handed back as `restored`. */
  serialise?(): unknown;
  /**
   * The core stopped it (bot-os.md D64: a safety stop, drift, the owner's kill or stop): its sends
   * are refused, and it is not started again until the owner clears the stop in the editor.
   */
  pause?(reason: string): void;
  /** Module API 1 (deprecated, D64): never called, since a stop is cleared only by a restart. */
  resume?(): void;
  /** A connector plugin's connector (§4.5): the core hands out handles to it. */
  readonly connector?: Connector;
  /** A connector's chat surface (§2, §4.11): the core serves it the commands. */
  readonly surface?: ChatSurface;
  /** The owner changed one of its settings, already in force (§2). */
  settingsChanged?(): void;
  /**
   * Puts its own settings in force and reads the values in force (§2), in place of the instance's
   * wiring: for a plugin whose settings live in its own objects.
   */
  readonly settings?: {
    apply(key: string, value: SettingValue): void;
    read(key: string): SettingValue | undefined;
  };
  /** What it offers other plugins (§2 `interface`), for those that use it. */
  readonly interface?: PluginInterface;
  /**
   * The state it keeps, for the owner's eyes (bot-os.md D72, §4.11): read whole, with its schema,
   * by the node panel's generic viewer (`GET /plugins/<id>/view`), and one line of it on its card
   * (`summary`, in `GET /status`). Read only: nothing changes through it.
   */
  readonly view?: { read(): StateView; summary?(): string | undefined };
  /** The handlers of the chat commands its manifest declares (§2 `interface.commands`, P11). */
  readonly commands?: Readonly<Record<string, CommandHandler>>;
  /** The owner turned the instance off (§4.11): stop what it does, and send nothing. */
  off?(): void;
  /** The instance back on: take up what it did; what came of it, for the owner. */
  on?(): string | undefined;
  /**
   * The kill switch (§4.11): its safety stop; what came of it, with buttons for the ways on (for
   * example: "all off, commands read-only", and a button to turn them on).
   */
  kill?(): string | { text: string; buttons?: Buttons } | undefined;
  /** One of its timers is due (§4.3). */
  onTimer?(name: string, payload: unknown): void;
  /**
   * What it costs of its own, beyond its handlers' time the core measures (bot-os.md D77): a
   * script's worker thread, its CPU, heap and calls. Read for `GET /status`; cheap, from what it
   * last sampled.
   */
  cost?(): OwnCost;
}

export interface Plugin {
  manifest: ManifestInput;
  create(ctx: PluginContext): Instance | Promise<Instance>;
}

/** A plugin, typed: the identity function, for the editor's sake. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
