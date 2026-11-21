/**
 * The shell's core (docs/bot-os-api.md §3): it registers plugins, checks their manifests and the
 * order their requirements make, and runs their lifecycle. It knows nothing of any game.
 *
 * - Errors of the deployment (a bad manifest, two plugins with one id, a missing requirement, a
 *   cycle) fail `start` before any plugin runs, with a StartError naming each.
 * - Errors at runtime (`create` or `start` throws) fail that plugin and those that require it, with
 *   why; every other plugin starts. The owner is told, and the failure is logged (`core.plugin`).
 * - Once every plugin has started, each hears `ready`, in load order (a replay of its history, for
 *   the plugins that use it); one that throws fails, stopped, with those that require it.
 * - `stop` runs in the reverse order, keeping what each plugin's `serialise` returns, which its
 *   next `create` gets back as `restored`.
 * - Every change of a node's state is logged (`core.plugin`), but those a start or a stop of the
 *   whole instance makes as expected, folded into one record each (`core.instance`, `started` and
 *   `stopped`, bot-os.md D114); what goes wrong in them is logged node by node.
 * - A node's state (bot-os.md D64): a node `disabled` in the graph, or `stopped` (a safety stop, a
 *   drift pause, the owner's kill or stop, kept in its instance as `_stop.json` across restarts),
 *   is not started, nor is one whose required ports bind a node down (`inactive`, derived at the
 *   load). A stop made while it runs holds it until the owner clears it in the editor and applies,
 *   and shuts down at once every node it makes inactive by that same rule (#29).
 * - The plugins load in the background, once the servers are up (bot-os.md D143, `boot.ts`): a
 *   package or module that failed to load is told to the core (`failedToLoad`), and the nodes of
 *   its plugins are held out of the graph it runs (`unloaded`, with why), with those that need
 *   them (`inactive`), rather than refusing the whole graph. Until the load, the saved graph's
 *   nodes are `loading`. A node's `create`, `start` or `ready` that does not settle within
 *   `startTimeoutMs` fails that node alone, and the start goes on.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { type z } from 'zod';
import { answerWindowMs, type BackoffView, readAnswer } from './answers.ts';
import { Bus, type BusEvent, type BusHandle } from './bus.ts';
import { type Clock } from './clock.ts';
import {
  type Answer,
  type Asker,
  type ChatCommand,
  type CommandButton,
  type CommandHandler,
  photoLabel,
  photoRefusal,
} from './commands.ts';
import { type Connector, handleOf, type Inbound, type ReadFilter } from './connector.ts';
import { Controls, type StopRecord, type StopSource } from './controls.ts';
import { Costs, type NodeCost, type OwnCost } from './costs.ts';
import { DEFAULT_DRIFT, type DriftCounts, DriftMonitor, type DriftRecord } from './drift.ts';
import { type EventReader, type LogCursor, type LogEntry, type LogTail } from './event-log.ts';
import {
  type Binding,
  type CommandsBinding,
  defaultGraph,
  downText,
  type Graph,
  GRAPH_VERSION,
  GraphError,
  type GraphInput,
  loadOrder,
  nodeInputs,
  nodeManifest,
  nodeStates,
  requiredOf,
  type ResolvedNode,
  resolveGraph,
} from './graph.ts';
import {
  type GraphCheck,
  type GraphFile,
  type GraphProblem,
  locateProblem,
  type SaveBy,
} from './graph-file.ts';
import {
  describeInputs,
  describePlugin,
  type PluginView,
  type PortView,
  stableJson,
} from './graph-view.ts';
import { holdUnloaded, type Unloaded } from './held.ts';
import { type InstanceInfo, InstanceRegistry } from './instance-registry.ts';
import { type Manifest, parseManifest, SECRET_NAME } from './manifest.ts';
import { type Notice, Notices } from './notices.ts';
import {
  Outbox,
  type OutboxHandle,
  type QueuedSend,
  type QueueRecord,
  type SenderPolicy,
  type SendFailedRecord,
  type SendRecord,
} from './outbox.ts';
import { CORE_COMMANDS, coreCommands } from './owner-commands.ts';
import {
  type ActionCall,
  type EventQuery,
  type Instance,
  type Logger,
  type Plugin,
  type PluginContext,
  type PluginInterface,
} from './plugin.ts';
import { type InputPort, OWNER } from './ports.ts';
import { holds } from './react.ts';
import { type Render, resvgRender } from './render.ts';
import { type KeptTimer, PluginScheduler } from './scheduler.ts';
import { SealedStore } from './sealed-store.ts';
import { Sealer, type Secrets, SecretStore } from './secrets.ts';
import { hideSensitive, openSensitive, sealSensitive } from './sensitive.ts';
import { PluginSettings, SETTINGS_DOC, SettingsRegistry } from './settings.ts';
import { CORE_STORE, type FileLimits, type Migration, Stores } from './store.ts';
import { Summaries, type SummarySection, type SummaryWindow } from './summary.ts';

/**
 * A node's state (bot-os.md D64): `disabled` by the owner, `stopped` by exception (a safety stop,
 * drift, the owner's kill or stop; `stop` says which) or at shutdown, `inactive` for a required
 * port bound to a node down, `failed` with why; otherwise on its way through its lifecycle.
 */
export type PluginState =
  | 'registered'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'disabled'
  | 'inactive';

export interface PluginStatus {
  id: string;
  state: PluginState;
  /** Why it failed, is stopped, or is inactive. */
  reason?: string;
  /** Its stop, kept in its instance, while it is stopped by exception. */
  stop?: StopRecord;
}

/**
 * A package or module of plugins that failed to load (bot-os.md D143): its import threw (a
 * SyntaxError of Node's type stripping, a top-level error), never settled, or what it exports is
 * not plugins.
 */
export interface LoadFailure {
  /** What failed: `package <its specifier>`, or `module <its id>`. */
  source: string;
  /** The module's id, for a module: the owner reinstalls or rolls it back on the Modules page. */
  module?: string;
  error: string;
}

/**
 * A node of the saved graph that the core does not run (bot-os.md D143): `loading` while the
 * plugins load; `unloaded`, its plugin not loaded (`failures`, what failed to load that may have
 * offered it); `inactive`, it needs a node that is unloaded; `disabled` in the graph.
 */
export interface HeldNode {
  id: string;
  plugin: string;
  state: 'loading' | 'unloaded' | 'inactive' | 'disabled';
  reason?: string;
  failures?: LoadFailure[];
}

/**
 * Where the instance's start is (bot-os.md D143): its plugins `loading`, its nodes `starting`, or
 * `started`; and what failed to load.
 */
export interface BootView {
  phase: 'loading' | 'starting' | 'started';
  failures: LoadFailure[];
}

/** A record the core writes to the event log. */
export interface CoreRecord {
  type: `core.${string}`;
  t: number;
  [field: string]: unknown;
}

export interface CoreOptions {
  clock: Clock;
  /** Where log lines go (stdout). */
  print?: (line: string) => void;
  /**
   * The release the instance runs and the commit its image was built from (`GET /instance`), for
   * the owner's start notice (bot-os.md D92); none in tests.
   */
  build?: { version: string; commit?: string };
  /**
   * Where the core's records and every event published go (the event log). What it returns, if it
   * is where the log put the record (`LogPosition`, bot-os.md D72), the bus hands its subscribers
   * with the event, for those that keep a cursor into the log.
   */
  record?: (
    r: CoreRecord | BusEvent | SendRecord | QueueRecord | SendFailedRecord | DriftRecord
  ) => unknown;
  /**
   * Each plugin instance's configuration, by its id, as the deployment sets it: checked against
   * its plugin's `config` schema at load, a bad value naming the instance and the key. A node of
   * the graph may carry its own, which comes first.
   */
  config?: Record<string, unknown>;
  /**
   * The instance's graph (§2.1): the plugin instances to run, of the plugins registered, and the
   * edges between their ports. Without it, the default graph: one node per plugin registered, its
   * id the plugin's, each input bound as its manifest says (the programmatic wiring); or a
   * function of that default graph, for a wiring that adds to it (`withInstances`).
   */
  graph?: GraphInput | ((defaults: Graph) => GraphInput);
  /**
   * The core's own runtime settings, as a zod object (the owner's summaries, today), kept in its
   * own store beside the plugins' and named `core` in the registry.
   */
  settings?: z.ZodObject;
  /**
   * The Docker secrets (§4.9): given to the connectors that declare them, and redacted from all the
   * core prints, records and tells.
   */
  secrets?: Secrets;
  /** Whether events are checked against their schemas: by default, outside production. */
  validateEvents?: boolean;
  /**
   * The instances the saved graph references (bot-os-api.md §2.2), beyond the running graph's: kept
   * from the orphans' expiry. Undefined when the saved graph cannot be read: nothing is deleted then.
   */
  referenced?: () => ReadonlySet<string> | undefined;
  /**
   * The saved graph's file (§2.3), read at load when no `graph` is given: missing, an empty graph;
   * refused, no nodes, with why (`graphProblems`). Its nodes' instances are `referenced` by default.
   */
  graphFile?: GraphFile;
  /**
   * The way back to the owner's main card, at the foot of the core's own cards (§4.11), on a chat
   * surface whose config names none (a surface's own `home` wins).
   */
  home?: CommandButton;
  /**
   * The data volume: each instance's store is `<dataDir>/instances/<instance>/`, the core's own
   * `<dataDir>/core/`. Without it the stores live in memory, for tests.
   */
  dataDir?: string;
  /**
   * Without a data volume, the documents each instance's store holds as the core is made, by
   * instance and name: the state a run of the dev kit starts from (packages/core/src/devkit.ts).
   * Ignored with one.
   */
  documents?: Record<string, Record<string, unknown>>;
  /**
   * How much each instance's files may take, in bytes (`ctx.store.files`, bot-os.md D149): a file,
   * and all of an instance's together; the core's defaults (`DEFAULT_FILE_LIMITS`, 16 MB and
   * 256 MB) for what is not said.
   */
  fileLimits?: Partial<FileLimits>;
  /** How long a plugin's `stop` may take before the next one stops. */
  stopTimeoutMs?: number;
  /**
   * How long a node's `create` and `start`, then its `ready`, may take before it fails, alone, and
   * the start goes on (bot-os.md D143): 60 s by default.
   */
  startTimeoutMs?: number;
  /**
   * Whether a plugin whose manifest is `archived` (bot-os.md D32) may run: never in an instance,
   * whose wiring leaves this unset; only in a test, the dev kit or a manual-test tool that says so.
   */
  allowArchived?: boolean;
  /** The render service the plugins get (§4.13): the shell's, on resvg, by default. */
  render?: Render;
  /**
   * The event log, read back (§4.4): what each plugin's `ctx.events` reads. Without it, a plugin
   * reads no history.
   */
  events?: EventReader;
}

/** A deployment refused; `warnings`, what the graph's check warns of as well (bot-os.md D89). */
export class StartError extends Error {
  readonly warnings: string[];
  constructor(message: string, warnings: string[] = []) {
    super(message);
    this.warnings = warnings;
  }
}

/**
 * A plugin the instance offers: the image's, or a module's (`module`), as the editor shows it
 * (`describePlugin`: its ports, schemas, interface, secrets and event types).
 */
export interface AvailablePlugin extends PluginView {
  id: string;
  /** The module that offers it; none for the image's own. */
  module?: string;
}

/** A graph with no node: the instance's when it has none saved. */
const EMPTY_GRAPH: Graph = { version: GRAPH_VERSION, nodes: [], edges: [] };

/** A graph compiled: its instances in load order, the graph as held, and their bus. */
interface Compiled {
  entries: Map<string, Entry>;
  graph: Graph;
  bus: Bus;
  /** What the graph's check warns of (bot-os.md D89): it refuses nothing. */
  warnings: string[];
  /** The nodes held out, their plugin not loaded, or needing one that is not (D143). */
  held: Unloaded[];
}

interface Entry {
  /** The instance's id: the node's. */
  id: string;
  plugin: Plugin;
  manifest: Manifest;
  /** Its node of the graph: its account, and what its inputs are bound to. */
  node: ResolvedNode;
  /** Its configuration, as its schema made it. */
  config: Readonly<Record<string, unknown>>;
  status: PluginStatus;
  instance?: Instance;
  scheduler?: PluginScheduler;
  /** Its instance is up: started, neither failed nor shut down (it may be stopped since). */
  up?: boolean;
}

