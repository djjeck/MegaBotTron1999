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
 */
import fs from 'node:fs';
import path from 'node:path';
import { type z } from 'zod';
import { Bus, type BusEvent } from './bus.ts';
import { type Clock } from './clock.ts';
import {
  type Buttons,
  type ChatCommand,
  type CommandButton,
  type CommandHandler,
} from './commands.ts';
import { type ChatSurface, type Connector, handleOf } from './connector.ts';
import { Controls, KILLED } from './controls.ts';
import { DEFAULT_DRIFT, type DriftCounts, DriftMonitor, type DriftRecord } from './drift.ts';
import {
  type Binding,
  defaultGraph,
  type Graph,
  GraphError,
  type GraphInput,
  loadOrder,
  requiredOf,
  type ResolvedNode,
  resolveGraph,
} from './graph.ts';
import { type Manifest, parseManifest } from './manifest.ts';
import { Modes, Outbox, type SenderPolicy, type SendRecord } from './outbox.ts';
import { CORE_COMMANDS, coreCommands } from './owner-commands.ts';
import {
  type Instance,
  type Logger,
  type Plugin,
  type PluginContext,
  type PluginInterface,
} from './plugin.ts';
import { type Render, resvgRender } from './render.ts';
import { type KeptTimer, PluginScheduler } from './scheduler.ts';
import { type Secrets, SecretStore } from './secrets.ts';
import { PluginSettings, SETTINGS_DOC, SettingsRegistry } from './settings.ts';
import { type Migration, Stores } from './store.ts';

export type PluginState =
  'registered' | 'starting' | 'running' | 'paused' | 'stopping' | 'stopped' | 'failed';

export interface PluginStatus {
  id: string;
  state: PluginState;
  /** Why it failed or is paused. */
  reason?: string;
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
  /** Where the core's records and every event published go (the event log). */
  record?: (r: CoreRecord | BusEvent | SendRecord | DriftRecord) => void;
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
   * A file of the data volume's root that kept every setting before the core
   * (`settings.json`): at the first load each key goes to its plugin's store, and the file is
   * left as `<file>.migrated`.
   */
  legacySettings?: string;
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
  /** Tells the owner, with buttons that each run a command; nothing while the instance is off. */
  notify?: (text: string, buttons?: Buttons) => void;
  /**
   * A file of the data volume's root whose presence meant the instance was off before the core
   * kept the off switch (`off.json`): adopted as off at the first load (§4.11). The plugin that
   * kept what it holds in that file adopts it into its store.
   */
  legacyOff?: string;
  /** The way back to the owner's main card, at the foot of the core's own cards (§4.11). */
  home?: CommandButton;
  /**
   * The connector plugin whose chat surface is the owner's (§4.8): the owner's notices go
   * there, waiting for it to start; without it, to `notify`.
   */
  owner?: string;
  /**
   * The data volume: each plugin's store is `<dataDir>/plugins/<id>/`. Without it the stores live
   * in memory, for tests.
   */
  dataDir?: string;
  /**
   * Without a data volume, the documents each plugin's store holds as the core is made, by plugin
   * and name: the state a run of the dev kit starts from (packages/core/src/devkit.ts).
   * Ignored with one.
   */
  documents?: Record<string, Record<string, unknown>>;
  /** How long a plugin's `stop` may take before the next one stops. */
  stopTimeoutMs?: number;
  /**
   * Whether a plugin whose manifest is `archived` (bot-os.md D32) may run: never in an instance,
   * whose wiring leaves this unset; only in a test, the dev kit or a manual-test tool that says so.
   */
  allowArchived?: boolean;
  /** The render service the plugins get (§4.13): the shell's, on resvg, by default. */
  render?: Render;
}

export class StartError extends Error {}

/** A plugin the instance offers: the image's, or a module's (`module`). */
export interface AvailablePlugin {
  id: string;
  version: string;
  description: string;
  kinds: string[];
  /** The module that offers it; none for the image's own. */
  module?: string;
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
}

/** The core's own store, beside the plugins'. */
const CORE = 'core';

