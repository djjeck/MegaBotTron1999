/**
 * The owner's controls (docs/bot-os-api.md §4.11, P11): what the owner of the instance sees and
 * changes, built from what each plugin declares, and nothing else. Every control surface (the chat
 * surface's owner commands, the HTTP control API under `cli.ts`, the web UI and the agents later)
 * is made from these.
 *
 * - Each plugin's state (running, paused with why, failed with why), its mode if it sends (P10),
 *   its settings, and the state and actions its manifest's `interface` declares, which the owner
 *   reads and calls (an action's input checked against its schema).
 * - The owner sets a plugin's mode and resumes a paused one (P5: only the owner resumes).
 * - The off switch, instance-wide and kept across restarts in the core's store (P8): off, the
 *   owner is told nothing, and each plugin hears it (`off`, `on`) and stops what it does; every
 *   change of a mode is refused until on.
 * - The kill switch: each plugin's own `kill` (a safety stop, such as an actor paused and
 *   `read-only`), whatever its state; a plugin without one is left as it is.
 * - A node's kill (D44, the graph view's): that plugin's own safety stop, then the core pauses it as
 *   killed (`KILLED`), so that its outbox refuses its sends; its resume reinstates it. Its mode is
 *   left as its stop made it, nothing else is killed with it, and it is not kept across a restart.
 *
 * Nothing in here knows of any game or any network.
 */
import { type Buttons } from './commands.ts';
import { type ConnectorStatus } from './connector.ts';
import { type DriftCounts } from './drift.ts';
import { type Manifest } from './manifest.ts';
import { isMode, type Mode, type Modes } from './outbox.ts';
import { type Instance } from './plugin.ts';
import { type SettingsRegistry, type SettingValue } from './settings.ts';

/** The core's document of the off switch. */
export const POWER_DOC = 'power';

/** What the off switch keeps. */
export interface PowerDoc {
  off: boolean;
}

/** The reason of a plugin the owner killed (D44): paused, until its resume. */
export const KILLED = 'killed by the owner';

/** The text of a change refused while the instance is off. */
export const OFF_REFUSAL = 'the bot is off: `cli.ts on` first';

/** What the controls need of the core. */
export interface ControlsHost {
  modes: Modes;
  settings: SettingsRegistry;
  /** The core's own documents. */
  store: { read<T>(name: string): T | undefined; write(name: string, value: unknown): void };
  /** The plugin instances, in load order: each one's id and its plugin's manifest. */
  nodes(): { id: string; manifest: Manifest }[];
  /** Whether an instance sends anywhere: an edge binds a chat it sends to (P10). */
  sends(id: string): boolean;
  /** A plugin's state, with why. */
  status(id: string): { state: string; reason?: string } | undefined;
  /** A running or paused plugin's instance. */
  instance(id: string): Instance | undefined;
  /** Resumes a paused plugin; false if it is not paused. */
  resume(id: string): boolean;
  /** Pauses a running or paused plugin as killed (`KILLED`); false if it is neither. */
  killNode(id: string): boolean;
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
  state: string;
  reason?: string;
  /** The owner killed it (D44): paused as `KILLED`, until its resume. */
  killed?: true;
  /** Its mode, if it sends (P10). */
  mode?: Mode;
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

  /** Whether a plugin has a mode: it sends somewhere (P10). */
  hasMode(id: string): boolean {
    return this.host.sends(id);
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
          ...(s?.state === 'paused' && s.reason === KILLED ? { killed: true as const } : {}),
          ...(this.hasMode(id) ? { mode: this.host.modes.get(id) } : {}),
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

  /** Each parser's drift: what it read and could not read, and whether it tripped (P5). */
  drift(): DriftCounts[] {
    return this.host.drift();
  }

  /** The owner sets a plugin's mode; why not, or undefined. */
  setMode(id: string, mode: unknown): string | undefined {
    if (this.manifest(id) === undefined) return `no plugin ${id}`;
    if (!this.hasMode(id)) return `${id} sends nothing: it has no mode`;
    if (!isMode(mode)) return 'mode must be read-only, dry-run or live';
    if (this.offNow) return OFF_REFUSAL;
    return this.host.modes.set(id, mode);
  }

  /** The owner resumes a plugin paused (drift, P5); why not, or undefined. */
  resume(id: string): string | undefined {
    if (this.manifest(id) === undefined) return `no plugin ${id}`;
    if (this.offNow) return OFF_REFUSAL;
    return this.host.resume(id) ? undefined : `${id} is not paused`;
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
   * The owner kills one node (D44): its plugin's own safety stop (`kill`), then the core pauses it
   * as killed, so that it sends nothing until its resume (`resume`) reinstates it. Its mode is left
   * as its stop made it; the nodes that use it are not killed with it. What came of it, or why not.
   */
  killNode(id: string): { result: string } | { error: string } {
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
    this.host.killNode(id);
    return { result: `${id} killed${said === '' ? '' : `: ${said}`}` };
  }

  /** The plugin instances, in load order: each one's id and its plugin's manifest. */
  nodes(): { id: string; manifest: Manifest }[] {
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

  /** Calls `fn` on each running or paused plugin, in load order; one that throws is logged. */
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