/**
 * The states of a node that reads (bot-os.md D66): about to start, starting or running; not one
 * disabled, stopped, inactive, failed or shutting down.
 */
const READING: ReadonlySet<PluginState> = new Set(['registered', 'starting', 'running']);

/**
 * The changes of state a start or a stop of the whole instance makes as expected, folded into its
 * summary (D114), as is a `stopped` with no reason; the others are logged one by one.
 */
const FOLDED: ReadonlySet<string> = new Set([
  'starting',
  'running',
  'stopping',
  'disabled',
  'inactive',
]);

/** The core's own store, beside the instances'. */
const CORE = CORE_STORE;
/** The core's document, in each instance's store, of its stop (bot-os.md D64). */
export const STOP_DOC = '_stop';
/** How often the orphaned instances are looked for: daily. */
const SWEEP_MS = 86_400_000;

/** The core's document, in each plugin's store, of what it serialised at its last stop. */
const RESTORE = '_restore';
/** The core's document, in each plugin's store, of its timers. */
const TIMERS = '_timers';
/**
 * The core's document of the package or module that last offered each plugin, by its id (D143):
 * a node of a plugin that did not load is told which failure took it.
 */
const SOURCES_DOC = 'plugin-sources';
/** How long a node's start may take by default (D143). */
const START_TIMEOUT_MS = 60_000;

/** A start that did not settle in time (D143). */
class StartTimeout extends Error {}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Core {
  private readonly o: CoreOptions;
  private readonly plugins: Plugin[] = [];
  /** The module each plugin registered from a module came from, and its version. */
  private readonly origins = new Map<Plugin, { module: string; version?: string }>();
  /** Where each plugin registered came from (D143): `package <name>` or `module <id>`. */
  private readonly sources = new Map<Plugin, string>();
  /** The packages and modules that failed to load at this start (D143). */
  private readonly failures: LoadFailure[] = [];
  /** The nodes of the saved graph the core does not run, the load held back (D143). */
  private heldNodes: HeldNode[] = [];
  /** The wiring loads the plugins in the background (D143): `booting` until the load. */
  private bootPending = false;
  /** Every node has been started (or failed to), and heard `ready`. */
  private startedAll = false;
  /** The instance stops: a start under way starts no more nodes. */
  private stopping = false;
  /** By id, in load order once started. */
  private entries = new Map<string, Entry>();
  /** The graph as loaded, every edge written out (§2.1). */
  private loadedGraph?: Graph;
  private started = false;
  /**
   * The instance starts or stops as a whole (bot-os.md D114): the nodes' expected changes of state
   * are folded into its summary, not logged one by one.
   */
  private folding = false;
  private loaded = false;
  /** Every plugin's settings, for the control surfaces (§2, P11). */
  readonly settings: SettingsRegistry;
  private readonly stores: Stores;
  private bus: Bus;
  /** Why the saved graph was refused at this start (§2.3). */
  private refused: GraphProblem[] = [];
  private readonly outboxes = new Map<string, Outbox>();
  private readonly driftMonitor: DriftMonitor;
  /** The secrets the core stores itself, encrypted at rest (§4.9); none without a data volume. */
  readonly secretStore?: SecretStore;
  /** What seals the connectors' kept credentials at rest (D123), with the Docker secrets. */
  private readonly sealer: Sealer | undefined;
  /** Each connector's sealed view of its store (`ctx.secrets.store`), by node. */
  private readonly sealedStores = new Map<string, SealedStore>();
  /** The owner's controls (§4.11), from which every control surface is made. */
  readonly controls: Controls;
  /** The instances, apart from the nodes (§2.2). */
  private readonly registry: InstanceRegistry;
  private sweepTimer?: ReturnType<Clock['setTimeout']>;
  /** Each node's handlers' time, where the core dispatches to them (bot-os.md D77). */
  private readonly costs = new Costs();
  /** The shutdowns a runtime stop's cascade started (D64, #29): `stop` waits for them. */
  private shutting: Promise<void> = Promise.resolve();
  /** The owner's notices (D91): what needs their attention, for the nodes that tell them. */
  private readonly noticeFeed: Notices;
  /** The owner's summary (D92): its contributors, and the core's own counts. */
  private readonly summaries: Summaries;

  constructor(given: CoreOptions) {
    const secrets = given.secrets;
    // Whatever the core prints or records passes through the redaction of the secrets.
    this.o =
      secrets === undefined
        ? given
        : {
            ...given,
            ...(given.print === undefined
              ? {}
              : { print: (line: string) => given.print?.(secrets.redact(line)) }),
            ...(given.record === undefined
              ? {}
              : {
                  record: (r: Parameters<NonNullable<CoreOptions['record']>>[0]) =>
                    given.record?.(secrets.redactDeep(r)),
                }),
          };
    const options = this.o;
    this.noticeFeed = new Notices({
      error: (plugin, line) => this.logger(plugin).error(line),
      ...(secrets === undefined ? {} : { redact: (text: string) => secrets.redact(text) }),
    });
    this.summaries = new Summaries({
      clock: options.clock,
      ...(options.build === undefined ? {} : { build: options.build }),
      nodes: () =>
        [...this.entries.values()].map((e) => ({
          id: e.id,
          plugin: e.manifest.id,
          state: e.status.state,
          ...(e.status.reason === undefined ? {} : { reason: e.status.reason }),
        })),
      tellers: () =>
        new Set([...this.entries.values()].filter((e) => e.manifest.notices).map((e) => e.id)),
      error: (node, line) => this.logger(node).error(line),
    });
    this.stores = new Stores(options.dataDir, {
      now: () => options.clock.now(),
      ...(options.fileLimits === undefined ? {} : { fileLimits: options.fileLimits }),
    });
    if (options.dataDir === undefined)
      for (const [id, docs] of Object.entries(options.documents ?? {})) {
        const store = this.stores.open(id);
        for (const [name, value] of Object.entries(docs)) store.write(name, value);
      }
    this.sealer = secrets === undefined ? undefined : new Sealer(secrets);
    const dir = this.stores.dirOf(CORE);
    if (secrets !== undefined && dir !== undefined)
      this.secretStore = new SecretStore(path.join(dir, 'secrets'), secrets);
    this.registry = new InstanceRegistry(this.stores, () => options.clock.now());
    this.settings = new SettingsRegistry((plugin) => {
      const entry = this.entries.get(plugin);
      try {
        entry?.instance?.settingsChanged?.();
      } catch (e) {
        this.logger(plugin).error(`settingsChanged: ${message(e)}`);
      }
    });
    this.controls = new Controls({
      settings: this.settings,
      store: this.stores.open(CORE),
      nodes: () => this.nodes(),
      status: (id) => this.state(id),
      instance: (id) => {
        const e = this.entries.get(id);
        return e?.up === true ? e.instance : undefined;
      },
      stopNode: (id, reason) => this.stopNode(id, reason, 'owner'),
      clearStop: (id) => this.clearStop(id),
      queue: (id) => {
        const account = this.entries.get(id)?.node.account;
        return account === undefined ? [] : (this.outboxes.get(account)?.pending() ?? []);
      },
      coalesced: (id) => {
        const account = this.entries.get(id)?.node.account;
        const outbox = account === undefined ? undefined : this.outboxes.get(account);
        return outbox?.coalesced() ?? { count: 0, pairs: [] };
      },
      record: (fields) => this.o.record?.({ type: 'core.power', t: this.o.clock.now(), ...fields }),
      error: (id, line) => this.logger(id).error(line),
      account: (id) => {
        const account = this.entries.get(id)?.node.account;
        const connection = this.connector(id);
        return {
          ...(account === undefined ? {} : { account }),
          ...(connection === undefined ? {} : { connection }),
        };
      },
      drift: () => this.drift(),
      cost: (id) => this.cost(id),
      backoffs: (id) => this.backoffs(id),
      redact: (text) => this.o.secrets?.redact(text) ?? text,
      sealed: (id) => this.sealedStores.get(id)?.state(),
      recordLogin: (fields) =>
        this.o.record?.({ type: 'core.login', t: this.o.clock.now(), ...fields }),
      held: () => this.held(),
      boot: () => this.boot(),
      files: (id) => {
        const instance = this.entries.get(id)?.node.instance;
        return instance === undefined ? undefined : this.stores.internal(instance).files;
      },
    });
    this.driftMonitor = new DriftMonitor({
      clock: options.clock,
      ...(options.record === undefined ? {} : { record: options.record }),
      notice: (parser, text, detail) => this.notice({ kind: 'drift', node: parser, text, detail }),
      threshold: (parser) => this.entries.get(parser)?.manifest.drift ?? DEFAULT_DRIFT,
      version: (parser) => {
        const e = this.entries.get(parser);
        return e === undefined ? undefined : this.versionOf(e);
      },
      pause: (parser, reason) => {
        const paused = this.stopActorsOf(parser, reason);
        this.notice({
          kind: 'drift',
          node: parser,
          text:
            paused.length === 0
              ? `${reason}; nothing that acts depends on it`
              : `${reason}; stopped ${paused.join(', ')} until you clear the stop in the editor`,
          detail: { reason, paused },
        });
        return paused;
      },
    });
    this.bus = this.newBus();
  }

  private newBus(): Bus {
    return new Bus({
      now: () => this.o.clock.now(),
      ...(this.o.record === undefined ? {} : { record: this.o.record }),
      validate: this.o.validateEvents ?? process.env['NODE_ENV'] !== 'production',
      time: (plugin, fn) => this.costs.time(plugin, fn),
    });
  }

  /** Adds plugins to start; only before `start`. */
  register(...plugins: Plugin[]): void {
    if (this.started) throw new Error('plugins are registered before the core starts');
    this.plugins.push(...plugins);
  }

  /**
   * Adds the plugins a module offers (§7), as `register` does, remembering their module and the
   * version of it loaded.
   */
  registerModule(module: string, plugins: readonly Plugin[], version?: string): void {
    this.register(...plugins);
    for (const p of plugins) {
      this.origins.set(p, { module, ...(version === undefined ? {} : { version }) });
      this.sources.set(p, `module ${module}`);
    }
  }

  /** Adds the plugins one of the image's packages offers, remembering which (D143). */
  registerPackage(name: string, plugins: readonly Plugin[]): void {
    this.register(...plugins);
    for (const p of plugins) this.sources.set(p, `package ${name}`);
  }

  /**
   * The wiring loads the plugins in the background (D143): until the load, the saved graph's nodes
   * are `loading`, and a graph is not checked (the plugins it names may not be in yet).
   */
  booting(): void {
    this.bootPending = true;
  }

  /**
   * Packages or modules that failed to load (D143), before the load: each printed, logged
   * (`core.load`) and raised as a notice (`load-failed`); the nodes of the plugins they would have
   * offered are held out of the graph, not the whole graph refused.
   */
  failedToLoad(...failures: LoadFailure[]): void {
    if (this.loaded) throw new Error('a failed load is told before the core loads');
    for (const f of failures) {
      const failure = { ...f, error: this.o.secrets?.redact(f.error) ?? f.error };
      this.failures.push(failure);
      (this.o.print ?? (() => {}))(`core: ${failure.source} failed to load: ${failure.error}`);
      this.o.record?.({
        type: 'core.load',
        t: this.o.clock.now(),
        event: 'failed',
        source: failure.source,
        error: failure.error,
      });
      this.notice({
        kind: 'load-failed',
        text: `${failure.source} failed to load: ${failure.error}`,
        detail: { ...failure },
      });
    }
  }

  /** Where the start is, and what failed to load (D143). */
  boot(): BootView {
    return {
      phase: !this.loaded ? 'loading' : this.startedAll ? 'started' : 'starting',
      failures: this.failures.map((f) => ({ ...f })),
    };
  }