/** The core's document, in each plugin's store, of what it serialised at its last stop. */
const RESTORE = '_restore';
/** The core's document, in each plugin's store, of its timers. */
const TIMERS = '_timers';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Core {
  private readonly o: CoreOptions;
  private readonly plugins: Plugin[] = [];
  /** The module each plugin registered from a module came from. */
  private readonly origins = new Map<Plugin, string>();
  /** By id, in load order once started. */
  private entries = new Map<string, Entry>();
  /** The graph as loaded, every edge written out (§2.1). */
  private loadedGraph?: Graph;
  private started = false;
  private loaded = false;
  /** Every plugin's settings, for the control surfaces (§2, P11). */
  readonly settings: SettingsRegistry;
  private readonly stores: Stores;
  private readonly bus: Bus;
  private readonly outboxes = new Map<string, Outbox>();
  /** The acting plugins' modes (P10), kept in the core's own store. */
  readonly modes: Modes;
  private readonly driftMonitor: DriftMonitor;
  /** The owner's notices waiting for the owner's surface to start. */
  private readonly pendingTells: [string, Buttons | undefined][] = [];
  /** The secrets the core stores itself, encrypted at rest (§4.9); none without a data volume. */
  readonly secretStore?: SecretStore;
  /** The owner's controls (§4.11), from which every control surface is made. */
  readonly controls: Controls;

  constructor(given: CoreOptions) {
    const secrets = given.secrets;
    // Whatever the core prints, records or tells passes through the redaction of the secrets.
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
            ...(given.notify === undefined
              ? {}
              : {
                  notify: (text: string, buttons?: Buttons) =>
                    given.notify?.(secrets.redact(text), buttons),
                }),
          };
    const options = this.o;
    this.stores = new Stores(options.dataDir);
    if (options.dataDir === undefined)
      for (const [id, docs] of Object.entries(options.documents ?? {})) {
        const store = this.stores.open(id);
        for (const [name, value] of Object.entries(docs)) store.write(name, value);
      }
    const dir = this.stores.dirOf(CORE);
    if (secrets !== undefined && dir !== undefined)
      this.secretStore = new SecretStore(path.join(dir, 'secrets'), secrets);
    this.modes = new Modes(this.stores.open(CORE));
    const legacyOff =
      options.legacyOff !== undefined &&
      options.dataDir !== undefined &&
      fs.existsSync(path.join(options.dataDir, options.legacyOff));
    this.settings = new SettingsRegistry((plugin) => {
      const entry = this.entries.get(plugin);
      try {
        entry?.instance?.settingsChanged?.();
      } catch (e) {
        this.logger(plugin).error(`settingsChanged: ${message(e)}`);
      }
    });
    this.controls = new Controls(
      {
        modes: this.modes,
        settings: this.settings,
        store: this.stores.open(CORE),
        nodes: () => this.nodes(),
        sends: (id) => this.sends(id),
        status: (id) => this.state(id),
        instance: (id) => {
          const e = this.entries.get(id);
          return e?.status.state === 'running' || e?.status.state === 'paused'
            ? e.instance
            : undefined;
        },
        resume: (id) => this.resume(id),
        killNode: (id) => this.killNode(id),
        record: (fields) =>
          this.o.record?.({ type: 'core.power', t: this.o.clock.now(), ...fields }),
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
      },
      legacyOff
    );
    this.driftMonitor = new DriftMonitor({
      clock: options.clock,
      ...(options.record === undefined ? {} : { record: options.record }),
      notify: (text) => this.tell(text),
      threshold: (parser) => this.entries.get(parser)?.manifest.drift ?? DEFAULT_DRIFT,
      pause: (parser, reason) => this.pauseActorsOf(parser, reason),
    });
    this.bus = new Bus({
      now: () => options.clock.now(),
      ...(options.record === undefined ? {} : { record: options.record }),
      validate: options.validateEvents ?? process.env['NODE_ENV'] !== 'production',
    });
  }

  /** Adds plugins to start; only before `start`. */
  register(...plugins: Plugin[]): void {
    if (this.started) throw new Error('plugins are registered before the core starts');
    this.plugins.push(...plugins);
  }

  /** Adds the plugins a module offers (§7), as `register` does, remembering their module. */
  registerModule(module: string, plugins: readonly Plugin[]): void {
    this.register(...plugins);
    for (const p of plugins) this.origins.set(p, module);
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
        const module = this.origins.get(p);
        return [
          {
            id: m.id,
            version: m.version,
            description: m.description,
            kinds: [...m.kinds],
            ...(module === undefined ? {} : { module }),
          },
        ];
      } catch {
        return [];
      }
    });
  }

  /** Each plugin's state, in load order. */
  status(): PluginStatus[] {
    return [...this.entries.values()].map((e) => ({ ...e.status }));
  }

  /** One plugin's state, or undefined for an id not loaded. */
  state(id: string): PluginStatus | undefined {
    const e = this.entries.get(id);
    return e === undefined ? undefined : { ...e.status };
  }

  /**
   * The connector of a running (or paused) connector plugin, sends included: for the instance's
   * wiring, which sends for the app until the outbox does. Plugins get handles.
   */
  connector(id: string): Connector | undefined {
    const e = this.entries.get(id);
    if (e?.status.state !== 'running' && e?.status.state !== 'paused') return undefined;
    return e.instance?.connector;
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
        modes: this.modes,
        policy: (plugin) => this.policyOf(plugin, account),
        ...(this.o.record === undefined ? {} : { record: this.o.record }),
      });
      this.outboxes.set(account, outbox);
    }
    return outbox;
  }

  /**
   * What an outbox knows of a sender: what its edges to the account's connector bind (P6), and
   * whether it may send now.
   */
  private policyOf(plugin: string, account: string): SenderPolicy {
    const entry = this.entries.get(plugin);
    if (entry === undefined) return { reach: { sends: [] } };
    const holder = [...this.entries.values()].find((e) => e.node.account === account);
    const reaches = chatsOf(entry.node)
      .filter(([, b]) => b.node === holder?.id)
      .map(([, b]) => b.chat ?? { reads: [], sends: [] });
    const { state, reason } = entry.status;
    return {
      reach: reaches.length === 0 ? { sends: [] } : reaches,
      ...(state === 'paused'
        ? { paused: reason ?? 'paused' }
        : state === 'running'
          ? {}
          : { paused: `not running (${state})` }),
    };
  }

  /**
   * A connector's own declared secret, for its context's `secrets` (§4.9). Refused for any plugin
   * but a connector, and any secret it does not declare.
   */
  private secretFor(plugin: string, name: string): string {
    const manifest = this.entries.get(plugin)?.manifest;
    if (manifest === undefined || !manifest.kinds.includes('connector'))
      throw new Error(`${plugin} is not a connector: it receives no secret`);
    if (!manifest.secrets.includes(name))
      throw new Error(`${plugin} does not declare the secret ${name}`);
    const value = this.o.secrets?.read(name);
    if (value === undefined) throw new Error(`the secret ${name} is not provided`);
    return value;
  }

  /**
   * What a running service connector made from its secrets for the wiring (`Instance.service`):
   * the object, never the secret. Undefined while it does not run.
   */
  service<T>(id: string): T | undefined {
    const e = this.entries.get(id);
    if (e?.status.state !== 'running' && e?.status.state !== 'paused') return undefined;
    return e.instance?.service as T | undefined;
  }

  /**
   * The chat commands of the running (or paused) plugins, in load order, for the chat surface
   * (§2 `interface.commands`, P11). A command whose plugin stops, or fails, since is answered by
   * nobody: its handler does nothing.
   */
  commands(): ChatCommand[] {
    const out: ChatCommand[] = [];
    const asOwner = (c: ChatCommand): ChatCommand =>
      c.owner
        ? {
            ...c,
            allow: (asker) => asker.owner === true && (c.allow === undefined || c.allow(asker)),
          }
        : c;
    for (const e of this.entries.values()) {
      const { state } = e.status;
      if (state !== 'running' && state !== 'paused') continue;
      for (const [name, declared] of Object.entries(e.manifest.interface.commands ?? {})) {
        const handler = e.instance?.commands?.[name] as CommandHandler;
        const live = (): boolean => e.status.state === 'running' || e.status.state === 'paused';
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
        ...(this.o.home === undefined ? {} : { home: this.o.home }),
      })
    );
    return out.map(asOwner);
  }

  /**
   * Tells the owner, unless the instance is off (§4.8, §4.11): through the owner's chat surface
   * (`owner`), waiting for it to start, or `notify`.
   */
  notify(text: string, buttons?: Buttons): void {
    this.tell(text, buttons);
  }

  private tell(text: string, buttons?: Buttons): void {
    if (this.controls.off) return;
    if (this.o.owner === undefined) {
      this.o.notify?.(text, buttons);
      return;
    }
    const surface = this.ownerSurface();
    if (surface !== undefined) surface.tell(this.redact(text), buttons);
    else this.pendingTells.push([this.redact(text), buttons]);
  }

  /** The owner's chat surface, once its plugin has made it. */
  private ownerSurface(): ChatSurface | undefined {
    const e = this.o.owner === undefined ? undefined : this.entries.get(this.o.owner);
    if (e?.status.state !== 'running' && e?.status.state !== 'paused') return undefined;
    return e.instance?.surface;
  }

  private redact(text: string): string {
    return this.o.secrets?.redact(text) ?? text;
  }

  /** Each parser's drift: the messages it read and could not read (§4.7). */
  drift(): DriftCounts[] {
    return this.driftMonitor.counts();
  }

  /**
   * Pauses every running plugin that acts and requires `parser` (a required edge), directly or
   * through another plugin; read-only plugins go on. The plugins paused.
   */
  private pauseActorsOf(parser: string, reason: string): string[] {
    const paused: string[] = [];
    for (const { id, manifest } of this.entries.values())
      if (manifest.kinds.includes('actor') && this.requires(id, parser) && this.pause(id, reason))
        paused.push(id);
    return paused;
  }

  /** Whether instance `id` requires `other`, through required edges, directly or not. */
  private requires(id: string, other: string, seen = new Set<string>()): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    const node = this.entries.get(id)?.node;
    const reqs = node === undefined ? [] : requiredOf(node);
    return reqs.includes(other) || reqs.some((r) => this.requires(r, other, seen));
  }

  /** The plugin instances, in load order: each one's id and its plugin's manifest. */
  nodes(): { id: string; manifest: Manifest }[] {
    return [...this.entries.values()].map((e) => ({ id: e.id, manifest: e.manifest }));
  }

  /**
   * The graph the instance runs (§2.1), every edge written out with its type: the wiring as data,
   * for the graph file, the view and the editor. Undefined before the load.
   */
  graph(): Graph | undefined {
    return this.loadedGraph === undefined ? undefined : structuredClone(this.loadedGraph);
  }

  /** Whether an instance sends anywhere (an edge binds a chat it sends to): it has a mode (P10). */
  sends(id: string): boolean {
    const node = this.entries.get(id)?.node;
    return node !== undefined && chatsOf(node).some(([, b]) => (b.chat?.sends.length ?? 0) > 0);
  }

  /**
   * Checks the plugins and starts them in order. Throws a StartError, before any plugin runs, for
   * an error of the deployment; a plugin that fails at runtime fails only itself and its
   * dependents.
   */
  async start(): Promise<void> {
    if (this.started) throw new Error('the core is started once');
    this.started = true;
    this.load();
    for (const entry of this.entries.values()) await this.startOne(entry);
    // Every plugin has started: each hears it, in load order (§3).
    for (const entry of this.entries.values()) await this.readyOne(entry);
    // The chat surfaces answer the commands from now on.
    const commands = this.commands();
    for (const entry of this.entries.values()) {
      const { state } = entry.status;
      if (state !== 'running' && state !== 'paused') continue;
      try {
        entry.instance?.surface?.serve(commands);
      } catch (e) {
        this.logger(entry.id).error(`serve failed: ${message(e)}`);
      }
    }
    // Notices for an owner's surface that never started are printed, not lost silently.
    for (const [text] of this.pendingTells.splice(0))
      (this.o.print ?? (() => {}))(`core: not told (no ${String(this.o.owner)}): ${text}`);
  }

  /**
   * Checks the plugins, their order, their configuration and their settings, without starting
   * any: the wiring reads the kept settings before it builds the app. Throws a StartError for an
   * error of the deployment. Once only; `start` loads if this was not called.
   */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.entries = this.order();
    const missing = [...this.entries.values()].flatMap(({ id, manifest }) =>
      manifest.secrets
        .filter((name) => this.o.secrets?.has(name) !== true)
        .map(
          (name) =>
            `plugin ${id}: the secret ${name} is not provided (${this.o.secrets?.dir ?? 'no secrets'}/${name})`
        )
    );
    if (missing.length > 0) throw new StartError(missing.join('\n'));
    this.migrateSettings();
    if (this.o.settings !== undefined)
      this.settings.add(new PluginSettings(CORE, this.o.settings, this.stores.internal(CORE)));
    for (const { id, manifest } of this.entries.values())
      if (manifest.settings !== undefined)
        this.settings.add(new PluginSettings(id, manifest.settings, this.stores.internal(id)));
  }

  /** The keys of the settings file of before the core, each into its plugin's store, once. */
  private migrateSettings(): void {
    const file = this.o.legacySettings;
    const dir = this.o.dataDir;
    if (file === undefined || dir === undefined) return;
    const source = path.join(dir, file);
    let old: Record<string, unknown>;
    try {
      old = JSON.parse(fs.readFileSync(source, 'utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    const schemas: [string, z.ZodObject][] = [
      ...(this.o.settings === undefined ? [] : [[CORE, this.o.settings] as [string, z.ZodObject]]),
      ...[...this.entries.values()].flatMap((e) =>
        e.manifest.settings === undefined
          ? []
          : [[e.id, e.manifest.settings] as [string, z.ZodObject]]
      ),
    ];
    const ownerOf = (key: string): string | undefined => {
      const owners = schemas.filter(([, schema]) => Object.hasOwn(schema.shape, key));
      return owners.length === 1 ? owners[0]?.[0] : undefined;
    };
    const byPlugin = new Map<string, Record<string, unknown>>();
    const orphans: string[] = [];
    for (const [key, value] of Object.entries(old)) {
      const owner = ownerOf(key);
      if (owner === undefined) orphans.push(key);
      else byPlugin.set(owner, { ...byPlugin.get(owner), [key]: value });
    }
    for (const [plugin, values] of byPlugin) {
      const store = this.stores.internal(plugin);
      // A plugin that has its own already is not overwritten by the old file.
      if (store.get(SETTINGS_DOC) === undefined) store.put(SETTINGS_DOC, values);
    }
    // A file migrated before (an older image ran meanwhile) is never overwritten.
    const kept = fs.existsSync(`${source}.migrated`)
      ? `${source}.migrated.${this.o.clock.now()}`
      : `${source}.migrated`;
    fs.renameSync(source, kept);
    (this.o.print ?? (() => {}))(
      `core: ${file} migrated into ${[...byPlugin.keys()].join(', ') || 'no plugin'}` +
        (orphans.length === 0
          ? ''
          : `; no plugin has ${orphans.join(', ')}, kept in ${path.basename(kept)}`)
    );
  }

  /** Stops the plugins running or paused, in the reverse order, keeping what they serialise. */
  async stop(): Promise<void> {
    for (const entry of [...this.entries.values()].reverse()) {
      const { instance, status } = entry;
      if (instance === undefined || (status.state !== 'running' && status.state !== 'paused'))
        continue;
      this.set(entry, 'stopping');
      entry.scheduler?.disarm();
      this.bus.drop(entry.id);
      try {
        if (instance.serialise !== undefined)
          this.stores.internal(entry.id).put(RESTORE, instance.serialise());
        await this.withTimeout(() => instance.stop?.(), entry.id);
      } catch (e) {
        this.logger(entry.id).error(`stop failed: ${message(e)}`);
      }
      this.set(entry, 'stopped');
    }
  }

  /** Pauses a running plugin, with why (drift, or the owner); false if it is not running. */
  pause(id: string, reason: string): boolean {
    const entry = this.entries.get(id);
    if (entry?.status.state !== 'running') return false;
    this.set(entry, 'paused', reason);
    entry.instance?.pause?.(reason);
    return true;
  }

  /**
   * Pauses a running or paused plugin as the owner killed it (D44, `KILLED`), whatever paused it
   * before; false if it is neither.
   */
  killNode(id: string): boolean {
    const entry = this.entries.get(id);
    const was = entry?.status.state;
    if (entry === undefined || (was !== 'running' && was !== 'paused')) return false;
    this.set(entry, 'paused', KILLED);
    if (was === 'running') entry.instance?.pause?.(KILLED);
    return true;
  }

  /** Resumes a paused plugin (the owner's word only); false if it is not paused. */
  resume(id: string): boolean {
    const entry = this.entries.get(id);
    if (entry?.status.state !== 'paused') return false;
    this.set(entry, 'running');
    entry.instance?.resume?.();
    return true;
  }

  /**
   * The manifests checked, the graph checked against them (§2.1), and the instances in the order
   * their required edges make.
   */
  private order(): Map<string, Entry> {
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
    let resolved: ReturnType<typeof resolveGraph>;
    let ordered: ResolvedNode[];
    try {
      const given = this.o.graph;
      const defaults = (): Graph => defaultGraph([...manifests.values()], this.o.config);
      resolved = resolveGraph(
        typeof given === 'function' ? given(defaults()) : (given ?? defaults()),
        manifests
      );
      ordered = loadOrder(resolved.nodes);
    } catch (e) {
      if (e instanceof GraphError) throw new StartError([...problems, ...e.problems].join('\n'));
      throw e;
    }
    if (this.o.allowArchived !== true)
      for (const node of resolved.nodes)
        if (node.manifest.archived)
          problems.push(
            `plugin ${node.id}: ${node.manifest.id} is archived (bot-os.md D32): it runs in no instance, only in a run that allows archives`
          );
    this.loadedGraph = resolved.graph;
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
      problems.push(...this.bus.register(id, manifest));
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
    if (problems.length > 0) throw new StartError(problems.join('\n'));
    return entries;
  }

  private async startOne(entry: Entry): Promise<void> {
    const { id } = entry;
    const down = requiredOf(entry.node).find((r) => this.entries.get(r)?.status.state === 'failed');
    if (down !== undefined) {
      this.fail(entry, `requires ${down}, which failed`);
      return;
    }
    this.set(entry, 'starting');
    try {
      await this.stores.migrate(id, entry.manifest.state.migrations as Migration[]);
      const instance = await entry.plugin.create(this.contextFor(entry));
      entry.instance = instance;
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
    } catch (e) {
      this.fail(entry, message(e));
      return;
    }
    this.set(entry, 'running');
    entry.scheduler?.arm();
    // The owner's notices made before its surface existed, in order.
    const surface = id === this.o.owner ? this.ownerSurface() : undefined;
    for (const [text, buttons] of surface === undefined ? [] : this.pendingTells.splice(0))
      surface?.tell(text, buttons);
  }

  private async readyOne(entry: Entry): Promise<void> {
    const { instance, status } = entry;
    if (instance?.ready === undefined) return;
    if (status.state !== 'running' && status.state !== 'paused') return;
    try {
      await instance.ready();
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
      const { state } = other.status;
      if ((state === 'running' || state === 'paused') && requiredOf(other.node).includes(entry.id))
        await this.failRunning(other, `requires ${entry.id}, which failed`);
    }
  }

  private contextFor(entry: Entry): PluginContext {
    const { id, node } = entry;
    const kept = this.stores.internal(id);
    const restored = kept.get(RESTORE);
    // Handed back once: a crash before the next stop must not restore it a second time.
    kept.backend.delete(RESTORE);
    const log = this.logger(id);
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
          onTimer.call(entry.instance, name, payload);
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
    return {
      id,
      log,
      clock: this.o.clock,
      store: this.stores.open(id),
      config: entry.config,
      ...(entry.manifest.kinds.includes('connector') ? { secrets: this.secretsOf(id) } : {}),
      scheduler,
      bus: this.bus.handle(id, entry.manifest, sourcesOf(node), log),
      drift: this.driftMonitor.reporter(id),
      outbox: (key) => {
        const bound = this.chatInput(node, key);
        const holder = bound === undefined ? undefined : this.entries.get(bound[1].node);
        if (holder?.node.account === undefined)
          throw new Error(`${id} has no reach on the account ${key}: no edge binds it`);
        return this.outbox(holder.node.account).as(id);
      },
      connector: (key) => {
        const bound = this.chatInput(node, key);
        if (bound === undefined)
          throw new Error(`${id} has no reach on ${key}: no edge binds a chat input of it`);
        const c = this.connector(bound[1].node);
        if (c === undefined) throw new Error(`${bound[1].node} is not a running connector`);
        // It hears only the chats its edge reads (P6).
        return handleOf(c, bound[1].chat?.reads ?? []);
      },
      use: <T>(key: string): T => {
        const used = this.interfaceOf(entry, key);
        if (used === undefined) throw new Error(`${key} is not running`);
        return used as T;
      },
      useOptional: <T>(key: string): T | undefined => this.interfaceOf(entry, key) as T | undefined,
      settings: {
        kept: () => this.settings.of(id)?.kept() ?? {},
        set: (key, raw) => this.settings.set(`${id}.${key}`, raw),
      },
      notify: (text, buttons) => this.tell(text, buttons),
      mode: {
        get: () => this.modes.get(id),
        set: (mode, by = 'owner') => this.modes.set(id, mode, by),
        onChange: (listener) =>
          this.modes.onChange((plugin, mode) => {
            if (plugin === id) listener(mode);
          }),
      },
      off: () => this.controls.off,
      resume: () => this.resume(id),
      render: this.o.render ?? resvgRender,
      ...(restored === undefined ? {} : { restored }),
    };
  }

  /** A connector's way to its declared secrets. */
  private secretsOf(id: string): { get(name: string): string } {
    return {
      get: (name) => this.secretFor(id, name),
    };
  }

  /**
   * A node's chat input `key` (a port's name; or, by the other end, a connector instance's id or
   * its account) and its edge; undefined if no edge binds one.
   */
  private chatInput(node: ResolvedNode, key: string): [string, Binding] | undefined {
    const chats = chatsOf(node);
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
    const named = node.manifest.inputs[key];
    const port =
      named?.type === 'interface'
        ? key
        : [...node.inputs].find(
            ([p, bs]) =>
              node.manifest.inputs[p]?.type === 'interface' && bs.some((b) => b.node === key)
          )?.[0];
    const input = port === undefined ? undefined : node.manifest.inputs[port];
    if (port === undefined || input?.type !== 'interface')
      throw new Error(`${entry.id} does not use ${key}: add an interface input of it`);
    const other = node.inputs.get(port)?.[0]?.node;
    const e = other === undefined ? undefined : this.entries.get(other);
    if (e?.status.state !== 'running' && e?.status.state !== 'paused') return undefined;
    return interfaceOf(e.id, e.instance?.interface ?? {}, input.members);
  }

  private fail(entry: Entry, why: string): void {
    const reason = this.o.secrets?.redact(why) ?? why;
    entry.scheduler?.disarm();
    this.bus.drop(entry.id);
    this.set(entry, 'failed', reason);
    this.logger(entry.id).error(`failed: ${reason}`);
    this.tell(`Plugin ${entry.id} failed: ${reason}`);
  }

  private set(entry: Entry, state: PluginState, reason?: string): void {
    entry.status = { id: entry.id, state, ...(reason === undefined ? {} : { reason }) };
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

/** A node's chat inputs that an edge binds, each with its edge. */
function chatsOf(node: ResolvedNode): [string, Binding][] {
  return [...node.inputs].flatMap(([port, bs]) =>
    bs.filter((b) => b.type === 'chat').map((b): [string, Binding] => [port, b])
  );
}

/** The nodes whose events a node hears, by namespace: its edges', and its own of its namespaces. */
function sourcesOf(node: ResolvedNode): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (ns: string, from: string): void => {
    out.set(ns, (out.get(ns) ?? new Set()).add(from));
  };
  for (const ns of node.manifest.games.registers) add(ns, node.id);
  for (const [port, bs] of node.inputs) {
    const input = node.manifest.inputs[port];
    if (input?.type !== 'events') continue;
    if (!out.has(input.namespace)) out.set(input.namespace, new Set());
    for (const b of bs) add(input.namespace, b.node);
  }
  return out;
}

/** The members of a plugin's interface that another uses, and only those. */
function interfaceOf(
  id: string,
  offered: PluginInterface,
  members: readonly string[]
): PluginInterface {
  const out: { state: Record<string, () => unknown>; actions: Record<string, unknown> } = {
    state: {},
    actions: {},
  };
  for (const member of members) {
    const [part, name] = member.split('.', 2) as ['state' | 'actions', string];
    const fn = (offered[part] as Record<string, unknown> | undefined)?.[name];
    if (typeof fn !== 'function') throw new Error(`${id} does not offer ${member}`);
    out[part][name] = fn;
  }
  return out as PluginInterface;
}
