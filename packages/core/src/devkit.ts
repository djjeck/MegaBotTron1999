/**
 * The development kit (docs/bot-os-api.md §4.10, P15): what any plugin runs against outside an
 * instance, in tests and in simulators.
 *
 * - `FakeConnector`, with its plugin (`fakeConnectorPlugin`): a connector of any network whose
 *   messages are said by the test or the simulator (`hear`) and whose sends go to it (`onSend`),
 *   with the account's limits, so that the plugins read and send through it as they do live.
 * - `DevKit`: a core on a virtual clock (packages/core/src/clock.ts), its stores in memory,
 *   with the plugins given, their configuration, the owner's kept settings, and the
 *   documents their stores start with: the state of a run, set before it starts.
 * - `defineSimulator`: a simulator plugin, a model of a game that runs other plugins on the kit
 *   (bot-os.md D13). It is not registered in an instance: its manifest says what it is and what it
 *   plays, and its `run` plays one run.
 *
 * Nothing in here knows of any game.
 */
import { type Clock, VirtualClock } from './clock.ts';
import { type Buttons } from './commands.ts';
import {
  type Connector,
  ConnectorBase,
  type Inbound,
  type Surface,
  type SurfaceQuery,
} from './connector.ts';
import { Core, type CoreOptions } from './core.ts';
import { type LogEntry, MemoryEventLog } from './event-log.ts';
import { type Manifest, ManifestError, type ManifestInput, parseManifest } from './manifest.ts';
import { type Limits } from './outbox.ts';
import { definePlugin, type Plugin } from './plugin.ts';

export interface FakeConnectorOptions {
  /** Its account, `<network>:<name>`: the network is the part before the colon. */
  account: string;
  /** Its own name on the network; the account's name by default. */
  self?: string;
  /** The account's limits, which its outbox keeps to; none, no rate limit. */
  limits?: Limits;
  /** Where a send goes; true if it went (the default: every send goes). */
  onSend?: (chat: string, text: string) => boolean;
  /** The chats the account administers (`isAdmin`). */
  admins?: readonly string[];
  /** The chats it can see (`surfaces`), in order; none: it cannot list them. */
  surfaces?: readonly Surface[];
}

/** A message the connector hears: its account and network are the connector's. */
export type Heard = Omit<Inbound, 'account' | 'network' | 'playback'> & { playback?: boolean };

/** A connector of any network, driven by a test or a simulator. */
export class FakeConnector extends ConnectorBase implements Connector {
  /** Every send, in order. */
  readonly sent: { chat: string; text: string }[] = [];
  private readonly onSend: ((chat: string, text: string) => boolean) | undefined;
  private readonly admins: readonly string[];
  /** Its surfaces, as a test sets them; undefined: none (it cannot list them). */
  readonly surfaces?: (query?: SurfaceQuery) => Promise<Surface[]>;

  constructor(o: FakeConnectorOptions) {
    const colon = o.account.indexOf(':');
    if (colon <= 0) throw new Error(`not an account: ${o.account} (expected <network>:<name>)`);
    super(o.account, o.account.slice(0, colon));
    this.named(o.self ?? o.account.slice(colon + 1));
    if (o.limits !== undefined) this.limits = o.limits;
    this.onSend = o.onSend;
    this.admins = o.admins ?? [];
    const listed = o.surfaces;
    if (listed !== undefined)
      this.surfaces = (q = {}) => {
        if (this.status().state !== 'connected') return Promise.reject(new Error('not connected'));
        const search = q.search?.toLowerCase() ?? '';
        return Promise.resolve(
          listed
            .filter((x) => x.title.toLowerCase().includes(search) || x.id.includes(search))
            .slice(0, q.limit ?? listed.length)
        );
      };
  }

  /** Whether the account administers `chat`: one of `admins`. */
  isAdmin(chat: string): Promise<boolean> {
    return Promise.resolve(this.admins.includes(chat));
  }

  /** Connected, at the network's step `phase` (IRC's `joined`). */
  open(phase = 'connected'): void {
    this.changed({ state: 'connected', phase });
  }

  /** Closed, with why. */
  close(detail?: string): void {
    this.changed({ state: 'closed', phase: 'closed', ...(detail === undefined ? {} : { detail }) });
  }

  /** A message said on the network, live unless `playback`. */
  hear(m: Heard): void {
    this.received({ ...m, playback: m.playback ?? false });
  }

  send(chat: string, text: string): boolean {
    this.sent.push({ chat, text });
    return this.onSend?.(chat, text) ?? true;
  }
}

/** The connector plugin `id` on a fake connector, for a kit's plugins to require and reach. */
export function fakeConnectorPlugin(id: string, connector: FakeConnector): Plugin {
  return definePlugin({
    manifest: {
      id,
      version: '0.1.0',
      kinds: ['connector'],
      description: `A fake connector of ${connector.account}, driven by a test or a simulator`,
      account: connector.account,
    },
    create: () => ({ connector }),
  });
}

