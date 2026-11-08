/**
 * Plugin instances apart from the nodes (docs/bot-os-api.md §2.2, bot-os.md D50): a plugin's kept
 * state (its store, its timers, its settings, its mode) belongs to an _instance_, filed under
 * `<data>/instances/<id>/`, and a node of the graph names the instance it runs on. So a node can be
 * removed and added again, or replaced by another node of the same plugin, and take its state up.
 *
 * Each instance keeps a small record of itself beside its documents (`_instance.json`): its plugin,
 * when it was made, and when a node last referenced it. An instance that no node of the saved graph
 * nor of the running one references for 7 days (`ORPHAN_MS`) is deleted; the core checks at start
 * and once a day (`sweep`).
 *
 * Nothing in here knows of any game.
 */
import { type Stores } from './store.ts';

/** The core's document, in each instance's store, of the instance itself. */
export const INSTANCE_DOC = '_instance';
/** How long an instance no node references is kept: 7 days. */
export const ORPHAN_MS = 7 * 86_400_000;

/** What an instance keeps of itself. */
export interface InstanceMeta {
  /** The plugin whose state it is: only a node of this plugin runs on it. */
  plugin: string;
  /** When it was made, and when a node last referenced it (ms). */
  created: number;
  referenced: number;
}

/** An instance, as the owner sees it (`GET /instances`). */
export interface InstanceInfo {
  id: string;
  /** Its plugin; none for a directory without its record (made by hand). */
  plugin?: string;
  created?: number;
  referenced?: number;
  /** The node of the running graph that runs on it, if any. */
  node?: string;
  /** Whether a node uses it: of the running graph, or of the saved one. */
  used: boolean;
}

const isMeta = (v: unknown): v is InstanceMeta =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as InstanceMeta).plugin === 'string' &&
  typeof (v as InstanceMeta).created === 'number' &&
  typeof (v as InstanceMeta).referenced === 'number';

/** The instances of one data volume (or of memory), their records and their expiry. */
export class InstanceRegistry {
  private readonly stores: Stores;
  private readonly now: () => number;

  constructor(stores: Stores, now: () => number) {
    this.stores = stores;
    this.now = now;
  }

  /** An instance's record; undefined for none, or one that does not read. */
  meta(id: string): InstanceMeta | undefined {
    if (!this.stores.ids().includes(id)) return undefined;
    try {
      const m = this.stores.internal(id).get(INSTANCE_DOC);
      return isMeta(m) ? m : undefined;
    } catch {
      return undefined;
    }
  }

  /** Records that a node of `plugin` references the instance now, making its record if new. */
  touch(id: string, plugin: string): void {
    const now = this.now();
    const m = this.meta(id);
    this.stores.internal(id).put(INSTANCE_DOC, {
      plugin: m?.plugin ?? plugin,
      created: m?.created ?? now,
      referenced: now,
    });
  }

  /** Makes a fresh instance's record; refused for an id kept already. */
  create(id: string, plugin: string): void {
    if (this.stores.ids().includes(id)) throw new Error(`the instance ${id} exists already`);
    this.touch(id, plugin);
  }

  /** Every instance kept, by id, with its record if it has one. */
  list(): { id: string; meta?: InstanceMeta }[] {
    return this.stores.ids().map((id) => {
      const meta = this.meta(id);
      return meta === undefined ? { id } : { id, meta };
    });
  }

  /**
   * The instances `referenced` touched now, and those that none has referenced for `ORPHAN_MS`
   * deleted: the ids deleted. An instance without its record is left alone.
   */
  sweep(referenced: ReadonlySet<string>): string[] {
    const deleted: string[] = [];
    for (const { id, meta } of this.list()) {
      if (meta === undefined) continue;
      if (referenced.has(id)) this.touch(id, meta.plugin);
      else if (this.now() - meta.referenced >= ORPHAN_MS) {
        this.stores.delete(id);
        deleted.push(id);
      }
    }
    return deleted;
  }
}
