/**
 * A reaction (docs/bot-os-api.md §4.15): when something happens, send a command. The building block
 * of the `reactor` plugin, and of any plugin that reacts as its conditions change: it calls
 * `react` as often as it likes, and stops each reaction with the function it returns.
 *
 * - **What it reacts to** (`on`): an event type (`dice.roll`) or a namespace (`dice`) on the bus,
 *   among those its events inputs consume (or its own); or the messages read on one of its
 *   chat-in inputs, of some chats or all its edge reads, whose text contains a text or matches a
 *   regular expression, played back and its own account's never.
 * - **The payload** it reads: the event as published (`{ type, t, instance, ...payload }`); for a
 *   message, `{ chat, sender, text, time, id?, replyTo? }` with the named groups of a regular
 *   expression beside them (a group of one of those names is shadowed).
 * - **When** (`when`): fields of the payload, by dotted path (`outcome.kind`), each equal to its
 *   value; every one must be.
 * - **What it sends** (`send`) and **where** (`chat`): a text whose `{path}`s are the payload's
 *   values at those paths, or a function of the payload. A path with no value there (or one that
 *   is not a string, number or boolean) sends nothing: the reaction is skipped and recorded, never
 *   sent half made.
 * - **How:** through the outbox of its chat-out output `via` (`enqueue`), so its mode, the edge's reach,
 *   the account's pacing and the `core.send` log all apply. An event older than `maxAgeMs` (a
 *   parser's replay of its history at start) is skipped, so that history is never acted on twice.
 * - **Its trace:** each reaction, sent, refused, dry run or skipped, is written with `ctx.record` as
 *   `record` (a type of its plugin's namespace, `reactor.reaction`).
 *
 * Nothing in here knows of any game.
 */
import { type Inbound } from './connector.ts';
import { type PluginContext } from './plugin.ts';

/** What a reaction reads: an event as published, or a message with its pattern's groups. */
export type ReactionPayload = Readonly<Record<string, unknown>>;

/** A text with `{path}` placeholders, or a function of the payload (undefined: send nothing). */
export type ReactionText = string | ((payload: ReactionPayload) => string | undefined);

/** The messages read on a chat-in input that a reaction reacts to. */
export interface MessageTrigger {
  /** The chat-in input whose messages it reads, by port; `chat` by default. */
  port?: string;
  /** The chats it reacts in (compared without case); none: every chat its edge reads. */
  chats?: readonly string[];
  /** A text the message contains, or a regular expression it matches (its named groups read). */
  match: string | RegExp;
}

export interface Reaction {
  /** An event type (`dice.roll`) or a namespace (`dice`) on the bus, or messages on a chat-in input. */
  on: string | MessageTrigger;
  /** Fields of the payload by dotted path, each equal to its value; none: every one. */
  when?: Readonly<Record<string, unknown>>;
  /** The chat it sends to. */
  chat: ReactionText;
  /** What it sends. */
  send: ReactionText;
  /** The chat-out output whose outbox it sends through, by port; `chat` by default. */
  via?: string;
  /** The type of its records: of its plugin's id or a namespace it registers (`ctx.record`). */
  record: string;
  /** Its name in its records and the `core.send` log (the outbox's `origin`); `react` by default. */
  name?: string;
  /** How old an event may be and still be reacted to; two minutes by default. */
  maxAgeMs?: number;
}

/** How old an event may be, by default, and still be reacted to: no replay is news. */
export const REACT_MAX_AGE_MS = 2 * 60_000;

