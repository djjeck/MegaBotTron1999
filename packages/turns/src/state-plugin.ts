/**
 * The base of the state plugins (docs/bot-os-api.md §5, bot-os.md D72): a game's player state (an
 * inventory, a character sheet), kept by the shell from the events its parsers publish. A game
 * gives `statePlugin` a spec: the state's zod schema (its top-level keys are its **sections**,
 * their `.describe()`s the viewer's labels), the state it starts from, the event types it applies,
 * a pure reducer, and optionally the freshness each event gives the sections it touches and named
 * queries. The shell does the rest:
 *
 * - **Applies** each event of its types, heard live on the bus from the nodes its events edges
 *   bind (required: a parser disabled or stopped makes it inactive, and what requires it, D65),
 *   with the reducer; a reducer that throws, or makes a state its schema refuses, leaves the
 *   state as it was, and the event is recorded as refused (`<id>.refused`) and passed.
 * - **Keeps** `{ state, updatedAt, cursor, freshness }` in its store (`state`), so that it
 *   survives restarts (P8).
 * - **Resumes from its cursor** (D72): at start it reads the event log after its cursor, applies
 *   what it finds of its types in order, and goes live in the same step, so each event is applied
 *   exactly once across restarts and day files, those published while it was down or stopped
 *   included. A fresh instance reads the whole log.
 * - **Announces** each applied event that changed something as `<id>.changed` (the sections whose
 *   value changed, and those whose freshness did), after the state is kept: a crash between the
 *   two announces it again at the next start, so a change is announced at least once, never lost.
 * - **Tells what happened** in the spec's own events (`events`, `announce`: an item gained, a level
 *   reached, D83), for an event applied live and not played back alone: news, never history. Each
 *   is checked against its schema and published after the state is kept, with its event's time;
 *   kept nowhere, so a crash before it loses it, and the catch-up at start makes none.
 * - **Offers** its interface: `state.get({ path? })`, `state.freshness({ section? })` and the
 *   spec's queries; and its view, for the node panel's generic viewer and its card's line, from
 *   its node's `pin` (`config.pin`, dotted paths drawn first).
 *
 * It never sends: acquiring a piece of state (a command that makes the bot list an inventory) is
 * the acting nodes' business, through their outbox's queue (§4.6).
 */
import {
  behind,
  type BusEvent,
  definePlugin,
  type LogCursor,
  type LogPosition,
  type Plugin,
  schemaAtPath,
  type SectionFreshness,
  type StateView,
  summaryOf,
  valueAtPath,
} from '@megabottron1999/core';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

/**
 * What an event says of a section's freshness: a full `snapshot` of it (its deltas counted from
 * zero again), a `delta` known exactly, or an `uncertain` one (an unknown change: a loss the bot
 * did not itemise).
 */
export type Mark = 'snapshot' | 'delta' | 'uncertain';

/** A named query of a state: a pure function of it, offered as a read of its interface. */
export interface StateQuery<S> {
  help: string;
  /** Its input, an object whose fields are its arguments; none: it takes none. */
  input?: z.ZodObject;
  output: z.ZodType;
  run(state: S, input: never): unknown;
}

export interface StateSpec<S extends Record<string, unknown>> {
  /** The plugin's id, and its namespace (`<id>.changed`). */
  id: string;
  description: string;
  version?: string;
  /** The state's schema: an object, whose keys are its sections, each `.describe()`d for the viewer. */
  schema: z.ZodObject;
  /** The state a fresh instance starts from. */
  initial: S;
  /**
   * The event types it applies (`quest.inventory`), heard through a required events input per
   * namespace.
   */
  consumes: readonly string[];
  /** The next state, from the state and an event of its types: pure, never changing its arguments. */
  reduce(state: S, event: BusEvent): S;
  /**
   * What an event says of the freshness of the sections it touches, from the event and the
   * sections whose value it changed: by default, each changed section a `delta`. A section may be
   * marked without changing (a snapshot that confirms it).
   */
  freshness?(event: BusEvent, changed: readonly string[]): Partial<Record<string, Mark>>;
  /** Named queries, offered beside `get` and `freshness` as reads of its interface. */
  queries?: Record<string, StateQuery<S>>;
  /**
   * Its own events (D83), by name (`gained`: `<id>.gained`), each with its payload's schema,
   * declared beside `<id>.changed`; `changed` and `refused` are its own already.
   */
  events?: Record<string, z.ZodObject>;
  /**
   * What an applied event means, in its own events (D83): pure, from the state before it, the
   * state after it and the event. Called only for news: an event applied live (not one refused,
   * nor one the catch-up at start reads from the log) that is not played back (`playback: true`,
   * derived from a message of history). Each is published once the state is kept, in order, with
   * the event's time; best effort: never kept, never published again after a crash.
   */
  announce?(before: S, after: S, event: BusEvent): readonly Announcement[];
  /**
   * The store's migrations (§4.2, the manifest's `state`), in order, for a kept state whose schema
   * changed: one that does not fit the schema fails the node, with why.
   */
  migrations?: readonly ((...args: never[]) => unknown)[];
}

