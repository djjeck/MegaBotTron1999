/**
 * The owner's controls (docs/bot-os-api.md §4.11, P11): what the owner of the instance sees and
 * changes, built from what each plugin declares, and nothing else. Every control surface (the chat
 * surface's owner commands, the HTTP control API and the web UI on it) is made from these.
 *
 * - Each node's state (bot-os.md D64: running; disabled; stopped, with its stop; inactive, with
 *   the node it needs; failed, with why; D143: loading, while the plugins load, and unloaded, its
 *   plugin not loaded, with what failed to load), its settings, and the state and actions its manifest's
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
import fs from 'node:fs';
import { type BackoffView } from './answers.ts';
import { type Buttons } from './commands.ts';
import { type ConnectorStatus, type Surface, type SurfaceQuery } from './connector.ts';
import { type NodeCost } from './costs.ts';
import { type DriftCounts } from './drift.ts';
import { type LoginState } from './login.ts';
import { type Manifest } from './manifest.ts';
import { type CoalescedView, type QueueEntryView } from './outbox.ts';
import { type PeopleQuery, type Person } from './people.ts';
import { type ActionCall, type Instance } from './plugin.ts';
import { type InputPort } from './ports.ts';
import { type SealedState } from './sealed-store.ts';
import { type SettingsRegistry, type SettingValue } from './settings.ts';
import { type StateView } from './state-view.ts';
import { type FileLimits, type StoreFileInfo } from './store.ts';
import { scopedSheet, type ViewStyle } from './view-style.ts';

/** The core's document of the off switch. */
export const POWER_DOC = 'power';

/** What the off switch keeps. */
export interface PowerDoc {
  off: boolean;
}

/**
 * Who or what stopped a node (bot-os.md D64): its safety stop, a parser's drift (P5), the
 * send-queue watchdog (`stalled`, D93), or the owner.
 */
export type StopSource = 'safety' | 'drift' | 'stalled' | 'owner';

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

/** What the controls need of the core. */
export interface ControlsHost {
  settings: SettingsRegistry;
  /** The core's own documents. */
  store: { read<T>(name: string): T | undefined; write(name: string, value: unknown): void };
  /** The plugin instances, in load order: each one's id and its plugin's manifest. */
  nodes(): {
    id: string;
    manifest: Manifest;
    ports?: Record<string, InputPort>;
    version?: string;
  }[];
  /** A plugin's state, with why, and its stop if it is stopped. */
  status(id: string): { state: string; reason?: string; stop?: StopRecord } | undefined;
  /** An up plugin's instance (running, or stopped since it started). */
  instance(id: string): Instance | undefined;
  /** Stops a node up, as the owner, kept in its instance (D64); false if it is not up. */
  stopNode(id: string, reason: string): boolean;
  /** Clears a node's kept stop, for the next start; false if it has none. */
  clearStop(id: string): boolean;
  /** What waits in a connector node's queue (bot-os.md D73), in order. */
  queue(id: string): QueueEntryView[];
  /** The sends a connector node's queue coalesced since the start, and the nodes that shared them. */
  coalesced(id: string): CoalescedView;
  /** Logs the change in the event log (`core.power`). */
  record(fields: Record<string, unknown>): void;
  /** Logs a hook that failed. */
  error(id: string, line: string): void;
  /** A connector instance's account (its node's), and its connection while it runs. */
  account(id: string): { account?: string; connection?: Connection };
  /** Each parser's drift (§4.7). */
  drift(): DriftCounts[];
  /** What a node costs (bot-os.md D77). */
  cost?(id: string): NodeCost | undefined;
  /** Counts a read served of a node (D172): its time and its answer's bytes. */
  served?(id: string, ms: number, bytes: number): void;
  /** A view node's stylesheet (D175), as its module loaded it; none for a node without one. */
  viewStyle?(id: string): ViewStyle | undefined;
  /** Hears each set of nodes changed (D173), propagated along interface edges; the way to stop. */
  changes?(listener: (nodes: ReadonlySet<string>) => void): () => void;
  /** A node's commands the retry-loop guard holds back (bot-os.md D98). */
  backoffs?(id: string): BackoffView[];
  /** Takes the secrets out of a text (§4.9): a login's error. */
  redact?(text: string): string;
  /** Where a connector's kept credentials stand at rest (D123): sealed, and why one did not open. */
  sealed?(id: string): SealedState | undefined;
  /** Logs a login's step in the event log (`core.login`, D116): never what was typed. */
  recordLogin?(fields: Record<string, unknown>): void;
  /**
   * The nodes of the saved graph that do not run for their plugin (D143): every one while the
   * plugins load, then those whose plugin did not load and those that need them.
   */
  held?(): HeldControl[];
  /** Where the instance's start is, and what failed to load (D143). */
  boot?(): BootControl;
  /** A node's files (D149), read from its instance's store whatever its state; none: no node. */
  files?(id: string): NodeFiles | undefined;
}