  /**
   * The nodes of the saved graph the core does not run (D143): while the plugins load, every one
   * (`loading`, or `disabled`); then those the load held back, their plugin not loaded.
   */
  held(): HeldNode[] {
    if (this.loaded) return structuredClone(this.heldNodes);
    if (!this.bootPending) return [];
    const raw = this.o.graph === undefined ? this.savedGraph() : undefined;
    const nodes = isObject(raw) && Array.isArray(raw['nodes']) ? (raw['nodes'] as unknown[]) : [];
    return nodes.flatMap((n): HeldNode[] =>
      isObject(n) && typeof n['id'] === 'string' && typeof n['plugin'] === 'string'
        ? [
            {
              id: n['id'],
              plugin: n['plugin'],
              state: n['disabled'] === true ? 'disabled' : 'loading',
            },
          ]
        : []
    );
  }

  /**
   * An error nothing caught (D143): an unhandled rejection or an uncaught exception, from a plugin
   * most likely. The process goes on: it is printed, logged (`core.uncaught`) and raised as a
   * notice (`uncaught`), naming where it came from when the wiring can tell (`from`).
   */
  uncaught(error: unknown, from?: string): void {
    const text = this.o.secrets?.redact(message(error)) ?? message(error);
    const where = from === undefined ? '' : ` (${from})`;
    const stack = error instanceof Error ? error.stack : undefined;
    (this.o.print ?? (() => {}))(
      `core: uncaught error${where}: ${this.o.secrets?.redact(stack ?? text) ?? stack ?? text}`
    );
    this.o.record?.({
      type: 'core.uncaught',
      t: this.o.clock.now(),
      error: text,
      ...(from === undefined ? {} : { from }),
    });
    this.notice({
      kind: 'uncaught',
      text: `an error nothing caught${where}: ${text}`,
      detail: { error: text, ...(from === undefined ? {} : { from }) },
    });
  }

  /**
   * The version a node runs: its module's, as loaded (`GET /modules`); the release's for one of
   * the image's own (`GET /instance`); its manifest's when neither is known (a test).
   */
  private versionOf(e: Entry): string {
    const origin = this.origins.get(e.plugin);
    return (origin === undefined ? this.o.build?.version : origin.version) ?? e.manifest.version;
  }

  /**
   * The plugins the instance offers (§7): the image's and the modules', whether or not a node of
   * the graph runs one, for the editor to list. A plugin whose manifest does not read is left out
   * (the load says why).
   */
  available(): AvailablePlugin[] {
    return this.plugins.flatMap((p) => {
      try {
        const m = parseManifest(p.manifest);
        const module = this.origins.get(p)?.module;
        return [{ id: m.id, ...describePlugin(m), ...(module === undefined ? {} : { module }) }];
      } catch {
        return [];
      }
    });
  }

  /** Each plugin's state, in load order. */
  status(): PluginStatus[] {
    return [...this.entries.values()].map((e) => ({ ...e.status }));
  }

  /**
   * What a node costs (bot-os.md D77): its handlers' time where the core dispatched to them, and
   * what its instance says of its own while it is up (a script's worker).
   */
  cost(id: string): NodeCost | undefined {
    const e = this.entries.get(id);
    if (e === undefined) return undefined;
    let own: OwnCost | undefined;
    try {
      own = e.up === true ? e.instance?.cost?.() : undefined;
    } catch (err) {
      this.logger(id).error(`cost: ${message(err)}`);
    }
    return { dispatch: this.costs.of(id), ...(own === undefined ? {} : { own }) };
  }

  /** One plugin's state, or undefined for an id not loaded. */
  state(id: string): PluginStatus | undefined {
    const e = this.entries.get(id);
    return e === undefined ? undefined : { ...e.status };
  }

  /**
   * The connector of a running (or stopped since it started) connector plugin, sends included: for
   * the instance's wiring, which sends for the app until the outbox does. Plugins get handles.
   */
  connector(id: string): Connector | undefined {
    const e = this.entries.get(id);
    return e?.up === true ? e.instance?.connector : undefined;
  }

  /**
   * The outbox of an account (§4.6): the plugins' sends on it, each within its reach and mode.
   * Made at the first ask, so that the instance's wiring can hold it before the core starts.
   */
  outbox(account: string): Outbox {
    let outbox = this.outboxes.get(account);
    if (outbox === undefined) {
      const connector = (): Connector | undefined => {
        for (const e of this.entries.values())
          if (e.node.account === account) return this.connector(e.id);
        return undefined;
      };
      outbox = new Outbox({
        account,
        connector,
        limits: () => connector()?.limits,
        clock: this.o.clock,
        policy: (plugin, port) => this.policyOf(plugin, account, port),
        record: (r) => {
          this.counted(r);
          this.o.record?.(r);
        },
        notice: (n) => this.notice(n),
        // The send-queue watchdog (D93): an actor's sends to a chat a parser reads, paused as drift
        // pauses (P5).
        watch: (plugin, chat) => this.awaitsAnswers(plugin, account, chat),
        // A node that tells the owner (owner-notice) is not told of its own failed sends (D95).
        quiet: (plugin) => this.entries.get(plugin)?.manifest.notices === true,
        title: (chat) => connector()?.chatTitle?.(chat),
        pause: (plugin, reason) => {
          this.stopNode(plugin, reason, 'stalled');
        },
        // A send waits for the game's answer where a parser reading its chat declares one (D98).
        expects: (chat, command) => this.answerWindow(account, chat, command),
        // A queued send waits while the account connects, at the start too (D108).
        connection: () => this.connection(account),
      });
      this.outboxes.set(account, outbox);
    }
    return outbox;
  }

  /**
   * Where an account's connection is (D108): `connected` when a connector of it is; `connecting`
   * while one is about to start, starts, or runs and connects (again); `down` otherwise: none, or
   * every one stopped, disabled, inactive or failed.
   */
  private connection(account: string): 'connected' | 'connecting' | 'down' {
    let connecting = false;
    for (const e of this.entries.values()) {
      if (e.node.account !== account || !e.manifest.kinds.includes('connector')) continue;
      const state = this.connector(e.id)?.status().state;
      if (state === 'connected') return 'connected';
      const s = e.status.state;
      if (s === 'registered' || s === 'starting' || (s === 'running' && state === 'connecting'))
        connecting = true;
    }
    return connecting ? 'connecting' : 'down';
  }

  /**
   * How long a send of `command` to `chat` on an account waits for the game's answer (D98): the
   * longest window of the answers declared for it by the nodes up that read that chat there;
   * undefined if none declares one.
   */
  private answerWindow(account: string, chat: string, command: string): number | undefined {
    const windows = this.chatReaders(account, chat).flatMap((e) => {
      const ms = answerWindowMs(e.manifest.answers, command);
      return ms === undefined ? [] : [ms];
    });
    return windows.length === 0 ? undefined : Math.max(...windows);
  }

  /** The nodes up that read `chat` on an account (a chat-in edge naming it, or every chat). */
  private chatReaders(account: string, chat: string): Entry[] {
    const holder = [...this.entries.values()].find((e) => e.node.account === account);
    const name = chat.toLowerCase();
    return [...this.entries.values()].filter(
      (e) =>
        e.up === true &&
        chatsOf(e.node).some(
          ([, b]) =>
            b.node === holder?.id &&
            (b.chat?.reads === '*' || (b.chat?.reads ?? []).some((r) => r.toLowerCase() === name))
        )
    );
  }

  /** A node's commands the retry-loop guard holds back, on every account (D98). */
  backoffs(id: string): BackoffView[] {
    return [...this.outboxes.values()].flatMap((o) => o.backoffs(id));
  }

  /**
   * Whether a node's sends to a chat wait for an answer, for the send-queue watchdog (D93): it acts
   * (as drift pauses only what acts, P5), and a node up that registers events reads that chat on the
   * account (a chat-in edge naming it, without case, or every chat): an answer can be heard.
   */
  private awaitsAnswers(plugin: string, account: string, chat: string): boolean {
    if (this.entries.get(plugin)?.manifest.kinds.includes('actor') !== true) return false;
    return this.chatReaders(account, chat).some((e) => e.node.manifest.games.registers.length > 0);
  }

  /**
   * A send counted for the owner's summary (D92), by node and outcome: each node it went for, and a
   * queued send dropped before it went.
   */
  private counted(r: SendRecord | QueueRecord | SendFailedRecord): void {
    if (r.type === 'core.send-failed')
      for (const node of r.plugins) this.summaries.sent(node, 'failed');
    else if (r.type === 'core.send')
      for (const node of [r.plugin, ...(r.with ?? [])]) this.summaries.sent(node, r.outcome);
    else if (r.event === 'cancelled' || r.event === 'expired')
      this.summaries.sent(r.plugin, r.event);
  }

  /**
   * What an outbox knows of a sender: what its edges to the account's connector bind (P6), each a
   * dry run or not (D64), those of its output `port` only if one is named; and whether it may send
   * now.
   */
  private policyOf(plugin: string, account: string, port?: string): SenderPolicy {
    const entry = this.entries.get(plugin);
    if (entry === undefined) return { reach: { sends: [] } };
    const holder = [...this.entries.values()].find((e) => e.node.account === account);
    const reaches = sendsOf(entry.node)
      .filter(([p, b]) => b.node === holder?.id && (port === undefined || p === port))
      .map(([p, b]) => {
        const listed = b.chat ?? { reads: [], sends: [] };
        // The spacing its output declares (D74), under its edge's own.
        const output = entry.manifest.outputs[p];
        const declared = output?.type === 'chat-out' ? output.minIntervalS : undefined;
        // An edge that names no chat, from an output that then sends to the owner's (D95, D97).
        const owner =
          output?.type === 'chat-out' && output.owner === true && listed.sends.length === 0
            ? this.connector(b.node)?.owner?.()
            : undefined;
        const chat = owner === undefined ? listed : { ...listed, sends: [owner] };
        return {
          ...chat,
          ...(declared === undefined
            ? {}
            : { minIntervalS: { ...declared, ...chat.minIntervalS } }),
          ...(b.dryRun === true ? { dryRun: true } : {}),
          // Photos let through where its output declares them (D150), as its edge may.
          ...(output?.type === 'chat-out' && output.photos === true ? { photos: true } : {}),
        };
      });
    const { state, reason } = entry.status;
    return {
      reach: reaches.length === 0 ? { sends: [] } : reaches,
      ...(state === 'stopped' && entry.up === true
        ? { held: `stopped: ${reason ?? 'stopped'}` }
        : state === 'running'
          ? {}
          : { held: `not running (${state})` }),
    };
  }

  /**
   * A connector's own declared secret, or one its config names (`configSecrets`), for its
   * context's `secrets` (§4.9). Refused for any plugin but a connector, and any other secret.
   */
  private secretFor(plugin: string, name: string): string {
    const entry = this.entries.get(plugin);
    const manifest = entry?.manifest;
    if (manifest === undefined || !manifest.kinds.includes('connector'))
      throw new Error(`${plugin} is not a connector: it receives no secret`);
    const named = manifest.configSecrets.some((key) => entry?.config[key] === name);
    if (!manifest.secrets.includes(name) && !named)
      throw new Error(`${plugin} does not declare the secret ${name}`);
    const value = this.o.secrets?.read(name);
    if (value === undefined) throw new Error(`the secret ${name} is not provided`);
    return value;
  }

  /**
   * The chat commands of the plugins up (running, or stopped since they started), in load order,
   * whatever edge serves them (§2 `interface.commands`, P11): the admin side's, every plugin's. A
   * command whose plugin shuts down, or fails, since is answered by nobody: its handler does
   * nothing. The core's own cards end with `home`, the surface's way back to the owner's main card
   * (`CoreOptions.home` by default). A chat surface is served `served(node)`, those its edges serve.
   */
  commands(home: CommandButton | undefined = this.o.home): ChatCommand[] {
    const out: ChatCommand[] = [];
    const asOwner = (c: ChatCommand): ChatCommand =>
      c.owner
        ? {
            ...c,
            allow: (asker) => asker.owner === true && (c.allow === undefined || c.allow(asker)),
          }
        : c;
    for (const e of this.entries.values()) {
      if (e.up !== true) continue;
      for (const [name, declared] of Object.entries(e.manifest.interface.commands ?? {})) {
        const handler = e.instance?.commands?.[name] as CommandHandler;
        const live = (): boolean => e.up === true;
        out.push({
          plugin: e.id,
          name,
          help: declared.help,
          ...(declared.args === undefined ? {} : { args: declared.args }),
          aliases: declared.aliases,
          ...(declared.menu === undefined ? {} : { menu: declared.menu }),
          owner: declared.owner,
          hidden: declared.hidden,
          run: (answer, request) => (live() ? handler.run(answer, request) : Promise.resolve()),
          ...(handler.allow === undefined
            ? {}
            : { allow: (asker) => live() && handler.allow?.(asker) === true }),
        });
      }
    }
    // The core's own, the owner's controls of no plugin (§4.11), after the plugins'.
    out.push(
      ...coreCommands({
        controls: this.controls,
        settings: this.settings,
        ...(home === undefined ? {} : { home }),
      })
    );
    return out.map(asOwner);
  }