/** The store's document of the state, and of the last announcement made. */
export const STATE_DOC = 'state';
export const ANNOUNCED_DOC = 'announced';

/** One announcement of a change: `<id>.changed`'s payload. */
export interface Changed {
  /** The sections whose value changed. */
  sections: string[];
  /** The sections whose freshness changed (a snapshot, a delta, an uncertain one). */
  refreshed: string[];
  /** The event applied; none for the sum of a catch-up at start. */
  event?: { type: string; t: number };
}

/** One of the spec's own events (D83): its name (`gained`), and its payload. */
export interface Announcement {
  type: string;
  payload: Record<string, unknown>;
}

/** An announcement of the spec's, checked and waiting: its full type, its payload, its time. */
interface Announced {
  type: string;
  payload: Record<string, unknown>;
  t: number;
}

/** What the store keeps. */
interface Kept<S> {
  state: S;
  /** When the state last changed (ms). */
  updatedAt?: number;
  cursor: LogCursor;
  freshness: Record<string, SectionFreshness>;
  /** The number of the last batch of announcements, and those not known announced yet. */
  batch: number;
  unannounced: Changed[];
}

const TYPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][A-Za-z0-9]*$/u;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const RESERVED = new Set(['get', 'freshness']);
const OWN_EVENTS = new Set(['changed', 'refused']);
const EVENT_NAME = /^[a-z][A-Za-z0-9]*$/u;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const stampSchema = z.object({ t: z.number(), event: z.string() });
const freshnessSchema = z.object({
  snapshot: stampSchema.optional().describe('The last full snapshot of the section'),
  deltas: z.number().describe('Changes since the snapshot'),
  uncertain: z.number().describe('Of them, the uncertain ones'),
  updated: stampSchema.optional().describe('Its last change'),
});

/** The input ports of a state's consumed namespaces: `events`, or `<ns>-events` for several. */
function inputsOf(consumes: readonly string[]) {
  const namespaces = [...new Set(consumes.map((t) => t.slice(0, t.indexOf('.'))))];
  return Object.fromEntries(
    namespaces.map((ns) => [
      namespaces.length === 1 ? 'events' : `${ns}-events`,
      {
        type: 'events' as const,
        namespace: ns,
        help: `The nodes whose ${consumes.filter((t) => t.startsWith(`${ns}.`)).join(', ')} it applies`,
      },
    ])
  );
}

