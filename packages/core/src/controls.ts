/**
 * The owner's controls (docs/bot-os-api.md §4.11, P11): what the owner of the instance sees and
 * changes, built from what each plugin declares, and nothing else. Every control surface (the chat
 * surface's owner commands, the HTTP control API under `cli.ts`, the web UI and the agents later)
 * is made from these.
 *
 * - Each node's state (bot-os.md D64: running; disabled; stopped, with its stop; inactive, with
 *   the node it needs; failed, with why), its settings, and the state and actions its manifest's
 *   `interface` declares, which the owner reads and calls (an action's input checked against its
 *   schema). The states are raised only in the editor, applied with a restart: no control here
 *   starts a node again.
 * - The off switch, instance-wide and kept across restarts in the core's store (P8): off, the
 *   owner is told nothing, and each plugin hears it (`off`, `on`) and stops what it does.
 * - The kill switch: each plugin's own `kill` (its safety stop, such as an actor stopped), whatever
 *   its state; a plugin without one is left as it is.
 * - A node's kill (D44, the graph view's) or stop (Telegram's `/plugins`): that plugin's own safety
 *   stop, then the core stops it, kept in its instance across restarts (D64), so that its outbox
 *   refuses its sends; nothing else is stopped with it until the next start, which leaves the
 *   nodes that require it inactive. The owner clears the stop in the editor
 *   (`clearStop`, then a restart).
 *
 * Nothing in here knows of any game or any network.
 */
import { type Buttons } from './commands.ts';
import { type ConnectorStatus, type Surface, type SurfaceQuery } from './connector.ts';
import { type DriftCounts } from './drift.ts';
import { type Manifest } from './manifest.ts';
import { type Instance } from './plugin.ts';
import { type InputPort } from './ports.ts';
import { type SettingsRegistry, type SettingValue } from './settings.ts';

/** The core's document of the off switch. */
export const POWER_DOC = 'power';

/** What the off switch keeps. */
export interface PowerDoc {
  off: boolean;
}

/** Who or what stopped a node (bot-os.md D64). */
export type StopSource = 'safety' | 'drift' | 'owner';

/** A node's stop, as its instance keeps it (`_stop.json`): why, when, and who or what. */
export interface StopRecord {
  reason: string;
  /** When, in ISO 8601. */
  time: string;
  source: StopSource;
}

/** The reason of a node the owner killed in the editor (D44): stopped, until cleared (D64). */
export const KILLED = 'killed by the owner';
/** The reason of a node the owner stopped from the chat surface (`/plugins`, D64). */
export const STOPPED = 'stopped by the owner';

/** The text of a change refused while the instance is off. */
export const OFF_REFUSAL = 'the bot is off: `cli.ts on` first';

/** What the controls need of the core. */
export interface ControlsHost {
  settings: SettingsRegistry;
  /** The core's own documents. */
  store: { read<T>(name: string): T | undefined; write(name: string, value: unknown): void };
  /** The plugin instances, in load order: each one's id and its plugin's manifest. */
  nodes(): { id: string; manifest: Manifest; ports?: Record<string, InputPort> }[];
  /** A plugin's state, with why, and its stop if it is stopped. */
  status(id: string): { state: string; reason?: string; stop?: StopRecord } | undefined;
  /** An up plugin's instance (running, or stopped since it started). */
  instance(id: string): Instance | undefined;
  /** Stops a node up, as the owner, kept in its instance (D64); false if it is not up. */
  stopNode(id: string, reason: string): boolean;
  /** Clears a node's kept stop, for the next start; false if it has none. */
  clearStop(id: string): boolean;
  /** Logs the change in the event log (`core.power`). */
  record(fields: Record<string, unknown>): void;
  /** Logs a hook that failed. */
  error(id: string, line: string): void;
  /** A connector instance's account (its node's), and its connection while it runs. */
  account(id: string): { account?: string; connection?: Connection };
  /** Each parser's drift (§4.7). */
  drift(): DriftCounts[];
}

/** What the controls read of a running connector. */
export interface Connection {
  readonly network: string;
  self(): string | undefined;
  status(): ConnectorStatus;
  surfaces?(query?: SurfaceQuery): Promise<Surface[]>;
}

/**
 * A connector's surfaces, as the owner picks from them (bot-os.md D63): `running` false while it
 * does not run (apply first), `listed` false for a connector that cannot list its chats.
 */
export interface SurfacesView {
  running: boolean;
  listed: boolean;
  surfaces: Surface[];
}

/** One account, as the owner sees it: its connector instance and the connection's status. */
export interface AccountControl {
  /** The connector instance's id. */
  id: string;
  /** Its plugin's id. */
  plugin: string;
  /** `<network>:<name>`, if the connector names one. */
  account?: string;
  /** The connector instance's state (running, failed with why…). */
  state: string;
  reason?: string;
  /** While it runs and connects anywhere: the network, the account's own name, the status. */
  network?: string;
  self?: string;
  connection?: ConnectorStatus;
}