/** What the controls read of a node's files (D149): the owner lists and downloads, never deletes. */
export interface NodeFiles {
  list(): StoreFileInfo[];
  read(name: string): Uint8Array | undefined;
  info(name: string): StoreFileInfo | undefined;
  /** What they take together, in bytes. */
  used(): number;
  readonly limit: FileLimits;
}

/** A node's files, as the owner sees them (`GET /plugins/<id>/files`, D149). */
export interface FilesView {
  files: StoreFileInfo[];
  /** What they take together, in bytes. */
  used: number;
  /** How much a file, and the instance's files together, may take. */
  limits: FileLimits;
}

/** A package or module that failed to load (D143): what, its module's id for a module, and why. */
export interface LoadFailureView {
  source: string;
  module?: string;
  error: string;
}

/** A node the core does not run for its plugin (D143), as `ControlsHost.held` gives it. */
export interface HeldControl {
  id: string;
  plugin: string;
  state: string;
  reason?: string;
  failures?: LoadFailureView[];
}

/** Where the instance's start is (D143): its plugins loading, its nodes starting, or started. */
export interface BootControl {
  phase: 'loading' | 'starting' | 'started';
  failures: LoadFailureView[];
}

/** What the controls read of a running connector. */
export interface Connection {
  readonly network: string;
  self(): string | undefined;
  status(): ConnectorStatus;
  surfaces?(query?: SurfaceQuery): Promise<Surface[]>;
  /** The people its directory knows (bot-os.md D167). */
  people?(query?: PeopleQuery): Person[];
}

/**
 * A connector's surfaces, as the owner picks from them (bot-os.md D63): `running` false while it
 * does not run (apply first), `listed` false for a connector that cannot list its chats. With
 * `peers` asked (D96), the chats the other running connectors of its network list that it does not,
 * its own account's chat left out,
 * by connector: a bot cannot list its chats, so the owner's account names those it may not reach.
 */
export interface SurfacesView {
  running: boolean;
  listed: boolean;
  surfaces: Surface[];
  peers?: { connector: string; surfaces: Surface[] }[];
}

/**
 * The people a connector's directory knows (bot-os.md D167), for the editor's senders: `running`
 * false until it runs; none from a connector that keeps no directory.
 */
export interface PeopleView {
  running: boolean;
  people: Person[];
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
  /**
   * Whom it is logged in as, as its login says (`@ExampleBot`, D120): what the owner recognises,
   * kept from the login, so known before it connects.
   */
  as?: string;
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
  /** The version it runs: its module's, or the release's for one of the image's own. */
  version?: string;
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
  /**
   * What its widget shows (bot-os.md D112): the output of the read its widget names, while it
   * runs and the read answers; the web UI draws it on its card as the widget says.
   */
  widget?: unknown;
  /** One line of the state it keeps, for its card, if it offers a view (bot-os.md D72). */
  summary?: string;
  /** What it costs, since the start (bot-os.md D77). */
  cost?: NodeCost;
  /**
   * Its commands the retry-loop guard holds back (bot-os.md D98): refused so many times in a row
   * for the same reason; none, when nothing is.
   */
  backoff?: BackoffView[];
  /**
   * For a node whose plugin did not load (`unloaded`, D143): what failed to load that may have
   * offered it, each package or module named, with its error.
   */
  failures?: LoadFailureView[];
}

/** An action's outcome: its output, or why not (`refused`: the plugin's own refusal). */
export type ActResult = { output: unknown } | { error: string; refused?: boolean };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The sends a queue coalesced, in words (`2 sends coalesced: a + b (2)`), or undefined for none.
 */
function coalescedText(c: CoalescedView): string | undefined {
  if (c.count === 0) return undefined;
  const pairs = c.pairs.map((p) => `${p.nodes.join(' + ')} (${p.count})`).join(', ');
  return `${c.count} ${c.count === 1 ? 'send' : 'sends'} coalesced: ${pairs}`;
}

