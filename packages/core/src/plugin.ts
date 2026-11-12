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
import { type DriftReporter } from './drift.ts';
import { type LogEntry } from './event-log.ts';
import { type ManifestInput } from './manifest.ts';
import { type Mode, type OutboxHandle } from './outbox.ts';
import { type Render } from './render.ts';
import { type Scheduler } from './scheduler.ts';
import { type SettingValue } from './settings.ts';
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
   * A connector's readers (§4.5, bot-os.md D62): what each chat-in edge leaving its node reads, as
   * the graph says, so that it fetches back only the chats some reader needs. Other kinds of
   * plugin receive none.
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
   * within what the edge sends to and the commands it allows, in its mode. `port` may also name
   * the connector instance or the account. Refused if no edge binds one.
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
   * Its mode (P10, §4.6), for a plugin that sends: `set` as the owner's only on the owner's word
   * that reached it (an owner command, an action, `on`), as a safety stop (`safety`) only lower
   *.
   */
  readonly mode: PluginMode;
  /** Whether the owner turned the instance off (§4.11). */
  off(): boolean;
  /**
   * Resumes it, paused by the core (drift, P5), on the owner's word that reached it (the
   * plugin switched on by the owner); false if it was not paused.
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
  readonly events: { read(query?: EventQuery): LogEntry[] };
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
   * and those of the nodes its events inputs bind (records with no instance, imported from an
   * older log, always).
   */
  all?: boolean;
}

/** A plugin's mode, as its context gives it. */
export interface PluginMode {
  get(): Mode;
  set(mode: Mode, by?: 'owner' | 'safety'): string | undefined;
  /** Hears every change of it, whoever made it (the owner's controls among them). */
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
  state?: Record<string, () => unknown>;
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
  /** The core paused it (drift, or the owner): its sends are refused until `resume`. */
  pause?(reason: string): void;
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
}

export interface Plugin {
  manifest: ManifestInput;
  create(ctx: PluginContext): Instance | Promise<Instance>;
}

/** A plugin, typed: the identity function, for the editor's sake. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