  /**
   * The chat commands the chat surface of connector `node` answers (bot-os.md D109): each command
   * of a plugin up that a commands edge from `node` serves, with where it is answered (`where`, the
   * edge's chats), who may ask (the edge's `senders`, before the plugin's own `allow`) and its
   * answers held as a send is (each recorded, `core.send` with the origin `command /<name>`, and on
   * a dry-run edge logged and never sent); then the core's own, the owner's controls, answered in
   * the owner's chat alone, as before (D56: that chat is in the graph, the connector's `owner`).
   * No edge, no chat command.
   */
  served(node: string, home: CommandButton | undefined = this.o.home): ChatCommand[] {
    const all = this.commands(home);
    const account = this.entries.get(node)?.node.account ?? '';
    const out: ChatCommand[] = [];
    for (const e of this.entries.values())
      for (const [port, input] of Object.entries(e.node.ports)) {
        if (input.type !== 'commands') continue;
        for (const b of e.node.inputs.get(port) ?? []) {
          if (b.node !== node || b.commands === undefined) continue;
          const edge = b.commands;
          for (const c of all)
            if (c.plugin === e.id && (edge.serves === undefined || edge.serves.includes(c.name)))
              out.push(this.servedOne(c, edge, b.dryRun === true, account));
        }
      }
    return [...out, ...all.filter((c) => c.plugin === 'core')];
  }

  /** A plugin's command as one commands edge serves it (D109). */
  private servedOne(
    c: ChatCommand,
    edge: CommandsBinding,
    dryRun: boolean,
    account: string
  ): ChatCommand {
    const { senders } = edge;
    const may = (a: Asker): boolean =>
      senders === undefined ||
      senders.some((s) =>
        s === OWNER
          ? a.owner === true
          : s === a.id || s.replace(/^@/u, '').toLowerCase() === a.username?.toLowerCase()
      );
    const allow = c.allow;
    return {
      ...c,
      where: { chats: [...edge.chats], privateChats: edge.privateChats },
      ...(senders === undefined && allow === undefined
        ? {}
        : { allow: (a: Asker) => may(a) && (allow === undefined || allow(a)) }),
      run: (answer, request) =>
        c.run(this.heldAnswer(answer, c, account, request.chat ?? '', dryRun), request),
    };
  }

  /**
   * A command's answer held as a send is (D109, P10): recorded (`core.send`, the origin
   * `command /<name>`), and on a dry-run edge logged and never sent (a photo's id then none). A
   * photo is logged by its label and its caption's length, never its bytes; a caption over
   * `CAPTION_MAX`, or a photo `photoRefusal` refuses (D153), is refused, logged so and thrown,
   * before anything is sent (D150).
   */
  private heldAnswer(
    answer: Answer,
    c: ChatCommand,
    account: string,
    chat: string,
    dryRun: boolean
  ): Answer {
    const log = (
      text: string,
      outcome: SendRecord['outcome'],
      reason?: string,
      caption?: string
    ): void => {
      const r: SendRecord = {
        type: 'core.send',
        t: this.o.clock.now(),
        plugin: c.plugin,
        account,
        chat,
        origin: `command /${c.name}`,
        mode: dryRun ? 'dry-run' : 'live',
        text,
        outcome,
        ...(reason === undefined ? {} : { reason }),
        ...(caption === undefined ? {} : { caption: caption.length }),
      };
      this.counted(r);
      this.o.record?.(r);
    };
    const held = async <T>(
      text: string,
      go: () => Promise<T>,
      caption?: string
    ): Promise<T | undefined> => {
      if (dryRun) {
        log(text, 'dry-run', undefined, caption);
        return undefined;
      }
      try {
        const r = await go();
        log(text, 'sent', undefined, caption);
        return r;
      } catch (e) {
        log(text, 'failed', message(e), caption);
        throw e;
      }
    };
    return {
      text: async (text, format, options) => {
        await held(text, () => answer.text(text, format, options));
      },
      photo: (photo, caption, format) => {
        const long = photoRefusal(photo, caption);
        if (long !== undefined) {
          log(photoLabel(photo), 'refused', long, caption);
          return Promise.reject(new Error(long));
        }
        return held(photoLabel(photo), () => answer.photo(photo, caption, format), caption);
      },
    };
  }

  /**
   * Raises a notice for the owner's attention (D91), now: heard by the nodes that tell the owner,
   * and recorded (`core.notice`), for the editor's events panel, whether a node tells it or not
   * (D94: the core tells no chat itself).
   */
  private notice(n: Omit<Notice, 't'>): void {
    const t = this.o.clock.now();
    this.noticeFeed.raise({ ...n, t });
    this.summaries.noticed(n.kind);
    this.o.record?.({ type: 'core.notice', t, ...n });
  }

  /** The owner's notices raised since the start (D91), the newest kept, in order. */
  notices(): Notice[] {
    return this.noticeFeed.recent();
  }

  /** The owner's summary of a window (D92): the core's lines, then each contributor's. */
  summary(window: SummaryWindow): SummarySection[] {
    return this.summaries.collect(window);
  }

  /** Each parser's drift: the messages it read and could not read (§4.7). */
  drift(): DriftCounts[] {
    return this.driftMonitor.counts();
  }

  /**
   * Stops every running plugin that acts and requires `parser` (a required edge), directly or
   * through another plugin, for drift (P5, D64); the others go on, but for those the stops make
   * inactive (#29). Each is stopped before the cascade, so that each keeps its own stop. The
   * plugins stopped.
   */
  private stopActorsOf(parser: string, reason: string): string[] {
    const stopped = [...this.entries.values()]
      .filter(
        ({ id, manifest, status }) =>
          manifest.kinds.includes('actor') &&
          status.state === 'running' &&
          this.requires(id, parser)
      )
      .filter(({ id }) => this.stopOne(id, reason, 'drift'))
      .map(({ id }) => id);
    this.cascade();
    return stopped;
  }