/** A schema's refusal of an input, field by field. */
const issues = (list: readonly { path: readonly PropertyKey[]; message: string }[]): string =>
  list.map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ');

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

  /** Where the instance's start is, and what failed to load (D143); none from a host that cannot tell. */
  boot(): BootControl | undefined {
    return this.host.boot?.();
  }

  /**
   * The instance and each plugin, in load order, then the nodes held for their plugin (D143); and
   * where the start is.
   */
  status(): { off: boolean; plugins: PluginControl[]; boot?: BootControl } {
    const current = this.host.settings.current();
    const boot = this.host.boot?.();
    const held = (this.host.held?.() ?? []).map((h): PluginControl => ({
      id: h.id,
      plugin: h.plugin,
      description: '',
      kinds: [],
      state: h.state,
      ...(h.reason === undefined ? {} : { reason: h.reason }),
      settings: {},
      reads: [],
      actions: [],
      ...(h.failures === undefined ? {} : { failures: h.failures }),
    }));
    return {
      off: this.offNow,
      ...(boot === undefined ? {} : { boot }),
      plugins: [
        ...this.running(current),
        ...held.filter((h) => !this.host.nodes().some((n) => n.id === h.id)),
      ],
    };
  }

  /** Each node the core runs, as the owner sees it. */
  private running(current: Record<string, SettingValue | undefined>): PluginControl[] {
    return this.host.nodes().map(({ id, manifest: m, version }) => {
      const s = this.host.status(id);
      const settings: Record<string, SettingValue | undefined> = {};
      for (const key of this.host.settings.of(id)?.keys() ?? []) {
        const name = this.host.settings.owner(key) === id ? key : `${id}.${key}`;
        settings[name] = current[name];
      }
      const reads = Object.keys(m.interface.state ?? {});
      const status = reads.includes('status') ? this.read(id, 'status') : undefined;
      const w = m.widget;
      // Its status, read already, is not read again for a widget that shows it.
      const widget =
        w === undefined
          ? undefined
          : w.read === 'status' && w.input === undefined && status !== undefined
            ? status
            : this.read(id, w.read, w.input);
      const summary = this.summary(id);
      const cost = this.host.cost?.(id);
      const backoff = this.host.backoffs?.(id) ?? [];
      return {
        id,
        plugin: m.id,
        description: m.description,
        kinds: [...m.kinds],
        ...(version === undefined ? {} : { version }),
        state: s?.state ?? 'unknown',
        ...(s?.reason === undefined ? {} : { reason: s.reason }),
        ...(s?.stop === undefined ? {} : { stop: { ...s.stop } }),
        settings,
        reads,
        actions: Object.keys(m.interface.actions ?? {}),
        ...(status !== undefined && 'value' in status ? { status: status.value } : {}),
        ...(widget !== undefined && 'value' in widget ? { widget: widget.value } : {}),
        ...(summary === undefined ? {} : { summary }),
        ...(cost === undefined ? {} : { cost }),
        ...(backoff.length === 0 ? {} : { backoff }),
      };
    });
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
        const as = this.loginAs(id);
        return {
          id,
          plugin: m.id,
          ...(account === undefined ? {} : { account }),
          state: s?.state ?? 'unknown',
          ...(s?.reason === undefined ? {} : { reason: s.reason }),
          ...(c === undefined ? {} : { network: c.network, connection: c.status() }),
          ...(self === undefined ? {} : { self }),
          ...(as === undefined ? {} : { as }),
        };
      });
  }

  /** Whom a connector's login says it is, if it offers one that says (D120). */
  private loginAs(id: string): string | undefined {
    try {
      return this.host.instance(id)?.login?.state().as;
    } catch {
      return undefined;
    }
  }

  /**
   * A connector's surfaces (bot-os.md D63): the chats it can see, latest first, matching the
   * query; undefined for a node that is not a connector. Rejects when the connector cannot tell
   * now (not connected).
   */
  /** The people a connector has seen (D167), most recently first; undefined for no connector. */
  people(id: string, query: PeopleQuery = {}): PeopleView | undefined {
    const node = this.host.nodes().find((n) => n.id === id);
    if (node === undefined || !node.manifest.kinds.includes('connector')) return undefined;
    const c = this.host.account(id).connection;
    if (c === undefined) return { running: false, people: [] };
    return { running: true, people: c.people?.(query) ?? [] };
  }

  async surfaces(
    id: string,
    query: SurfaceQuery = {},
    peers = false
  ): Promise<SurfacesView | undefined> {
    const node = this.host.nodes().find((n) => n.id === id);
    if (node === undefined || !node.manifest.kinds.includes('connector')) return undefined;
    const c = this.host.account(id).connection;
    if (c === undefined) return { running: false, listed: false, surfaces: [] };
    if (c.surfaces === undefined) return { running: true, listed: false, surfaces: [] };
    const surfaces = await c.surfaces(query);
    if (!peers) return { running: true, listed: true, surfaces };
    // Every name the connector lists a chat by: a peer's chat it lists is not the peer's to add.
    // Nor is its own account's (a bot's private chat with the owner, seen from the owner's account:
    // a chat with itself), by its name as itself, bare or as a `@username`.
    const me = c.self();
    const names = new Set(
      [
        ...surfaces.flatMap((s) => [s.id, ...(s.aliases ?? [])]),
        ...(me === undefined ? [] : [me, me.startsWith('@') ? me : `@${me}`]),
      ].map((n) => n.toLowerCase())
    );
    const others = this.host
      .nodes()
      .filter((n) => n.id !== id && n.manifest.kinds.includes('connector'))
      .map((n) => ({ id: n.id, connection: this.host.account(n.id).connection }))
      .filter((p) => p.connection?.network === c.network && p.connection.surfaces !== undefined);
    const found = await Promise.all(
      others.map(async (p) => ({
        connector: p.id,
        // A peer that cannot tell now (not connected) lists nothing.
        surfaces: ((await p.connection?.surfaces?.(query).catch(() => [])) ?? []).filter(
          (s) => ![s.id, ...(s.aliases ?? [])].some((n) => names.has(n.toLowerCase()))
        ),
      }))
    );
    return {
      running: true,
      listed: true,
      surfaces,
      peers: found.filter((p) => p.surfaces.length > 0),
    };
  }

  /**
   * What waits in a connector's queue (bot-os.md D73): each queued send, when it may go, and the
   * nodes that asked for it with their cancel conditions; and the sends it coalesced since the
   * start, with the pairs of nodes that shared them, which may say two nodes duplicate a piece of
   * logic. Undefined for a node that is not a connector.
   */
  queue(
    id: string
  ): { account?: string; entries: QueueEntryView[]; coalesced: CoalescedView } | undefined {
    if (!this.isConnector(id)) return undefined;
    const { account } = this.host.account(id);
    return {
      ...(account === undefined ? {} : { account }),
      entries: this.host.queue(id),
      coalesced: this.host.coalesced(id),
    };
  }

  private isConnector(id: string): boolean {
    return this.host.nodes().some((n) => n.id === id && n.manifest.kinds.includes('connector'));
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

  /**
   * A read the plugin declares, as its instance offers it now; one that declares an input is given
   * `input` (an object, its fields its arguments) as its schema makes it.
   */
  /**
   * Hears the nodes changed (D173), each set coalesced and propagated along interface edges, for
   * the views' live updates (`GET /changes`); the way to stop. Without the core's, never.
   */
  changes(listener: (nodes: ReadonlySet<string>) => void): () => void {
    return this.host.changes?.(listener) ?? (() => {});
  }

  /**
   * A view node's stylesheet as served (D175): scoped to its view's body; undefined for a node
   * that has none.
   */
  viewSheet(id: string): string | undefined {
    const style = this.host.viewStyle?.(id);
    return style === undefined ? undefined : scopedSheet(style, id);
  }

  /** A picture a view node's stylesheet points at (D175): its bytes and type, or undefined. */
  viewPicture(id: string, ref: string): { data: Uint8Array; type: string } | undefined {
    const f = this.host.viewStyle?.(id)?.files[ref];
    if (f === undefined) return undefined;
    try {
      return { data: fs.readFileSync(f.file), type: f.type };
    } catch {
      return undefined;
    }
  }

  /** Counts a read the control API served of a node (D172), in its cost. */
  served(id: string, ms: number, bytes: number): void {
    if (this.manifest(id) !== undefined) this.host.served?.(id, ms, bytes);
  }

  read(id: string, name: string, input?: unknown): { value: unknown } | { error: string } {
    const m = this.manifest(id);
    if (m === undefined) return { error: `no plugin ${id}` };
    const declared = m.interface.state?.[name];
    if (declared === undefined) return { error: `${id} declares no read ${name}` };
    let given: unknown;
    if (declared.input !== undefined) {
      const parsed = declared.input.safeParse(input ?? {});
      if (!parsed.success) return { error: issues(parsed.error.issues) };
      given = parsed.data;
    }
    const fn = this.host.instance(id)?.interface?.state?.[name] as
      ((input?: unknown) => unknown) | undefined;
    if (typeof fn !== 'function') return { error: `${id} is not running` };
    try {
      return { value: declared.input === undefined ? fn() : fn(given) };
    } catch (e) {
      return { error: message(e) };
    }
  }

  /**
   * The state a node keeps, for the viewer (bot-os.md D72): undefined for a node that offers none,
   * an error for one not running or whose view fails.
   */
  view(id: string): { value: StateView } | { error: string } | undefined {
    if (this.manifest(id) === undefined) return undefined;
    const i = this.host.instance(id);
    if (i === undefined) return { error: `${id} is not running` };
    if (i.view === undefined) return undefined;
    try {
      return { value: i.view.read() };
    } catch (e) {
      return { error: message(e) };
    }
  }

  /** A node's files (D149): undefined for no node. */
  files(id: string): FilesView | undefined {
    const files = this.host.files?.(id);
    if (files === undefined) return undefined;
    return { files: files.list(), used: files.used(), limits: files.limit };
  }

  /**
   * One of a node's files, its bytes and what is kept of it: undefined for no node or no such
   * file. Throws for a name no file may have.
   */
  file(id: string, name: string): { info: StoreFileInfo; bytes: Uint8Array } | undefined {
    const files = this.host.files?.(id);
    const info = files?.info(name);
    const bytes = info === undefined ? undefined : files?.read(name);
    return info === undefined || bytes === undefined ? undefined : { info, bytes };
  }

  /**
   * One line of a node's state for its card, if it runs and offers one; for a connector, the sends
   * its queue coalesced since the start, if any (bot-os.md D73).
   */
  private summary(id: string): string | undefined {
    let line: string | undefined;
    try {
      line = this.host.instance(id)?.view?.summary?.();
    } catch (e) {
      this.host.error(id, `summary: ${message(e)}`);
    }
    const merged = this.isConnector(id) ? coalescedText(this.host.coalesced(id)) : undefined;
    return [line, merged].filter((x) => x !== undefined).join(' · ') || undefined;
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
    if (!parsed.success) return { error: issues(parsed.error.issues) };
    const fn = this.host.instance(id)?.interface?.actions?.[name] as
      ((input: unknown, call: ActionCall) => unknown) | undefined;
    if (typeof fn !== 'function') return { error: `${id} is not running` };
    try {
      // The owner calls it: no node (D117).
      return { output: await fn(parsed.data, {}) };
    } catch (e) {
      return { error: message(e), refused: true };
    }
  }

  /**
   * A connector's login (bot-os.md D116): where it stands; undefined for a node that offers none,
   * an error for one not running.
   */
  login(id: string): { value: LoginState } | { error: string } | undefined {
    const m = this.manifest(id);
    if (m === undefined || !m.login) return undefined;
    const login = this.host.instance(id)?.login;
    if (login === undefined) return { error: `${id} is not running` };
    try {
      return { value: this.atRest(id, this.redacted(login.state())) };
    } catch (e) {
      return { error: this.redact(message(e)) };
    }
  }

  /**
   * A login's state with where its credentials stand at rest (D123): `atRest`, sealed or in clear,
   * once it holds some; and, while it needs a login because its kept one did not open, why.
   */
  private atRest(id: string, state: LoginState): LoginState {
    const rest = this.host.sealed?.(id);
    if (rest === undefined) return state;
    return {
      ...state,
      ...(state.status === 'done' ? { atRest: rest.sealed ? 'sealed' : 'clear' } : {}),
      ...(state.status === 'needed' && state.error === undefined && rest.unreadable !== undefined
        ? { error: `its kept login does not open: ${rest.unreadable}` }
        : {}),
    };
  }

  /**
   * An action of a connector's login, with the step's fields (bot-os.md D116): where it stands
   * next, recorded (`core.login`: the action and where it led, never the values); undefined for a
   * node that offers none, an error for one not running or an action it does not offer now.
   */
  async loginAct(
    id: string,
    action: string,
    values: Readonly<Record<string, string>>
  ): Promise<{ value: LoginState } | { error: string } | undefined> {
    const m = this.manifest(id);
    if (m === undefined || !m.login) return undefined;
    const login = this.host.instance(id)?.login;
    if (login === undefined) return { error: `${id} is not running` };
    try {
      const state = this.atRest(id, this.redacted(await login.act(action, values)));
      this.host.recordLogin?.({
        node: id,
        action,
        status: state.status,
        ...(state.as === undefined ? {} : { as: state.as }),
        ...(state.error === undefined ? {} : { error: state.error }),
      });
      return { value: state };
    } catch (e) {
      return { error: this.redact(message(e)) };
    }
  }

  private redact(text: string): string {
    return this.host.redact?.(text) ?? text;
  }

  /** A login's state with its texts redacted: its error, above all. */
  private redacted(s: LoginState): LoginState {
    return {
      ...s,
      ...(s.error === undefined ? {} : { error: this.redact(s.error) }),
      ...(s.note === undefined ? {} : { note: this.redact(s.note) }),
    };
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