/** A `{path}` placeholder: a name, then dotted names or indices. */
const PLACEHOLDER = /\{([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\}/gu;

/** The value at a dotted path of a payload; undefined where a step is missing. */
export function valueAt(payload: unknown, path: string): unknown {
  let at: unknown = payload;
  for (const key of path.split('.')) {
    if (typeof at !== 'object' || at === null || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** Whether every field of `when` is equal (`===`) to the payload's at its path. */
export function matches(payload: unknown, when: Readonly<Record<string, unknown>> = {}): boolean {
  return Object.entries(when).every(([path, value]) => valueAt(payload, path) === value);
}

/**
 * Whether every field of `when` holds of the payload (a queued send's cancel, bot-os.md D73): equal
 * to the value at its path, as `matches` asks, or, for a list there, among its items (a state's
 * `changed.sections` holding `inventory`).
 */
export function holds(payload: unknown, when: Readonly<Record<string, unknown>> = {}): boolean {
  return Object.entries(when).every(([path, value]) => {
    const at = valueAt(payload, path);
    return at === value || (Array.isArray(at) && at.includes(value));
  });
}

/**
 * A text made from a payload: each `{path}` of a template replaced by its value there (a string, a
 * number or a boolean), or what a function returns. `missing` names a path with no such value (or
 * a function that returned nothing): nothing is to be sent.
 */
export function fill(
  text: ReactionText,
  payload: ReactionPayload
): { text: string } | { missing: string } {
  if (typeof text === 'function') {
    const made = text(payload);
    return made === undefined || made === ''
      ? { missing: '(the function made no text)' }
      : { text: made };
  }
  let missing: string | undefined;
  const made = text.replace(PLACEHOLDER, (whole, path: string) => {
    const v = valueAt(payload, path);
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    missing ??= path;
    return whole;
  });
  return missing === undefined ? { text: made } : { missing };
}

/** A message's payload: its fields, beside the named groups of the pattern it matched. */
function messagePayload(m: Inbound, match: string | RegExp): ReactionPayload | undefined {
  let groups: Record<string, unknown> = {};
  if (typeof match === 'string') {
    if (!m.text.includes(match)) return undefined;
  } else {
    const found = new RegExp(match.source, match.flags.replace(/[gy]/gu, '')).exec(m.text);
    if (found === null) return undefined;
    groups = { ...found.groups };
  }
  return {
    ...groups,
    chat: m.chat,
    sender: m.sender,
    text: m.text,
    time: m.time,
    ...(m.id === undefined ? {} : { id: m.id }),
    ...(m.replyTo === undefined ? {} : { replyTo: m.replyTo }),
    ...(m.document === undefined ? {} : { document: m.document }),
  };
}

/**
 * Reacts to an event or a message with a send, as `reaction` says, until the function it returns
 * is called. Throws, as the context does, for a namespace its events inputs do not consume, an
 * event type nobody registers, or a chat-in input no edge binds.
 */
export function react(ctx: PluginContext, reaction: Reaction): () => void {
  const name = reaction.name ?? 'react';
  const via = reaction.via ?? 'chat';
  const maxAgeMs = reaction.maxAgeMs ?? REACT_MAX_AGE_MS;
  const trigger = typeof reaction.on === 'string' ? reaction.on : 'message';
  let live = true;
  const trace = (fields: Record<string, unknown>): void =>
    ctx.record(reaction.record, { reaction: name, on: trigger, ...fields });

  const act = (payload: ReactionPayload): void => {
    if (!live || !matches(payload, reaction.when)) return;
    const chat = fill(reaction.chat, payload);
    const text = fill(reaction.send, payload);
    if ('missing' in chat || 'missing' in text) {
      const path = 'missing' in chat ? chat.missing : (text as { missing: string }).missing;
      trace({ outcome: 'skipped', reason: `no value at ${path}` });
      return;
    }
    let sending;
    try {
      sending = ctx.outbox(via).enqueue(chat.text, text.text, { origin: name });
    } catch (e) {
      trace({
        outcome: 'refused',
        reason: e instanceof Error ? e.message : String(e),
        chat: chat.text,
        text: text.text,
      });
      return;
    }
    void sending.then((r) =>
      trace({
        outcome: r.outcome,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        chat: chat.text,
        text: r.text,
      })
    );
  };

  let unsubscribe: () => void;
  if (typeof reaction.on === 'string') {
    unsubscribe = ctx.bus.subscribe(reaction.on, (event) => {
      if (ctx.clock.now() - event.t > maxAgeMs) {
        if (live && matches(event, reaction.when))
          trace({
            outcome: 'skipped',
            reason: `an event of ${new Date(event.t).toISOString()}, too old`,
          });
        return;
      }
      act(event);
    });
  } else {
    const { port = 'chat', chats, match } = reaction.on;
    const wanted = chats?.map((c) => c.toLowerCase());
    unsubscribe = ctx.connector(port).onMessage((m) => {
      if (m.playback || m.own === true) return;
      if (wanted !== undefined && !wanted.includes(m.chat.toLowerCase())) return;
      const payload = messagePayload(m, match);
      if (payload !== undefined) act(payload);
    });
  }
  return () => {
    live = false;
    unsubscribe();
  };
}