  /** Whether instance `id` requires `other`, through required edges, directly or not. */
  private requires(id: string, other: string, seen = new Set<string>()): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    const node = this.entries.get(id)?.node;
    const reqs = node === undefined ? [] : requiredOf(node);
    return reqs.includes(other) || reqs.some((r) => this.requires(r, other, seen));
  }

  /**
   * The plugin instances, in load order: each one's id, its plugin's manifest, and its input ports
   * as its node's config resolves them (§2.1).
   */
  nodes(): { id: string; manifest: Manifest; ports: Record<string, InputPort>; version: string }[] {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      manifest: e.manifest,
      ports: e.node.ports,
      version: this.versionOf(e),
    }));
  }

  /**
   * The graph the instance runs (§2.1), every edge written out with its type: the wiring as data,
   * for the graph file, the view and the editor. Undefined before the load.
   */
  graph(): Graph | undefined {
    return this.loadedGraph === undefined ? undefined : structuredClone(this.loadedGraph);
  }

  /** Whether an instance sends anywhere: a chat-out edge binds a chat it sends to. */
  sends(id: string): boolean {
    const node = this.entries.get(id)?.node;
    return node !== undefined && sendsOf(node).some(([, b]) => (b.chat?.sends.length ?? 0) > 0);
  }

  /**
   * Checks the plugins and starts them in order. Throws a StartError, before any plugin runs, for
   * an error of the deployment; a plugin that fails at runtime fails only itself and its
   * dependents.
   */
  async start(): Promise<void> {
    if (this.started) throw new Error('the core is started once');
    this.started = true;
    this.summaries.started();
    const from = this.o.clock.now();
    this.load();
    this.folding = true;
    try {
      for (const entry of this.entries.values()) {
        if (this.stopping) break;
        await this.startOne(entry);
      }
    } finally {
      this.folding = false;
    }
    if (this.stopping) return;
    // Every plugin has started: each hears it, in load order (§3).
    for (const entry of this.entries.values()) await this.readyOne(entry);
    // The chat surfaces answer the commands their edges serve from now on (D109), each with its
    // own way home.
    for (const entry of this.entries.values()) {
      if (entry.up !== true) continue;
      const surface = entry.instance?.surface;
      try {
        surface?.serve(this.served(entry.id, surface.home ?? this.o.home));
      } catch (e) {
        this.logger(entry.id).error(`serve failed: ${message(e)}`);
      }
    }
    this.recordStarted(from);
    this.startedAll = true;
    this.sweepDaily();
  }

  /**
   * The start's summary (D114): the release, how long it took, and the nodes by state; those
   * failed or stopped by a kept stop are logged on their own too.
   */
  private recordStarted(from: number): void {
    const now = this.o.clock.now();
    const of = (state: string) =>
      [...this.entries.values()].filter((e) => e.status.state === state);
    const ids = (state: string) => {
      const list = of(state).map((e) => e.id);
      return list.length === 0 ? {} : { [state]: list };
    };
    const inactive = of('inactive').map((e) => ({ id: e.id, reason: e.status.reason }));
    const { build } = this.o;
    this.o.record?.({
      type: 'core.instance',
      t: now,
      event: 'started',
      ...(build === undefined ? {} : { version: build.version }),
      ...(build?.commit === undefined ? {} : { commit: build.commit }),
      ms: now - from,
      running: of('running').map((e) => e.id),
      ...ids('disabled'),
      ...(inactive.length === 0 ? {} : { inactive }),
      ...ids('stopped'),
      ...ids('failed'),
    });
  }

  /**
   * Checks the plugins, their order, their configuration and their settings, without starting
   * any: the wiring reads the kept settings before it builds the app. Throws a StartError for an
   * error of the deployment. Once only; `start` loads if this was not called.
   */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const { raw, fromFile } = this.graphSource();
    let compiled: Compiled;
    try {
      compiled = this.compile(raw, this.failures.length > 0);
    } catch (e) {
      // A saved graph refused never stops the instance: it starts with no nodes, the file kept as
      // it is, and the owner is told why, to fix it in the UI (§2.3).
      if (!fromFile || !(e instanceof StartError)) throw e;
      this.refused = e.message.split('\n').map((p) => locateProblem(p, raw));
      compiled = this.compile(EMPTY_GRAPH);
    }
    if (this.refused.length > 0) {
      const why = this.refused.map((p) => p.text);
      (this.o.print ?? (() => {}))(
        `core: the saved graph is refused, no node runs:\n${why.join('\n')}`
      );
      this.o.record?.({
        type: 'core.graph',
        t: this.o.clock.now(),
        event: 'refused',
        problems: why,
      });
      // Raised, with no node to hear it: the editor's events panel shows it (D94).
      this.notice({
        kind: 'graph-refused',
        text: `The saved graph is refused, and no node runs: ${why.join('; ')}`,
        detail: { problems: why },
      });
    }
    // A warning refuses nothing (D89): printed, for the log, and shown by the editor's check.
    if (compiled.warnings.length > 0)
      (this.o.print ?? (() => {}))(`core: the graph warns:\n${compiled.warnings.join('\n')}`);
    // And raised (D91), for a node that tells the owner.
    for (const w of compiled.warnings) {
      const { node } = locateProblem(w, raw);
      this.notice({ kind: 'warning', ...(node === undefined ? {} : { node }), text: w });
    }
    this.entries = compiled.entries;
    this.loadedGraph = compiled.graph;
    this.bus = compiled.bus;
    this.heldNodes = this.heldOf(compiled.held);
    this.keepSources();
    if (this.o.settings !== undefined)
      this.settings.add(new PluginSettings(CORE, this.o.settings, this.stores.internal(CORE)));
    for (const { id, manifest, node } of this.entries.values()) {
      this.registry.touch(node.instance, manifest.id);
      const kept = this.stores.internal(node.instance);
      // A fresh instance starts with the settings its node gives.
      if (node.settings !== undefined && kept.get(SETTINGS_DOC) === undefined)
        kept.put(SETTINGS_DOC, node.settings);
      if (manifest.settings !== undefined)
        this.settings.add(new PluginSettings(id, manifest.settings, kept));
    }
    // The nodes not started (D64): disabled, stopped (kept in their instance), and inactive.
    const stops = new Map<string, StopRecord>();
    for (const { id, node } of this.entries.values()) {
      const stop = this.stopOf(node);
      if (stop !== undefined) stops.set(id, stop);
    }
    const down = nodeStates(
      [...this.entries.values()].map((e) => e.node),
      (n) => stops.has(n.id)
    );
    this.folding = true;
    for (const [id, d] of down) {
      const entry = this.entries.get(id) as Entry;
      const stop = stops.get(id);
      if (d.state === 'stopped' && stop !== undefined)
        this.set(entry, 'stopped', stop.reason, stop);
      else if (d.state === 'inactive')
        this.set(entry, 'inactive', downText(d).slice('inactive: '.length));
      else this.set(entry, d.state);
    }
    this.folding = false;
  }

  /**
   * The instances kept (§2.2): each one's plugin, and the node that runs on it; `used` also when
   * only the saved graph references it.
   */
  instances(): InstanceInfo[] {
    const running = new Map([...this.entries.values()].map((e) => [e.node.instance, e.id]));
    const saved = this.references() ?? new Set<string>();
    return this.registry.list().map(({ id, meta }) => {
      const node = running.get(id);
      return {
        id,
        ...(meta === undefined ? {} : meta),
        ...(node === undefined ? {} : { node }),
        used: node !== undefined || saved.has(id),
      };
    });
  }

  /**
   * Deletes the instances no node has referenced for 7 days, of the running graph or the saved
   * one, and touches the others (§2.2): the ids deleted. Nothing is deleted while the saved graph
   * cannot be read.
   */
  sweepInstances(): string[] {
    const saved = this.references();
    if (saved === undefined) return [];
    const referenced = new Set([
      ...saved,
      ...[...this.entries.values()].map((e) => e.node.instance),
    ]);
    const deleted = this.registry.sweep(referenced);
    for (const instance of deleted) {
      (this.o.print ?? (() => {}))(`core: instance ${instance} deleted, unused for 7 days`);
      this.o.record?.({ type: 'core.instance', t: this.o.clock.now(), instance, event: 'deleted' });
    }
    return deleted;
  }

  /** The instances the saved graph references: undefined when it does not read. */
  private references(): ReadonlySet<string> | undefined {
    if (this.o.referenced !== undefined) return this.o.referenced();
    return this.o.graphFile === undefined ? new Set() : this.o.graphFile.references();
  }

  /** The orphaned instances looked for now, and again in a day. */
  private sweepDaily(): void {
    this.sweepInstances();
    this.sweepTimer = this.o.clock.setTimeout(() => this.sweepDaily(), SWEEP_MS);
  }

  /**
   * Stops the plugins up (running, or stopped since they started), in the reverse order, keeping
   * what they serialise; a node stopped by exception stays so in its instance.
   */
  async stop(why?: string): Promise<void> {
    this.stopping = true;
    const from = this.o.clock.now();
    this.o.clock.clearTimeout(this.sweepTimer);
    // What waits in the queues goes no further: a queued send does not outlive the process (D73).
    for (const outbox of this.outboxes.values()) outbox.dropQueued(undefined, 'the instance stops');
    await this.shutting;
    const stopped: string[] = [];
    this.folding = true;
    try {
      for (const entry of [...this.entries.values()].reverse()) {
        const { instance } = entry;
        if (instance === undefined || entry.up !== true) continue;
        entry.up = false;
        this.set(entry, 'stopping');
        entry.scheduler?.disarm();
        this.bus.drop(entry.id);
        this.noticeFeed.drop(entry.id);
        let failed: string | undefined;
        try {
          if (instance.serialise !== undefined)
            this.stores.internal(entry.node.instance).put(RESTORE, instance.serialise());
          await this.withTimeout(() => instance.stop?.(), entry.id);
        } catch (e) {
          failed = `stop failed: ${message(e)}`;
          this.logger(entry.id).error(failed);
        }
        // A stop that failed or took too long is logged on its own (D114).
        this.set(entry, 'stopped', failed);
        stopped.push(entry.id);
      }
    } finally {
      this.folding = false;
    }
    const now = this.o.clock.now();
    this.o.record?.({
      type: 'core.instance',
      t: now,
      event: 'stopped',
      ...(why === undefined ? {} : { why }),
      ms: now - from,
      stopped,
    });
  }

  /**
   * Stops a node by exception (bot-os.md D64): a safety stop, drift, the owner's kill or stop.
   * Kept in its instance (`_stop.json`: why, when, who), so that it is not started again until the
   * owner clears it (`clearStop`) and the instance restarts; while it runs, its outbox refuses its
   * sends, and it hears `pause`. A node stopped again keeps
   * the latest stop. Every node the stop makes inactive is shut down at once (`cascade`). False
   * for a node that is not up.
   */
  stopNode(id: string, reason: string, source: StopSource): boolean {
    const stopped = this.stopOne(id, reason, source);
    if (stopped) this.cascade();
    return stopped;
  }

  /** A node's stop, as `stopNode` makes it, without its cascade. */
  private stopOne(id: string, reason: string, source: StopSource): boolean {
    const entry = this.entries.get(id);
    if (entry?.up !== true) return false;
    const stop: StopRecord = { reason, time: new Date(this.o.clock.now()).toISOString(), source };
    this.stores.internal(entry.node.instance).put(STOP_DOC, stop);
    const was = entry.status.state;
    this.set(entry, 'stopped', reason, stop);
    if (was !== 'running' && was !== 'starting') return true;
    this.logger(id).warn(`stopped (${source}): ${reason}`);
    try {
      entry.instance?.pause?.(reason);
    } catch (e) {
      this.logger(id).error(`pause: ${message(e)}`);
    }
    return true;
  }

  /**
   * A runtime stop's cascade (D64, #29): the nodes inactive by the load's rule (`nodeStates`, a
   * required port bound to a node disabled, stopped or inactive, transitively), with the stops as
   * they are now, are inactive at once, with the load's reason: those up shut down, dependents
   * first, as the instance's stop does (their timers, events and messages cut at once, their
   * `serialise` kept, their `stop` called); those not started yet are not started.
   */
  private cascade(): void {
    const down = nodeStates(
      [...this.entries.values()].map((e) => e.node),
      (n) => {
        const { status } = this.entries.get(n.id) as Entry;
        return status.state === 'stopped' && status.stop !== undefined;
      }
    );
    const shut: Entry[] = [];
    for (const entry of [...this.entries.values()].reverse()) {
      const d = down.get(entry.id);
      if (d?.state !== 'inactive' || entry.status.state === 'inactive') continue;
      const { state } = entry.status;
      if (entry.up !== true && state !== 'registered') continue;
      const reason = downText(d).slice('inactive: '.length);
      if (entry.up === true) {
        entry.up = false;
        entry.scheduler?.disarm();
        this.bus.drop(entry.id);
        this.noticeFeed.drop(entry.id);
        this.logger(entry.id).warn(`inactive: ${reason}`);
        shut.push(entry);
      }
      this.set(entry, 'inactive', reason);
      this.notice({
        kind: 'cascade',
        node: entry.id,
        text: `${entry.id} is inactive: ${reason}`,
        detail: { reason },
      });
    }
    if (shut.length > 0) this.shutting = this.shutting.then(() => this.shutDown(shut));
  }

  /** The nodes a cascade made inactive, shut down in order, keeping what they serialise. */
  private async shutDown(entries: readonly Entry[]): Promise<void> {
    for (const entry of entries) {
      const { instance } = entry;
      try {
        if (instance?.serialise !== undefined)
          this.stores.internal(entry.node.instance).put(RESTORE, instance.serialise());
        await this.withTimeout(() => instance?.stop?.(), entry.id);
      } catch (e) {
        this.logger(entry.id).error(`stop failed: ${message(e)}`);
      }
    }
  }

  /**
   * Clears a node's stop, kept in its instance (D64): it starts again at the next start (the
   * editor's Clear stop, applied with a restart). False for a node of no stop.
   */
  clearStop(id: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    const kept = this.stores.internal(entry.node.instance);
    if (kept.get(STOP_DOC) === undefined) return false;
    kept.backend.delete(STOP_DOC);
    this.o.record?.({ type: 'core.plugin', t: this.o.clock.now(), plugin: id, event: 'cleared' });
    return true;
  }

  /** A node's stop as its instance keeps it, if any. */
  private stopOf(node: ResolvedNode): StopRecord | undefined {
    const doc = this.stores.internal(node.instance).get(STOP_DOC) as
      Partial<StopRecord> | undefined;
    if (doc === undefined || doc === null || typeof doc !== 'object') return undefined;
    return {
      reason: typeof doc.reason === 'string' ? doc.reason : 'stopped',
      time: typeof doc.time === 'string' ? doc.time : new Date(0).toISOString(),
      source:
        doc.source === 'safety' ||
        doc.source === 'drift' ||
        doc.source === 'stalled' ||
        doc.source === 'owner'
          ? doc.source
          : 'owner',
    };
  }

  /**
   * The manifests checked, the graph checked against them (§2.1), and the instances in the order
   * their required edges make.
   */
  /**
   * The graph to load: the one given, the default one, or the saved file's (§2.3): an empty graph
   * when there is no file; one that does not read is refused, the instance started with no nodes.
   */
  private graphSource(): { raw: unknown; fromFile: boolean } {
    const given = this.o.graph;
    const file = this.o.graphFile;
    if (given === undefined && file !== undefined) {
      const r = file.read();
      if (!r.exists) return { raw: EMPTY_GRAPH, fromFile: true };
      if ('error' in r) {
        this.refused = [{ text: r.error }];
        return { raw: EMPTY_GRAPH, fromFile: true };
      }
      return { raw: r.raw, fromFile: true };
    }
    if (typeof given === 'function' || given === undefined) {
      const manifests = this.plugins.flatMap((p) => {
        try {
          return [parseManifest(p.manifest)];
        } catch {
          return [];
        }
      });
      const defaults = defaultGraph(manifests, this.o.config);
      return { raw: typeof given === 'function' ? given(defaults) : defaults, fromFile: false };
    }
    return { raw: given, fromFile: false };
  }

  /**
   * Checks a graph as the load would (§2.3), against the plugins the instance offers, their
   * manifests, configuration, settings and secrets, and the instances kept: the graph as the core
   * would hold it, or its problems, each located where it can be. Nothing starts, nothing is kept.
   */
  check(raw: unknown): GraphCheck {
    // The plugins the graph names may not be in yet (D143): nothing is checked until they are.
    if (this.bootPending && !this.loaded)
      return {
        ok: false,
        problems: [{ text: 'the instance is still loading its plugins: check again in a moment' }],
      };
    try {
      const { graph, warnings } = this.compile(raw);
      return { ok: true, graph, warnings: warnings.map((w) => locateProblem(w, raw)) };
    } catch (e) {
      if (!(e instanceof StartError)) throw e;
      return {
        ok: false,
        problems: e.message.split('\n').map((p) => locateProblem(p, raw)),
        warnings: e.warnings.map((w) => locateProblem(w, raw)),
      };
    }
  }

  /**
   * The nodes of a graph whose ports their config declares (bot-os.md D74), each as the editor
   * draws it (`describePlugin` of its own manifest), whether or not the graph checks: so that a
   * port declared in the draft is drawn at once. A node whose manifest is refused is left out (the
   * check says why).
   */
  nodeViews(raw: unknown): Record<string, PluginView> {
    const nodes =
      isObject(raw) && Array.isArray(raw['nodes'])
        ? (raw['nodes'] as unknown[])
        : ([] as unknown[]);
    const out: Record<string, PluginView> = {};
    for (const n of nodes) {
      if (!isObject(n) || typeof n['id'] !== 'string' || typeof n['plugin'] !== 'string') continue;
      const plugin = this.plugins.find((p) => p.manifest.id === n['plugin']);
      if (plugin === undefined) continue;
      let base: Manifest;
      try {
        base = parseManifest(plugin.manifest);
      } catch {
        continue;
      }
      if (base.node === undefined) continue;
      const config = isObject(n['config']) ? n['config'] : undefined;
      const { manifest, problem } = nodeManifest(base, n['id'], config);
      if (problem === undefined) out[n['id']] = describePlugin(manifest);
    }
    return out;
  }

  /**
   * Each node's input ports, as the check resolves them (§2.1): from its config as its plugin's
   * schema makes it, defaults included (as written when the schema refuses it), and from its own
   * manifest for a node whose ports its config declares (D74); by node, for the editor to draw
   * what the core will run rather than resolve them again from the config as written (#6). A node
   * of a plugin not offered is left out (the check says why).
   */
  nodeInputs(raw: unknown): Record<string, Record<string, PortView>> {
    const nodes =
      isObject(raw) && Array.isArray(raw['nodes'])
        ? (raw['nodes'] as unknown[])
        : ([] as unknown[]);
    const out: Record<string, Record<string, PortView>> = {};
    for (const n of nodes) {
      if (!isObject(n) || typeof n['id'] !== 'string' || typeof n['plugin'] !== 'string') continue;
      const plugin = this.plugins.find((p) => p.manifest.id === n['plugin']);
      if (plugin === undefined) continue;
      let base: Manifest;
      try {
        base = parseManifest(plugin.manifest);
      } catch {
        continue;
      }
      const config = isObject(n['config']) ? n['config'] : undefined;
      const manifest =
        base.node === undefined ? base : nodeManifest(base, n['id'], config).manifest;
      out[n['id']] = describeInputs(manifest, nodeInputs(manifest, config).ports);
    }
    return out;
  }

  /**
   * Records what a graph written to the file (a save or a rollback) changed of the config keys its
   * nodes' manifests audit (bot-os.md D75: a script node's code), against the graph before it: for
   * each such key that changed, `core.config`, with its node, plugin and key, its SHA-256 (none
   * once removed), who wrote it (`by`) and how (`source`), and the history's version; never its
   * value.
   */
  written(before: unknown, after: Graph, o: SaveBy & { source: string; version?: string }): void {
    const nodesOf = (g: unknown): Record<string, unknown>[] =>
      isObject(g) && Array.isArray(g['nodes']) ? (g['nodes'] as unknown[]).filter(isObject) : [];
    const old = new Map(nodesOf(before).map((n) => [n['id'], n]));
    const now = new Map(nodesOf(after).map((n) => [n['id'], n]));
    const configOf = (n: Record<string, unknown> | undefined): Record<string, unknown> =>
      isObject(n?.['config']) ? n['config'] : {};
    for (const id of new Set([...old.keys(), ...now.keys()])) {
      if (typeof id !== 'string') continue;
      const [was, is] = [old.get(id), now.get(id)];
      const node = is ?? was;
      const keys = this.auditOf(node as Record<string, unknown>);
      for (const key of keys) {
        const [a, b] = [configOf(was)[key], configOf(is)[key]];
        const changed = was?.['plugin'] !== is?.['plugin'] || stableJson(a) !== stableJson(b);
        if (!changed || (a === undefined && b === undefined)) continue;
        this.o.record?.({
          type: 'core.config',
          t: this.o.clock.now(),
          event: is === undefined || b === undefined ? 'removed' : 'saved',
          node: id,
          plugin: String(node?.['plugin']),
          key,
          ...(is === undefined || b === undefined ? {} : { sha256: sha256Of(b) }),
          by: o.by ?? 'the control API (loopback)',
          source: o.source,
          ...(o.version === undefined ? {} : { version: o.version }),
        });
      }
    }
  }

  /** The config keys a node's manifest audits (D75): its own, for one that declares its ports. */
  private auditOf(n: Record<string, unknown>): string[] {
    const plugin = this.plugins.find((p) => p.manifest.id === n['plugin']);
    if (plugin === undefined) return [];
    try {
      const base = parseManifest(plugin.manifest);
      const config = isObject(n['config']) ? n['config'] : undefined;
      return nodeManifest(base, String(n['id']), config).manifest.audit;
    } catch {
      return [];
    }
  }

  /** The saved file's graph as it reads, unchecked; none without a file. */
  private savedGraph(): unknown {
    const r = this.o.graphFile?.read();
    return r !== undefined && r.exists && 'raw' in r ? r.raw : undefined;
  }

  /** The sensitive config keys of a plugin's nodes (D124), by its id. */
  private sensitiveKeys = (plugin: string): readonly string[] => {
    const p = this.plugins.find((x) => x.manifest.id === plugin);
    if (p === undefined) return [];
    try {
      return parseManifest(p.manifest).configSensitive;
    } catch {
      return [];
    }
  };

  /**
   * A graph as it may leave the core (D124): every sensitive config value shown as set
   * (`hideSensitive`), whatever its form. Every view of a graph goes through it.
   */
  hideSensitive<T>(raw: T): T {
    return hideSensitive(raw, this.sensitiveKeys);
  }

  /** A graph to write to the file: its sensitive values sealed under bot_os_key (D124). */
  sealSensitive<T>(raw: T): T {
    return sealSensitive(raw, this.sensitiveKeys, this.sealer);
  }

  /** Why the saved graph was not run at this start (§2.3); none when it was. */
  graphProblems(): GraphProblem[] {
    return structuredClone(this.refused);
  }

  /**
   * The manifests checked, the graph checked against them (§2.1), and the instances in the order
   * their required edges make, with the bus their event types are registered on.
   */
  private compile(raw: unknown, tolerate = false): Compiled {
    const bus = this.newBus();
    const problems: string[] = [];
    const plugins = new Map<string, { plugin: Plugin; manifest: Manifest }>();
    for (const plugin of this.plugins) {
      let manifest: Manifest;
      try {
        manifest = parseManifest(plugin.manifest);
      } catch (e) {
        problems.push(message(e));
        continue;
      }
      if (plugins.has(manifest.id)) {
        problems.push(`plugin ${manifest.id}: registered twice`);
        continue;
      }
      plugins.set(manifest.id, { plugin, manifest });
    }
    const manifests = new Map([...plugins].map(([id, p]) => [id, p.manifest]));
    // Its sensitive values opened (D124): sealed ones with the key, the editor's HIDDEN ones from
    // the saved file; one that cannot be is left out, with a warning.
    const opened = openSensitive(
      raw,
      (plugin) => manifests.get(plugin)?.configSensitive ?? [],
      this.sealer,
      this.savedGraph()
    );
    raw = opened.raw;
    // A package or module failed to load (D143): the nodes of the plugins not offered are held out,
    // with those that need them, and the rest runs.
    let held: Unloaded[] = [];
    if (tolerate) ({ raw, held } = holdUnloaded(raw, manifests));
    let resolved: ReturnType<typeof resolveGraph> | undefined;
    let ordered: ResolvedNode[];
    try {
      resolved = resolveGraph(
        raw,
        manifests,
        (instance) => this.registry.meta(instance)?.plugin,
        // A chat's names, as the node's running connector knows them (D90); none while it is not.
        (node, plugin, chat) =>
          this.entries.get(node)?.manifest.id === plugin
            ? this.connector(node)?.chatNames?.(chat)
            : undefined
      );
      ordered = loadOrder(resolved.nodes);
    } catch (e) {
      if (e instanceof GraphError)
        throw new StartError([...problems, ...e.problems].join('\n'), [
          ...opened.warnings,
          ...(e.warnings.length > 0 ? e.warnings : (resolved?.warnings ?? [])),
        ]);
      throw e;
    }
    if (this.o.allowArchived !== true)
      for (const node of resolved.nodes)
        if (node.manifest.archived)
          problems.push(
            `plugin ${node.id}: ${node.manifest.id} is archived (bot-os.md D32): it runs in no instance, only in a run that allows archives`
          );
    const entries = new Map<string, Entry>();
    for (const node of ordered) {
      const { id, manifest } = node;
      let config: Readonly<Record<string, unknown>> = {};
      if (manifest.config !== undefined) {
        const parsed = manifest.config.safeParse(node.config ?? this.o.config?.[id] ?? {});
        if (parsed.success) config = parsed.data as Record<string, unknown>;
        else
          for (const i of parsed.error.issues)
            problems.push(
              `plugin ${id}: config ${i.path.map(String).join('.') || '(all)'}: ${i.message}`
            );
      }
      for (const [key, value] of Object.entries(node.settings ?? {})) {
        const field = manifest.settings?.shape[key] as z.ZodType | undefined;
        const parsed = field?.safeParse(value);
        if (parsed === undefined) problems.push(`plugin ${id}: settings ${key}: no such setting`);
        else if (!parsed.success)
          problems.push(
            `plugin ${id}: settings ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`
          );
      }
      const named: string[] = [];
      for (const key of manifest.configSecrets) {
        const value = config[key];
        if (value === undefined) continue;
        if (typeof value === 'string' && SECRET_NAME.test(value)) named.push(value);
        else problems.push(`plugin ${id}: config ${key}: expected the name of a secret`);
      }
      for (const name of [...manifest.secrets, ...named])
        if (this.o.secrets?.has(name) !== true)
          problems.push(
            `plugin ${id}: the secret ${name} is not provided (${this.o.secrets?.dir ?? 'no secrets'}/${name})`
          );
      problems.push(...bus.register(id, manifest));
      entries.set(id, {
        id,
        plugin: (plugins.get(manifest.id) as { plugin: Plugin }).plugin,
        manifest,
        node,
        config,
        status: { id, state: 'registered' },
      });
    }
    problems.push(...commandProblems([...entries.values()]));
    const warnings = [...opened.warnings, ...resolved.warnings];
    if (problems.length > 0) throw new StartError(problems.join('\n'), warnings);
    return { entries, graph: resolved.graph, bus, warnings, held };
  }

  private async startOne(entry: Entry): Promise<void> {
    const { id } = entry;
    // Disabled, stopped or inactive (D64): not started.
    if (entry.status.state !== 'registered') return;
    const down = requiredOf(entry.node).find((r) => this.entries.get(r)?.status.state === 'failed');
    if (down !== undefined) {
      this.fail(entry, `requires ${down}, which failed`);
      return;
    }
    this.set(entry, 'starting');
    /** Its start was given up on (D143): what its `create` makes late is stopped. */
    let late = false;
    const work = async (): Promise<void> => {
      await this.stores.migrate(
        entry.node.instance,
        entry.manifest.state.migrations as Migration[]
      );
      const instance = await entry.plugin.create(this.contextFor(entry));
      if (late) {
        await this.withTimeout(() => instance.stop?.(), id).catch(() => {});
        return;
      }
      entry.instance = instance;
      entry.up = true;
      if (instance.settings !== undefined) this.settings.serveFor(id, instance.settings);
      if (entry.manifest.kinds.includes('connector')) {
        if (instance.connector === undefined)
          throw new Error('a connector plugin offers no connector');
        if (instance.connector.account !== entry.node.account)
          throw new Error(
            `its connector's account is ${instance.connector.account}, not ${String(entry.node.account)}`
          );
      }
      for (const name of Object.keys(entry.manifest.interface.commands ?? {}))
        if (typeof instance.commands?.[name]?.run !== 'function')
          throw new Error(`it declares the command ${name}, and offers no handler for it`);
      await instance.start?.();
    };
    try {
      await this.within(work(), 'its start did not finish');
    } catch (e) {
      late = true;
      // Given up on while it runs: stopped, as a failure at runtime is.
      if (e instanceof StartTimeout && entry.up === true) this.failAtRuntime(entry, e.message);
      else this.fail(entry, message(e));
      return;
    }
    // A plugin that stopped itself as it started stays stopped.
    if ((entry.status.state as PluginState) === 'starting') this.set(entry, 'running');
    entry.scheduler?.arm();
  }

  private async readyOne(entry: Entry): Promise<void> {
    const { instance } = entry;
    if (instance?.ready === undefined || entry.up !== true) return;
    try {
      await this.within(
        Promise.resolve().then(() => instance.ready?.()),
        'its ready did not finish'
      );
    } catch (e) {
      await this.failRunning(entry, message(e));
    }
  }

  /**
   * Fails a plugin that had started (its `ready` threw), stopping it, and the running plugins that
   * require it, directly or through others.
   */
  private async failRunning(entry: Entry, why: string): Promise<void> {
    try {
      await this.withTimeout(() => entry.instance?.stop?.(), entry.id);
    } catch (e) {
      this.logger(entry.id).error(`stop failed: ${message(e)}`);
    }
    this.fail(entry, why);
    for (const other of this.entries.values()) {
      if (other.up === true && requiredOf(other.node).includes(entry.id))
        await this.failRunning(other, `requires ${entry.id}, which failed`);
    }
  }

  private contextFor(entry: Entry): PluginContext {
    const { id, node } = entry;
    const kept = this.stores.internal(node.instance);
    const restored = kept.get(RESTORE);
    // Handed back once: a crash before the next stop must not restore it a second time.
    kept.backend.delete(RESTORE);
    const log = this.logger(id);
    const own = this.bus.handle(id, entry.manifest, sourcesOf(node), log, node.instance);
    // The message its node is reading now, through a chat-in edge: an event it publishes meanwhile
    // is an answer heard from that chat, for the send-queue watchdog (D93), and, if its manifest
    // declares the event an answer, the answer to a command sent there (D98); its own messages and
    // history are none.
    let reading: Inbound | undefined;
    let heard = false;
    const bus: BusHandle = {
      ...own,
      publish: (type, payload, t) => {
        const m = reading;
        if (m !== undefined) {
          const outbox = this.outboxes.get(m.account);
          if (!heard) outbox?.heard(m);
          heard = true;
          // Before its subscribers hear it: one that sends again finds its send settled, and the guard's
          // count of its refusals.
          const read = readAnswer(entry.manifest.answers, type, payload, t ?? this.o.clock.now());
          if (read !== undefined && payload['playback'] !== true) outbox?.answered(m, read);
        }
        own.publish(type, payload, t);
      },
    };
    const scheduler = new PluginScheduler({
      clock: this.o.clock,
      load: () => kept.get(TIMERS) as Record<string, KeptTimer> | undefined,
      save: (timers) => kept.put(TIMERS, timers),
      fire: (name, payload) => {
        const onTimer = entry.instance?.onTimer;
        if (onTimer === undefined) {
          log.warn(`timer ${name} fired, and the plugin has no onTimer`);
          return;
        }
        try {
          this.costs.time(id, () => onTimer.call(entry.instance, name, payload));
        } catch (e) {
          log.error(`timer ${name}: ${message(e)}`);
        }
      },
      dropped: (name, timer, lateMs) => {
        log.info(`timer ${name} dropped, ${Math.round(lateMs / 1000)} s late`);
        this.o.record?.({
          type: 'core.timer',
          t: this.o.clock.now(),
          plugin: id,
          timer: name,
          event: 'dropped',
          at: timer.at,
        });
      },
    });
    entry.scheduler = scheduler;
    /**
     * Its way out through one chat-out edge (`bound`): through that output's edge alone when
     * `port` names it (D64: its dry run is its own); refused when none binds an account.
     */
    const outboxOf = (
      bound: [string, Binding] | undefined,
      port: string | undefined,
      key: string
    ): OutboxHandle => {
      const holder = bound === undefined ? undefined : this.entries.get(bound[1].node);
      if (holder?.node.account === undefined)
        throw new Error(`${id} has no reach on the account ${key}: no edge binds a chat-out of it`);
      const outbox = this.outbox(holder.node.account);
      const handle = outbox.as(id, port);
      // A queued send's cancel on events (D73): heard on its node's own bus, as it hears any.
      return {
        ...handle,
        enqueue: (chat, text, options = {}) => {
          const on = options.cancel?.on;
          const types = on === undefined ? [] : typeof on === 'string' ? [on] : [...on];
          if (types.length === 0) return handle.enqueue(chat, text, options);
          const heard: (() => void)[] = [];
          // Subscribed before it is queued, so that a refusal queues nothing.
          const ref: { queued?: QueuedSend } = {};
          const hear = (e: BusEvent): void => {
            const c = options.cancel;
            if (ref.queued === undefined || !holds(e, c?.when) || c?.test?.(e) === false) return;
            outbox.cancelQueued(ref.queued.id, `cancelled by ${e.type}`, e);
          };
          try {
            for (const t of types) heard.push(bus.subscribe(t, hear));
          } catch (e) {
            for (const u of heard) u();
            throw e;
          }
          const queued = handle.enqueue(chat, text, options);
          ref.queued = queued;
          void queued.result.then(() => {
            for (const u of heard) u();
          });
          return queued;
        },
      };
    };
    return {
      id,
      log,
      clock: this.o.clock,
      store: this.stores.open(node.instance),
      config: entry.config,
      ...(entry.manifest.kinds.includes('connector')
        ? { secrets: this.secretsOf(id), readers: () => this.readersOf(id) }
        : {}),
      scheduler,
      bus,
      drift: this.driftMonitor.reporter(id),
      outbox: (key) => {
        const bound = this.chatEnd(sendsOf(node), key);
        return outboxOf(bound, bound?.[0] === key ? key : undefined, key);
      },
      // Every edge of an output (D97), one handle per connector it binds.
      outboxes: (port) => {
        const seen = new Set<string>();
        return sendsOf(node)
          .filter(([p, b]) => {
            const account = this.entries.get(b.node)?.node.account;
            if (p !== port || account === undefined || seen.has(account)) return false;
            seen.add(account);
            return true;
          })
          .map((bound) => outboxOf(bound, port, port));
      },
      connector: (key) => {
        const bound = this.chatEnd(chatsOf(node), key);
        if (bound === undefined)
          throw new Error(`${id} has no reach on ${key}: no edge binds a chat-in input of it`);
        const c = this.connector(bound[1].node);
        if (c === undefined) throw new Error(`${bound[1].node} is not a running connector`);
        // It hears only the chats and the senders its edge reads (P6, D62), and nothing once it
        // is shut down (a cascade's, #29).
        const handle = handleOf(c, readFilter(bound[1]));
        return {
          ...handle,
          onMessage: (h) =>
            handle.onMessage((m) => {
              if (entry.up !== true) return;
              reading = m.own === true || m.playback ? undefined : m;
              heard = false;
              try {
                this.costs.time(id, () => h(m));
              } finally {
                reading = undefined;
              }
            }),
          // Edits, to a plugin that asks for them (D144): while it is up, timed as its messages;
          // no answer is paired from one (D98).
          ...(handle.onEdit === undefined
            ? {}
            : {
                onEdit: (h: (m: Inbound) => void) =>
                  (handle.onEdit as NonNullable<typeof handle.onEdit>)((m) => {
                    if (entry.up !== true) return;
                    this.costs.time(id, () => h(m));
                  }),
              }),
        };
      },
      use: <T>(key: string): T => {
        const used = this.interfaceOf(entry, key);
        if (used === undefined) throw new Error(`${key} is not running`);
        return used as T;
      },
      useOptional: <T>(key: string): T | undefined => this.interfaceOf(entry, key) as T | undefined,
      attention: <T>(port = 'attention'): T => this.attentionOf(entry, port) as T,
      settings: {
        kept: () => this.settings.of(id)?.kept() ?? {},
        set: (key, raw) => this.settings.set(`${id}.${key}`, raw),
      },
      // A message for the owner, raised as a notice (D94): a node that tells the owner sends it.
      notify: (text, buttons) =>
        this.notice({
          kind: 'told',
          node: id,
          text,
          ...(buttons === undefined || buttons.length === 0
            ? {}
            : { detail: { buttons: buttons.map((row) => row.map((b) => ({ ...b }))) } }),
        }),
      notice: (kind, text, detail) =>
        this.notice({ kind, node: id, text, ...(detail === undefined ? {} : { detail }) }),
      ...(entry.manifest.notices
        ? {
            notices: {
              // Heard while its node is up, its time counted as its handlers' (D77).
              subscribe: (handler) =>
                this.noticeFeed.subscribe(id, (n) => {
                  if (entry.up === true) this.costs.time(id, () => handler(n));
                }),
            },
          }
        : {}),
      ...(entry.manifest.summary ? { summary: this.summaries.handle(id) } : {}),
      stop: (reason) => {
        this.stopNode(id, reason, 'safety');
      },
      fail: (reason) => this.failAtRuntime(entry, reason),
      off: () => this.controls.off,
      render: this.o.render ?? resvgRender,
      events: {
        read: (options) => this.readEvents(entry, options),
        after: (cursor, options = {}) => this.tailEvents(entry, cursor, options.types),
      },
      record: (type, fields) => {
        const ns = type.slice(0, type.indexOf('.'));
        const own = [...entry.manifest.games.registers, entry.manifest.id];
        if (!type.includes('.') || !own.includes(ns))
          throw new Error(`${id} cannot record ${type}: its namespaces are ${own.join(', ')}`);
        this.o.record?.({
          ...fields,
          type,
          t: this.o.clock.now(),
          instance: node.instance,
        } as BusEvent);
      },
      ...(node.account === undefined ? {} : { account: node.account }),
      ...(restored === undefined ? {} : { restored }),
    };
  }

  /**
   * The event log's records an instance may read (§4.4): of the namespaces it registers, its own
   * plugin's, and those its events inputs consume; of one type or namespace, or of them all; from
   * `since` (the log's first day) to `until` (now).
   */
  private readEvents(entry: Entry, o: EventQuery = {}): LogEntry[] {
    const keep = this.logFilter(entry, o.type === undefined ? undefined : [o.type], o.all);
    const log = this.o.events;
    if (log === undefined) return [];
    const until = o.until ?? this.o.clock.now();
    const since = o.since ?? log.firstDay() ?? until;
    return log.recordsSince(since, until).filter(keep);
  }

  /**
   * The event log's records an instance may read written after its cursor (bot-os.md D72), of the
   * types or namespaces `wanted` (all it may read without), as `readEvents` filters them, with
   * where each sits; and the cursor past everything read, kept or not. Without a log, nothing, and
   * the cursor as it was.
   */
  private tailEvents(entry: Entry, cursor: LogCursor, wanted?: readonly string[]): LogTail {
    const keep = this.logFilter(entry, wanted, false);
    const log = this.o.events;
    if (log === undefined) return { entries: [], cursor: { ...cursor } };
    const tail = log.after(cursor);
    return { entries: tail.entries.filter((e) => keep(e.entry)), cursor: tail.cursor };
  }

  /**
   * Which of the log's records an instance reads (§4.4): of the types or namespaces `wanted`, each
   * one it may read (refused otherwise, naming what it reads), or of all it may read; and, but with
   * `all`, only those its own instance wrote of its own namespaces and those of the nodes its
   * events inputs bind, as the bus delivers them.
   */
  private logFilter(
    entry: Entry,
    wanted: readonly string[] | undefined,
    all: boolean | undefined
  ): (r: LogEntry) => boolean {
    const { manifest, node } = entry;
    const readable = new Set([
      ...manifest.games.registers,
      manifest.id,
      ...Object.values(node.ports).flatMap((i) => (i.type === 'events' ? [i.namespace] : [])),
    ]);
    const nsOf = (type: string): string =>
      type.includes('.') ? type.slice(0, type.indexOf('.')) : type;
    for (const w of wanted ?? []) {
      const ns = nsOf(w);
      if (!readable.has(ns))
        throw new Error(
          `${entry.id} does not read ${ns}: it reads ${[...readable].join(', ')} (add an events input of it)`
        );
    }
    // Whose records of each namespace it reads: its own instance's, and those of the nodes its
    // events inputs bind (their instances), as the bus delivers them; with `all`, every instance's.
    // A record with no instance (written before records carried one) is everyone's.
    const sources = sourcesOf(node);
    const writers = (ns: string): Set<string> =>
      new Set([
        ...(ns === manifest.id ? [node.instance] : []),
        ...[...(sources.get(ns) ?? [])].map((n) => this.entries.get(n)?.node.instance ?? n),
      ]);
    const byNs = new Map<string, Set<string>>();
    const mine = (r: LogEntry): boolean => {
      if (all === true || typeof r['instance'] !== 'string') return true;
      const ns = nsOf(r.type);
      let w = byNs.get(ns);
      if (w === undefined) byNs.set(ns, (w = writers(ns)));
      return w.has(r['instance']);
    };
    const asked = (type: string): boolean =>
      wanted === undefined
        ? readable.has(nsOf(type))
        : wanted.some((w) => type === w || (!w.includes('.') && nsOf(type) === w));
    return (r) => asked(r.type) && mine(r);
  }

  /**
   * What each chat-in edge leaving the connector node `id` reads (D62), of the nodes that read
   * (D66): not those disabled, stopped, inactive or failed, as they are at the call.
   */
  private readersOf(id: string): ReadFilter[] {
    return [...this.entries.values()]
      .filter((e) => READING.has(e.status.state))
      .flatMap((e) => chatsOf(e.node).flatMap(([, b]) => (b.node === id ? [readFilter(b)] : [])));
  }

  /** A connector's way to its declared secrets, and to mark a value it keeps as one. */
  private secretsOf(id: string): NonNullable<PluginContext['secrets']> {
    return {
      get: (name) => this.secretFor(id, name),
      has: (name) => {
        const m = this.entries.get(id)?.manifest;
        return m?.secrets.includes(name) === true && this.o.secrets?.has(name) === true;
      },
      remember: (value) => this.o.secrets?.remember(value),
      store: this.sealedStore(id),
    };
  }

  /** A connector's sealed view of its instance's store (D123), made at its context. */
  private sealedStore(id: string): SealedStore {
    const entry = this.entries.get(id);
    const instance = entry?.node.instance ?? id;
    const store = new SealedStore({
      base: this.stores.open(instance),
      sealer: this.sealer,
      scope: instance,
      warn: (line) => this.logger(id).warn(line),
    });
    this.sealedStores.set(id, store);
    return store;
  }

  /**
   * Of a node's bound chat ports (its chat-in inputs, or its chat-out outputs), the one `key` names
   * (a port's name; or, by the other end, a connector instance's id or its account) and its edge;
   * undefined if no edge binds one.
   */
  private chatEnd(chats: [string, Binding][], key: string): [string, Binding] | undefined {
    return (
      chats.find(([port]) => port === key) ??
      chats.find(([, b]) => b.node === key || this.entries.get(b.node)?.node.account === key)
    );
  }

  /**
   * The members an instance uses of the interface its input `key` binds (a port's name, or the
   * other end's id): undefined while that end is unbound or not running. Refused for an input it
   * does not have.
   */
  private interfaceOf(entry: Entry, key: string): PluginInterface | undefined {
    const { node } = entry;
    const named = node.ports[key];
    const port =
      named?.type === 'interface'
        ? key
        : [...node.inputs].find(
            ([p, bs]) => node.ports[p]?.type === 'interface' && bs.some((b) => b.node === key)
          )?.[0];
    const input = port === undefined ? undefined : node.ports[port];
    if (port === undefined || input?.type !== 'interface')
      throw new Error(`${entry.id} does not use ${key}: add an interface input of it`);
    const other = node.inputs.get(port)?.[0]?.node;
    const e = other === undefined ? undefined : this.entries.get(other);
    if (e?.up !== true) return undefined;
    return interfaceOf(e.id, e.instance?.interface ?? {}, input.members, entry.id);
  }

  /**
   * What the node its attention input `port` binds offers it (bot-os.md D133): its instance's
   * `attention`, called with the asking node's id. Refused for an input it does not have, unbound,
   * or whose other end is not running or offers none.
   */
  private attentionOf(entry: Entry, port: string): unknown {
    const input = entry.node.ports[port];
    if (input?.type !== 'attention')
      throw new Error(`${entry.id} has no attention input ${port}: add one`);
    const other = entry.node.inputs.get(port)?.[0]?.node;
    const e = other === undefined ? undefined : this.entries.get(other);
    const offer = e?.up === true ? e.instance?.attention : undefined;
    if (offer === undefined)
      throw new Error(`${entry.id}: its attention ${other ?? port} is not running`);
    return offer(entry.id);
  }

  /**
   * Fails a node up at runtime (`ctx.fail`): cut at once (its events, messages and timers; its
   * sends refused, its queue dropped), then its `stop` called, as a cascade's shutdown is; and every
   * node up that requires it, through a required port, fails with it.
   */
  private failAtRuntime(entry: Entry, why: string): void {
    if (entry.up !== true) return;
    const { instance } = entry;
    this.fail(entry, why);
    this.shutting = this.shutting.then(async () => {
      try {
        await this.withTimeout(() => instance?.stop?.(), entry.id);
      } catch (e) {
        this.logger(entry.id).error(`stop failed: ${message(e)}`);
      }
    });
    for (const other of this.entries.values())
      if (other.up === true && requiredOf(other.node).includes(entry.id))
        this.failAtRuntime(other, `requires ${entry.id}, which failed`);
  }

  private fail(entry: Entry, why: string): void {
    const reason = this.o.secrets?.redact(why) ?? why;
    entry.up = false;
    entry.scheduler?.disarm();
    this.bus.drop(entry.id);
    this.noticeFeed.drop(entry.id);
    this.set(entry, 'failed', reason);
    this.logger(entry.id).error(`failed: ${reason}`);
    this.notice({
      kind: 'failed',
      node: entry.id,
      text: `${entry.id} failed: ${reason}`,
      detail: { reason },
    });
  }

  private set(entry: Entry, state: PluginState, reason?: string, stop?: StopRecord): void {
    // A node that stops running drops what it queued (D73): it sends nothing from then on.
    if (state !== 'running' && state !== 'starting')
      for (const outbox of this.outboxes.values())
        outbox.dropQueued(entry.id, `${entry.id} is ${state}`);
    entry.status = {
      id: entry.id,
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(stop === undefined ? {} : { stop }),
    };
    // A start or a stop of the whole instance folds what goes as expected into its summary (D114).
    if (this.folding && (FOLDED.has(state) || (state === 'stopped' && reason === undefined)))
      return;
    this.o.record?.({
      type: 'core.plugin',
      t: this.o.clock.now(),
      plugin: entry.id,
      state,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private logger(id: string): Logger {
    const print = this.o.print ?? (() => {});
    return {
      info: (line) => print(`${id}: ${line}`),
      warn: (line) => print(`${id}: warning: ${line}`),
      error: (line) => print(`${id}: error: ${line}`),
    };
  }

  /**
   * What `work` settles to, or a `StartTimeout` once the start timeout has passed (D143); a late
   * rejection of `work` is then left unheard.
   */
  private within<T>(work: Promise<T>, why: string): Promise<T> {
    const ms = this.o.startTimeoutMs ?? START_TIMEOUT_MS;
    work.catch(() => {});
    let timer: ReturnType<Clock['setTimeout']> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.o.clock.setTimeout(
        () => reject(new StartTimeout(`${why} within ${ms / 1000} s`)),
        ms
      );
    });
    return Promise.race([work, timeout]).finally(() => this.o.clock.clearTimeout(timer));
  }

  /** The nodes the load held back (D143), with why: each failure that may have taken its plugin. */
  private heldOf(unloaded: readonly Unloaded[]): HeldNode[] {
    const kept = this.stores.open(CORE).read<Record<string, string>>(SOURCES_DOC) ?? {};
    const states = new Map<string, HeldNode['state']>();
    return unloaded.map((u): HeldNode => {
      if (u.needs !== undefined) {
        states.set(u.id, 'inactive');
        return {
          id: u.id,
          plugin: u.plugin,
          state: 'inactive',
          reason: `needs ${u.needs} (${states.get(u.needs) ?? 'unloaded'})`,
        };
      }
      const source = kept[u.plugin];
      const theirs = this.failures.filter((f) => f.source === source);
      const failures = theirs.length > 0 ? theirs : this.failures;
      const state = u.disabled ? 'disabled' : 'unloaded';
      states.set(u.id, state);
      return {
        id: u.id,
        plugin: u.plugin,
        state,
        reason:
          `its plugin ${u.plugin} did not load: ` +
          failures.map((f) => `${f.source} failed: ${f.error}`).join('; '),
        failures: failures.map((f) => ({ ...f })),
      };
    });
  }

  /** Where each plugin registered came from, kept for a later start's failed load (D143). */
  private keepSources(): void {
    const store = this.stores.open(CORE);
    const kept = store.read<Record<string, string>>(SOURCES_DOC) ?? {};
    const now = { ...kept };
    for (const p of this.plugins) {
      const source = this.sources.get(p);
      if (source === undefined) continue;
      try {
        now[parseManifest(p.manifest).id] = source;
      } catch {
        // Its manifest does not read: the load says why.
      }
    }
    if (stableJson(now) !== stableJson(kept)) store.write(SOURCES_DOC, now);
  }

  /** What `work` returns, or a rejection once the stop timeout has passed. */
  private withTimeout(work: () => unknown, id: string): Promise<unknown> {
    const ms = this.o.stopTimeoutMs ?? 5000;
    let timer: ReturnType<Clock['setTimeout']> | undefined;
    const timeout = new Promise((_, reject) => {
      timer = this.o.clock.setTimeout(() => reject(new Error(`${id} took over ${ms} ms`)), ms);
    });
    return Promise.race([Promise.resolve().then(work), timeout]).finally(() =>
      this.o.clock.clearTimeout(timer)
    );
  }
}