/** A state plugin of a game, from its spec (code a game gives). */
export function statePlugin<S extends Record<string, unknown>>(spec: StateSpec<S>): Plugin {
  const fail = (why: string): never => {
    throw new Error(`state plugin ${spec.id}: ${why}`);
  };
  if (!ID.test(spec.id)) fail('its id is lower-case words and dashes');
  if (spec.consumes.length === 0) fail('it consumes no event type');
  for (const t of spec.consumes) {
    if (!TYPE.test(t)) fail(`${t} is not an event type, <namespace>.<name>`);
    if (t.startsWith(`${spec.id}.`)) fail(`it cannot consume its own ${t}`);
  }
  for (const q of Object.keys(spec.queries ?? {}))
    if (RESERVED.has(q)) fail(`a query cannot be named ${q}`);
  const own = Object.entries(spec.events ?? {});
  for (const [name] of own) {
    if (!EVENT_NAME.test(name)) fail(`${name} is not an event's name, as gained`);
    if (OWN_EVENTS.has(name)) fail(`an event cannot be named ${name}`);
  }
  if (spec.announce !== undefined && own.length === 0) fail('it announces, but declares no event');
  const initial = spec.schema.safeParse(spec.initial);
  if (!initial.success) fail(`its initial state does not fit its schema: ${initial.error.message}`);
  const sections = Object.keys(spec.schema.shape);
  const viewSchema = z.toJSONSchema(spec.schema, { io: 'output', unrepresentable: 'any' });
  const config = z.object({
    pin: z
      .array(
        z
          .string()
          .min(1)
          .refine((p) => schemaAtPath(viewSchema, p) !== undefined, 'no such path in the state')
      )
      .default([])
      .describe(
        'Paths of the state (dotted: inventory.items) drawn first in its panel; the first two make the line on its card'
      ),
  });
  const queries = Object.entries(spec.queries ?? {});
  return definePlugin({
    manifest: {
      id: spec.id,
      version: spec.version ?? '0.1.0',
      kinds: ['stats'],
      description: spec.description,
      games: { registers: [spec.id] },
      events: {
        [`${spec.id}.changed`]: z
          .object({
            sections: z.array(z.string()),
            refreshed: z.array(z.string()),
            event: z.object({ type: z.string(), t: z.number() }).optional(),
          })
          .describe('Its state changed: the sections whose value or freshness did, and the event'),
        ...Object.fromEntries(own.map(([name, schema]) => [`${spec.id}.${name}`, schema])),
      },
      inputs: inputsOf(spec.consumes),
      config,
      ...(spec.migrations === undefined ? {} : { state: { migrations: [...spec.migrations] } }),
      interface: {
        state: {
          get: {
            help: 'The state, or the value at a dotted path of it (inventory.items)',
            input: z.object({ path: z.string().optional() }),
            output: z.unknown(),
          },
          freshness: {
            help: `How fresh each section is (${sections.join(', ')}), or one: its last snapshot, the deltas since, the uncertain ones`,
            input: z.object({ section: z.string().optional() }),
            output: z.union([freshnessSchema, z.record(z.string(), freshnessSchema)]),
          },
          ...Object.fromEntries(
            queries.map(([name, q]) => [
              name,
              {
                help: q.help,
                ...(q.input === undefined ? {} : { input: q.input }),
                output: q.output,
              },
            ])
          ),
        },
      },
    },
    create: (ctx) => {
      const pin = (ctx.config as z.output<typeof config>).pin;
      const kept = ctx.store.read<Kept<S>>(STATE_DOC);
      let state: S = kept?.state ?? structuredClone(spec.initial);
      if (kept !== undefined) {
        const fits = spec.schema.safeParse(kept.state);
        if (!fits.success)
          fail(
            `its kept state does not fit its schema (a migration is missing): ${fits.error.message}`
          );
      }
      let updatedAt = kept?.updatedAt;
      let cursor: LogCursor = { ...kept?.cursor };
      const freshness: Record<string, SectionFreshness> = { ...kept?.freshness };
      let batch = kept?.batch ?? 0;
      const announced = ctx.store.read<{ batch: number }>(ANNOUNCED_DOC)?.batch ?? 0;
      /** The announcements of what was applied since the last save. */
      let pending: Changed[] = [];
      /** The spec's own events of the news applied since the last save (D83): never kept. */
      let news: Announced[] = [];
      let dirty = false;
      let scheduled = false;
      let live = false;

      /** Keeps the state, then announces what changed, then notes it announced. */
      const save = (): void => {
        scheduled = false;
        if (!dirty) return;
        dirty = false;
        const out = pending;
        pending = [];
        if (out.length > 0) batch += 1;
        ctx.store.write(STATE_DOC, {
          state,
          ...(updatedAt === undefined ? {} : { updatedAt }),
          cursor,
          freshness,
          batch,
          unannounced: out,
        } satisfies Kept<S>);
        announce(out, batch);
        const said = news;
        news = [];
        for (const a of said) ctx.bus.publish(a.type, a.payload, a.t);
      };
      const announce = (out: readonly Changed[], n: number): void => {
        if (out.length === 0) return;
        for (const c of out) ctx.bus.publish(`${spec.id}.changed`, { ...c });
        ctx.store.write(ANNOUNCED_DOC, { batch: n });
      };
      // Live, a save waits for the end of the synchronous delivery: an event another subscriber
      // publishes while handling one is delivered before the rest of it, so the cursor may pass
      // an event not applied yet; once the delivery is over, every event behind it is applied.
      const later = (): void => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(save);
      };

      const mark = (section: string, how: Mark, stamp: { t: number; event: string }): void => {
        const f = freshness[section] ?? { deltas: 0, uncertain: 0 };
        freshness[section] =
          how === 'snapshot'
            ? { snapshot: stamp, deltas: 0, uncertain: 0, updated: stamp }
            : {
                ...f,
                deltas: f.deltas + 1,
                uncertain: f.uncertain + (how === 'uncertain' ? 1 : 0),
                updated: stamp,
              };
      };

      /** Where the catch-up left the log: what is behind it was applied then. */
      let caught: LogCursor = {};

      /**
       * Applies one event of its types, and moves the cursor past it. Live, an event published
       * while another is delivered reaches it first, so the cursor only grows: it is kept once
       * the delivery is over, when everything behind it is applied.
       */
      const apply = (event: BusEvent, at: LogPosition | undefined, heard = false): void => {
        if (at !== undefined)
          cursor = { ...cursor, [at.day]: Math.max(cursor[at.day] ?? 0, at.end) };
        dirty = true;
        let next: S;
        try {
          next = spec.reduce(state, event);
          const fits = spec.schema.safeParse(next);
          if (!fits.success) throw new Error(`a state its schema refuses: ${fits.error.message}`);
        } catch (e) {
          ctx.log.warn(`${event.type} at ${event.t} not applied: ${message(e)}`);
          ctx.record(`${spec.id}.refused`, { event: event.type, at: event.t, reason: message(e) });
          return;
        }
        const changed = sections.filter((s) => !isDeepStrictEqual(state[s], next[s]));
        const marks: Partial<Record<string, Mark>> =
          spec.freshness?.(event, changed) ??
          Object.fromEntries(changed.map((s): [string, Mark] => [s, 'delta']));
        const stamp = { t: event.t, event: event.type };
        const refreshed = Object.entries(marks).flatMap(([s, how]) =>
          how === undefined || !sections.includes(s) ? [] : (mark(s, how, stamp), [s])
        );
        const before = state;
        state = next;
        if (changed.length > 0) updatedAt = ctx.clock.now();
        if (changed.length > 0 || refreshed.length > 0)
          pending.push({ sections: changed, refreshed, event: { type: event.type, t: event.t } });
        if (heard && event['playback'] !== true) news.push(...told(before, next, event));
      };

      /**
       * The spec's own events for an applied event (D83), each checked against its schema: one
       * not declared, or whose payload its schema refuses, is warned of and dropped, as are all
       * of an event's when `announce` throws; the state stays applied.
       */
      const told = (before: S, after: S, event: BusEvent): Announced[] => {
        if (spec.announce === undefined) return [];
        let made: readonly Announcement[];
        try {
          made = spec.announce(before, after, event);
        } catch (e) {
          ctx.log.warn(`${event.type} at ${event.t} announced nothing: ${message(e)}`);
          return [];
        }
        return made.flatMap((a): Announced[] => {
          const schema = spec.events?.[a.type];
          const checked = schema?.safeParse(a.payload);
          if (checked?.success !== true) {
            const why = checked === undefined ? 'no such event' : checked.error.message;
            ctx.log.warn(`${event.type} at ${event.t}: ${a.type} not announced: ${why}`);
            return [];
          }
          return [
            {
              type: `${spec.id}.${a.type}`,
              payload: checked.data,
              t: event.t,
            },
          ];
        });
      };

      const unsubscribe: (() => void)[] = [];
      const view = (): StateView => ({
        schema: viewSchema,
        state,
        ...(updatedAt === undefined ? {} : { updatedAt }),
        freshness,
        pin,
      });
      return {
        start() {
          // A crash between keeping the state and announcing its change: announced now.
          if (batch > announced && kept !== undefined) announce(kept.unannounced, batch);
          // Live and the catch-up in one step: nothing is published in between, so what the log
          // holds after the cursor is read now, and everything after it is heard live.
          // By namespace: its events inputs are bound to its parsers, each of a namespace.
          for (const ns of new Set(spec.consumes.map((t) => t.slice(0, t.indexOf('.')))))
            unsubscribe.push(
              ctx.bus.subscribe(ns, (e, at) => {
                if (!live || !spec.consumes.includes(e.type)) return;
                if (at !== undefined && behind(at, caught)) return;
                apply(e, at, true);
                later();
              })
            );
          const tail = ctx.events.after(cursor, { types: spec.consumes });
          for (const { entry, at } of tail.entries) apply(entry as BusEvent, at);
          cursor = tail.cursor;
          caught = tail.cursor;
          live = true;
          // The catch-up announced as one change, its sections summed; it tells nothing of what
          // happened (D83): history, not news.
          const applied = pending;
          pending =
            applied.length === 0
              ? []
              : [
                  {
                    sections: [...new Set(applied.flatMap((c) => c.sections))],
                    refreshed: [...new Set(applied.flatMap((c) => c.refreshed))],
                  },
                ];
          if (tail.entries.length > 0) ctx.log.info(`caught up: ${tail.entries.length} event(s)`);
          dirty =
            dirty || tail.entries.length > 0 || !isDeepStrictEqual(cursor, kept?.cursor ?? {});
          save();
        },
        stop() {
          live = false;
          for (const u of unsubscribe.splice(0)) u();
          save();
        },
        interface: {
          state: {
            get: (input: { path?: string } = {}) => structuredClone(valueAtPath(state, input.path)),
            freshness: (input: { section?: string } = {}) =>
              input.section === undefined
                ? structuredClone(freshness)
                : structuredClone(freshness[input.section] ?? { deltas: 0, uncertain: 0 }),
            ...Object.fromEntries(
              queries.map(([name, q]) => [
                name,
                (input?: unknown) => q.run(structuredClone(state), (input ?? {}) as never),
              ])
            ),
          },
        },
        view: { read: view, summary: () => summaryOf(view()) },
      };
    },
  });
}