/** One plugin, as the owner sees it. */
export interface PluginControl {
  /** The instance's id. */
  id: string;
  /** Its plugin's id: the instance's, unless the plugin is instantiated more than once (§2.1). */
  plugin: string;
  description: string;
  kinds: readonly string[];
  /**
   * Its state (D64): `running`, `disabled`, `stopped`, `inactive`, `failed`, or on its way
   * (`starting`, `stopping`).
   */
  state: string;
  /** Why it is stopped, inactive (the node it needs: `needs tg (disabled)`) or failed. */
  reason?: string;
  /** Its stop, as its instance keeps it, while it is stopped. */
  stop?: StopRecord;
  /** Its settings, by the surfaces' names, with the values in force. */
  settings: Record<string, SettingValue | undefined>;
  /** The names of the reads and the actions it declares. */
  reads: string[];
  actions: string[];
  /** Its own account of itself, if it declares a `status` read and runs. */
  status?: unknown;
}

/** An action's outcome: its output, or why not (`refused`: the plugin's own refusal). */
export type ActResult = { output: unknown } | { error: string; refused?: boolean };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Controls {
  private readonly host: ControlsHost;
  private offNow: boolean;

  constructor(host: ControlsHost) {
    this.host = host;
    this.offNow = host.store.read<PowerDoc>(POWER_DOC)?.off ?? false;
  }

  /** Whether the owner turned the instance off. */
  get off(): boolean {
    return this.offNow;
  }

  /** The instance and each plugin, in load order. */
  status(): { off: boolean; plugins: PluginControl[] } {
    const current = this.host.settings.current();
    return {
      off: this.offNow,
      plugins: this.host.nodes().map(({ id, manifest: m }) => {
        const s = this.host.status(id);
        const settings: Record<string, SettingValue | undefined> = {};
        for (const key of this.host.settings.of(id)?.keys() ?? []) {
          const name = this.host.settings.owner(key) === id ? key : `${id}.${key}`;
          settings[name] = current[name];
        }
        const reads = Object.keys(m.interface.state ?? {});
        const status = reads.includes('status') ? this.read(id, 'status') : undefined;
        return {
          id,
          plugin: m.id,
          description: m.description,
          kinds: [...m.kinds],
          state: s?.state ?? 'unknown',
          ...(s?.reason === undefined ? {} : { reason: s.reason }),
          ...(s?.stop === undefined ? {} : { stop: { ...s.stop } }),
          settings,
          reads,
          actions: Object.keys(m.interface.actions ?? {}),
          ...(status !== undefined && 'value' in status ? { status: status.value } : {}),
        };
      }),
    };
  }

  /**
   * Each account the instance holds: every connector instance, in load order, with its
   * connection's status while it runs (one that failed has none).
   */
  accounts(): AccountControl[] {
    return this.host
      .nodes()
      .filter(({ manifest: m }) => m.kinds.includes('connector'))
      .map(({ id, manifest: m }) => {
        const s = this.host.status(id);
        const { account, connection: c } = this.host.account(id);
        const self = c?.self();
        return {
          id,
          plugin: m.id,
          ...(account === undefined ? {} : { account }),
          state: s?.state ?? 'unknown',
          ...(s?.reason === undefined ? {} : { reason: s.reason }),
          ...(c === undefined ? {} : { network: c.network, connection: c.status() }),
          ...(self === undefined ? {} : { self }),
        };
      });
  }

  /**
   * A connector's surfaces (bot-os.md D63): the chats it can see, latest first, matching the
   * query; undefined for a node that is not a connector. Rejects when the connector cannot tell
   * now (not connected).
   */
  async surfaces(id: string, query: SurfaceQuery = {}): Promise<SurfacesView | undefined> {
    const node = this.host.nodes().find((n) => n.id === id);
    if (node === undefined || !node.manifest.kinds.includes('connector')) return undefined;
    const c = this.host.account(id).connection;
    if (c === undefined) return { running: false, listed: false, surfaces: [] };
    if (c.surfaces === undefined) return { running: true, listed: false, surfaces: [] };
    return { running: true, listed: true, surfaces: await c.surfaces(query) };
  }

  /** Each parser's drift: what it read and could not read, and whether it tripped (P5). */
  drift(): DriftCounts[] {
    return this.host.drift();
  }

  /**
   * The owner clears a node's stop (D64), for the next start: the editor's Clear stop, applied
   * with a restart. Why not, or undefined.
   */
  clearStop(id: string): string | undefined {
    if (this.manifest(id) === undefined) return `no plugin ${id}`;
    return this.host.clearStop(id) ? undefined : `${id} is not stopped`;
  }

  /** The instance off: kept, logged, and heard by every plugin running. What came of it. */
  turnOff(): string {
    if (this.offNow) return 'already off';
    this.offNow = true;
    this.host.store.write(POWER_DOC, { off: true });
    this.host.record({ off: true });
    this.each((id, i) => i.off?.());
    return 'off';
  }

  /** The instance back on: each plugin takes up what it did, and says what. */
  turnOn(): string {
    if (!this.offNow) return 'already on';
    this.offNow = false;
    this.host.store.write(POWER_DOC, { off: false });
    this.host.record({ off: false });
    const said: string[] = [];
    this.each((_id, i) => {
      const s = i.on?.();
      if (typeof s === 'string' && s !== '') said.push(s);
    });
    return said.length === 0 ? 'on' : said.join('; ');
  }

  /** The kill switch: each plugin's own; what came of it, with the plugins' ways on. */
  kill(): { text: string; buttons: Buttons } {
    const said: string[] = [];
    const buttons: (readonly { label: string; action: string }[])[] = [];
    this.each((_id, i) => {
      const k = i.kill?.();
      if (k === undefined) return;
      const { text, buttons: b = [] } = typeof k === 'string' ? { text: k } : k;
      said.push(text);
      buttons.push(...b);
    });
    buttons.push([{ label: 'Kill', action: 'kill' }]);
    return { text: `Killed: ${said.join('; ') || 'nothing to stop'}`, buttons };
  }

  /**
   * The owner kills one node (D44), or stops it (`/plugins`, `reason` `STOPPED`): its plugin's own
   * safety stop (`kill`), then the core stops it (D64), kept in its instance, so that it sends
   * nothing and is not started again until the owner clears the stop in the editor. The nodes that
   * use it are not stopped with it; at the next start, those that require it are inactive. What
   * came of it, or why not.
   */
  killNode(id: string, reason = KILLED): { result: string } | { error: string } {
    if (this.manifest(id) === undefined) return { error: `no plugin ${id}` };
    const i = this.host.instance(id);
    if (i === undefined) return { error: `${id} is not running` };
    let said = '';
    try {
      const k = i.kill?.();
      said = typeof k === 'string' ? k : (k?.text ?? '');
    } catch (e) {
      this.host.error(id, message(e));
    }
    this.host.stopNode(id, reason);
    const done = reason === KILLED ? 'killed' : 'stopped';
    return { result: `${id} ${done}${said === '' ? '' : `: ${said}`}` };
  }

  /**
   * The plugin instances, in load order: each one's id, its plugin's manifest, and its input ports
   * as its node's config resolves them, where the host knows them.
   */
  nodes(): { id: string; manifest: Manifest; ports?: Record<string, InputPort> }[] {
    return this.host.nodes();
  }

  /** A read the plugin declares, as its instance offers it now. */
  read(id: string, name: string): { value: unknown } | { error: string } {
    const m = this.manifest(id);
    if (m === undefined) return { error: `no plugin ${id}` };
    if (m.interface.state?.[name] === undefined) return { error: `${id} declares no read ${name}` };
    const fn = this.host.instance(id)?.interface?.state?.[name];
    if (typeof fn !== 'function') return { error: `${id} is not running` };
    try {
      return { value: fn() };
    } catch (e) {
      return { error: message(e) };
    }
  }

  /**
   * An action the plugin declares, called by the owner with `input` as its schema makes it; the
   * plugin refuses by throwing, with why.
   */
  async act(id: string, name: string, input: unknown): Promise<ActResult> {
    const m = this.manifest(id);
    if (m === undefined) return { error: `no plugin ${id}` };
    const declared = m.interface.actions?.[name];
    if (declared === undefined) return { error: `${id} declares no action ${name}` };
    const parsed = declared.input.safeParse(input ?? {});
    if (!parsed.success)
      return {
        error: parsed.error.issues
          .map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`)
          .join('; '),
      };
    const fn = this.host.instance(id)?.interface?.actions?.[name] as
      ((input: unknown) => unknown) | undefined;
    if (typeof fn !== 'function') return { error: `${id} is not running` };
    try {
      return { output: await fn(parsed.data) };
    } catch (e) {
      return { error: message(e), refused: true };
    }
  }

  private manifest(id: string): Manifest | undefined {
    return this.host.nodes().find((n) => n.id === id)?.manifest;
  }

  /** Calls `fn` on each plugin up, in load order; one that throws is logged. */
  private each(fn: (id: string, instance: Instance) => void): void {
    for (const { id } of this.host.nodes()) {
      const i = this.host.instance(id);
      if (i === undefined) continue;
      try {
        fn(id, i);
      } catch (e) {
        this.host.error(id, message(e));
      }
    }
  }
}
