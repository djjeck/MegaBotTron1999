/**
 * The bus (docs/bot-os-api.md §4.4, P7): typed events from the plugins that register them to the
 * plugins that declared they consume them.
 *
 * - An event type is `<namespace>.<name>`, registered by one plugin's manifest with the zod schema
 *   of its payload; two plugins registering one type is an error of the deployment.
 * - A plugin publishes only the types it registered. Outside production the payload is checked
 *   against its schema, and a bad one throws; in production it is not, to spare the parse.
 * - A plugin instance subscribes to a type or a whole namespace, only among the namespaces of its
 *   events inputs or its own, and hears only the instances its edges bind (P6, §2.1). Delivery is synchronous, in order of subscription: an event has reached
 *   every subscriber before `publish` returns. A subscriber that throws is logged, and the others
 *   still get the event.
 * - Every event published is written to the event log, `{ type, t, ...payload }`.
 */
import { type z } from 'zod';
import { type Manifest } from './manifest.ts';
import { type Logger } from './plugin.ts';

/** An event as subscribers get it, and as the log keeps it. */
export interface BusEvent {
  type: string;
  t: number;
  [field: string]: unknown;
}

export interface BusHandle {
  /** Publishes an event of a type the plugin registered, at `t` (now if not given). */
  publish(type: string, payload: Record<string, unknown>, t?: number): void;
  /** Hears every event of `pattern`: a type, or a namespace. Returns the way to stop. */
  subscribe(pattern: string, handler: (event: BusEvent) => void): () => void;
}

interface Subscription {
  plugin: string;
  /** The instances whose events of its namespace it hears: the edges' (§2.1). */
  from: ReadonlySet<string>;
  pattern: string;
  handler: (event: BusEvent) => void;
  log: Logger;
}

export interface BusOptions {
  now: () => number;
  /** Where every event published goes: the event log. */
  record?: (event: BusEvent) => void;
  /** Whether payloads are checked against their schemas: outside production. */
  validate: boolean;
}

const namespaceOf = (type: string): string => type.slice(0, type.indexOf('.'));

export class Bus {
  private readonly o: BusOptions;
  /** Each type, with the plugin that registers it (any of its instances publishes it). */
  private readonly types = new Map<string, { owner: string; schema: z.ZodType }>();
  private subscriptions: Subscription[] = [];

  constructor(options: BusOptions) {
    this.o = options;
  }

  /**
   * The types an instance's manifest registers; why not, for each one another plugin has registered
   * (the instances of one plugin share its types).
   */
  register(instance: string, manifest: Manifest): string[] {
    const problems: string[] = [];
    for (const [type, schema] of Object.entries(manifest.events)) {
      const other = this.types.get(type);
      if (other !== undefined && other.owner !== manifest.id)
        problems.push(`plugin ${instance}: event ${type} is registered by ${other.owner} too`);
      else this.types.set(type, { owner: manifest.id, schema });
    }
    return problems;
  }

  /** The types registered, sorted. */
  registered(): string[] {
    return [...this.types.keys()].sort();
  }

  /**
   * An instance's way onto the bus: it publishes its plugin's types, and hears a namespace's events
   * from the instances its edges bind (`sources`, by namespace: its events inputs', and itself for
   * its own namespaces).
   */
  handle(
    instance: string,
    manifest: Manifest,
    sources: ReadonlyMap<string, ReadonlySet<string>>,
    log: Logger
  ): BusHandle {
    return {
      publish: (type, payload, t) => {
        const entry = this.types.get(type);
        if (entry === undefined) throw new Error(`no event type ${type} is registered`);
        if (entry.owner !== manifest.id)
          throw new Error(`${instance} cannot publish ${type}: ${entry.owner} registers it`);
        if (this.o.validate) {
          const result = entry.schema.safeParse(payload);
          if (!result.success)
            throw new Error(
              `${type}: ${result.error.issues.map((i) => `${i.path.join('.') || '(payload)'}: ${i.message}`).join('; ')}`
            );
        }
        // The type and the time first, as every record of the log has them; the payload's own
        // `type` or `t`, if any, never replaces them.
        const head = { type, t: t ?? this.o.now() };
        const event: BusEvent = Object.assign({ ...head }, payload, head);
        this.o.record?.(event);
        for (const s of [...this.subscriptions])
          if ((s.pattern === type || s.pattern === namespaceOf(type)) && s.from.has(instance)) {
            try {
              s.handler(event);
            } catch (e) {
              s.log.error(`on ${type}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
      },
      subscribe: (pattern, handler) => {
        const ns = pattern.includes('.') ? namespaceOf(pattern) : pattern;
        const from = sources.get(ns);
        if (from === undefined)
          throw new Error(`${instance} does not consume ${ns}: add an events input of it`);
        if (pattern.includes('.') && !this.types.has(pattern))
          throw new Error(`no event type ${pattern} is registered`);
        const s: Subscription = { plugin: instance, from, pattern, handler, log };
        this.subscriptions.push(s);
        return () => {
          this.subscriptions = this.subscriptions.filter((x) => x !== s);
        };
      },
    };
  }

  /** Drops every subscription of a plugin: it failed, or stopped. */
  drop(plugin: string): void {
    this.subscriptions = this.subscriptions.filter((s) => s.plugin !== plugin);
  }
}