/** Two commands, or a command and an alias, of one name: the chat surface could not tell them apart. */
function commandProblems(entries: readonly { id: string; manifest: Manifest }[]): string[] {
  const owner = new Map<string, string>(CORE_COMMANDS.map((n) => [n, `the core's ${n}`]));
  const problems: string[] = [];
  for (const { id, manifest: m } of entries)
    for (const [name, c] of Object.entries(m.interface.commands ?? {}))
      for (const n of [name, ...c.aliases]) {
        const other = owner.get(n);
        if (other === undefined) owner.set(n, `${id}'s ${name}`);
        else problems.push(`plugin ${id}: the command ${n} of its ${name} is ${other} already`);
      }
  return problems;
}

/** A node's chat-in inputs that an edge binds, each with its edge: the chats it reads. */
/** What a chat-in edge reads: its chats and its senders. */
function readFilter(b: Binding): ReadFilter {
  return {
    reads: b.chat?.reads ?? [],
    ...(b.chat?.senders === undefined ? {} : { senders: b.chat.senders }),
  };
}

function chatsOf(node: ResolvedNode): [string, Binding][] {
  return [...node.inputs].flatMap(([port, bs]) =>
    bs.filter((b) => b.type === 'chat-in').map((b): [string, Binding] => [port, b])
  );
}