export interface DevKitOptions {
  /** The virtual clock's start, in milliseconds. */
  start?: number;
  /**
   * The plugins of the run, connectors included, in registration order; or registered on `core`
   * before `start`, for plugins made with the kit's core in hand.
   */
  plugins?: readonly Plugin[];
  /**
   * The run's graph (`CoreOptions.graph`, §2.1): the plugin instances and their edges; by default,
   * one instance of each plugin, bound as the manifests say; or a function of that default.
   */
  graph?: CoreOptions['graph'];
  /** Each plugin instance's configuration, by instance id (`CoreOptions.config`). */
  config?: Record<string, unknown>;
  /**
   * The owner's settings, kept before the start, by plugin instance and key, in their text form or
   * value.
   */
  settings?: Record<string, Record<string, unknown>>;
  /** The documents each plugin instance's store starts with, by instance id and name. */
  documents?: Record<string, Record<string, unknown>>;
  /** Where the core's records and every event published go, beside the kit's own log (`log`). */
  record?: CoreOptions['record'];
  /**
   * The event log as it was before the run, for the plugins that read their history
   * (`ctx.events`): the kit's log starts with it, and keeps every record of the run after it.
   */
  history?: readonly LogEntry[];
  /** Where log lines go; nowhere by default. */
  print?: (line: string) => void;
  /** Where the owner's notifications go; nowhere by default. */
  notify?: (text: string, buttons?: Buttons) => void;
  /** Whether events are checked against their schemas (by default, outside production). */
  validateEvents?: boolean;
  /** Whether an archived plugin may run (`CoreOptions.allowArchived`): off unless said. */
  allowArchived?: boolean;
  /** The release and commit the run says it is (`CoreOptions.build`), for a start notice. */
  build?: CoreOptions['build'];
}

/** A core on a virtual clock, with the state of a run set before it starts. */
export class DevKit {
  readonly clock: VirtualClock;
  readonly core: Core;
  /** The run's event log, in memory: its history, then every record of the run. */
  readonly log: MemoryEventLog;
  private readonly o: DevKitOptions;

  constructor(o: DevKitOptions) {
    this.o = o;
    this.clock = new VirtualClock(o.start ?? 0);
    const log = new MemoryEventLog(o.history);
    this.log = log;
    this.core = new Core({
      events: log,
      record: (r) => {
        const at = log.write(r);
        o.record?.(r);
        return at;
      },
      clock: this.clock as Clock,
      ...(o.config === undefined ? {} : { config: o.config }),
      ...(o.graph === undefined ? {} : { graph: o.graph }),
      ...(o.documents === undefined ? {} : { documents: o.documents }),
      ...(o.print === undefined ? {} : { print: o.print }),
      ...(o.notify === undefined ? {} : { notify: o.notify }),
      ...(o.validateEvents === undefined ? {} : { validateEvents: o.validateEvents }),
      ...(o.allowArchived === undefined ? {} : { allowArchived: o.allowArchived }),
      ...(o.build === undefined ? {} : { build: o.build }),
    });
    this.core.register(...(o.plugins ?? []));
  }

  /**
   * Keeps the settings given, as the owner's, and starts every plugin. Throws for a
   * setting refused, and for a plugin that failed: a run without one of its plugins is no run.
   */
  async start(): Promise<void> {
    this.core.load();
    for (const [plugin, values] of Object.entries(this.o.settings ?? {}))
      for (const [key, value] of Object.entries(values)) {
        const why = this.core.settings.set(`${plugin}.${key}`, value);
        if (why !== undefined) throw new Error(`dev kit: setting ${plugin}.${key}: ${why}`);
      }
    await this.core.start();
    const failed = this.core.status().filter((s) => s.state === 'failed');
    if (failed.length > 0)
      throw new Error(
        `dev kit: ${failed.map((s) => `${s.id} failed (${s.reason ?? '?'})`).join('; ')}`
      );
  }

  /** Runs the clock to `t`, every timer due on the way at its own time. */
  runUntil(t: number): void {
    this.clock.advanceTo(t);
  }

  stop(): Promise<void> {
    return this.core.stop();
  }
}

/** A simulator: its manifest (kind `simulator`), and how it plays one run. */
export interface Simulator<Run, Options, Result> {
  readonly manifest: Manifest;
  run(run: Run, options: Options): Promise<Result>;
}

/** A simulator plugin, its manifest checked: a ManifestError if bad, or not of kind `simulator`. */
export function defineSimulator<Run, Options, Result>(s: {
  manifest: ManifestInput;
  run: (run: Run, options: Options) => Promise<Result>;
}): Simulator<Run, Options, Result> {
  const manifest = parseManifest(s.manifest);
  if (!manifest.kinds.includes('simulator'))
    throw new ManifestError(`plugin ${manifest.id}: a simulator's kinds include simulator`);
  return { manifest, run: s.run };
}