/** A node's chat-out outputs that an edge binds, each with its edge: what it sends, and where. */
function sendsOf(node: ResolvedNode): [string, Binding][] {
  return [...node.outputs].flatMap(([port, bs]) => bs.map((b): [string, Binding] => [port, b]));
}

/** The nodes whose events a node hears, by namespace: its edges', and its own of its namespaces. */
function sourcesOf(node: ResolvedNode): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (ns: string, from: string): void => {
    out.set(ns, (out.get(ns) ?? new Set()).add(from));
  };
  for (const ns of node.manifest.games.registers) add(ns, node.id);
  for (const [port, bs] of node.inputs) {
    const input = node.ports[port];
    if (input?.type !== 'events') continue;
    if (!out.has(input.namespace)) out.set(input.namespace, new Set());
    for (const b of bs) add(input.namespace, b.node);
  }
  return out;
}

/**
 * The members of a plugin's interface that another, `caller`, uses, and only those: each action
 * told who calls it (`ActionCall`, D117), whatever the caller passes beyond its input.
 */
function interfaceOf(
  id: string,
  offered: PluginInterface,
  members: readonly string[],
  caller: string
): PluginInterface {
  const out: { state: Record<string, () => unknown>; actions: Record<string, unknown> } = {
    state: {},
    actions: {},
  };
  const call: ActionCall = { node: caller };
  for (const member of members) {
    const [part, name] = member.split('.', 2) as ['state' | 'actions', string];
    const fn = (offered[part] as Record<string, unknown> | undefined)?.[name];
    if (typeof fn !== 'function') throw new Error(`${id} does not offer ${member}`);
    out[part][name] =
      part === 'actions'
        ? (input: unknown) => (fn as (input: unknown, call: ActionCall) => unknown)(input, call)
        : fn;
  }
  return out as PluginInterface;
}

/** A config value's SHA-256, in hex: a text's of its UTF-8, anything else's of its stable JSON. */
const sha256Of = (v: unknown): string =>
  crypto
    .createHash('sha256')
    .update(typeof v === 'string' ? v : stableJson(v))
    .digest('hex');

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
