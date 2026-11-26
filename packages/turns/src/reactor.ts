/**
 * The reactor (docs/bot-os-api.md §5): one reaction (`react`, §4.15) made from its node's config,
 * with no code, run as one instance per reaction. When an event of its `on` type is heard (from the
 * nodes its `events` edges bind), or a message read on its `chat` input matches its `match`, and
 * the payload's fields equal its `when`, it sends its `send` to its `chat` through the outbox of its
 * `chat` output (chat-out, bot-os.md D60): within its edge's reach, a dry run while that edge is
 * one (D64; the editor draws a new one so), at the account's pace, each attempt logged as
 * `core.send` and each reaction recorded as `reactor.reaction`.
 *
 * Its `status` read (#7) gives its last reaction and its reactions by outcome, kept in its store
 * across restarts, and its node panel shows them (its `view`), its card a line of the counts.
 *
 * Its `events` input takes its namespace from `on` (§2.1): the namespace of the event type it
 * reacts to, there only with `on` and then required (the check refuses a reactor on events that no
 * edge binds, which would never fire). A reactor on messages has no such port; one on events has no
 * chat-in input (its `chat` input is there only with `match`), and only sends.
 */
import {
  definePlugin,
  type Plugin,
  react,
  type ReactionTrace,
  type StateView,
} from '@megabottron1999/core';
import { z } from 'zod';

export const REACTOR = 'reactor';

/** An event type (`dice.roll`) or a namespace (`dice`). */
const EVENTS = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][A-Za-z0-9]*)?$/u;

/** A reactor's configuration: what it reacts to, when, and what it sends where. */
export const reactorConfig = z
  .object({
    on: z
      .string()
      .regex(EVENTS, 'expected an event type, <namespace>.<name>, or a namespace')
      .optional()
      .describe(
        'The event type it reacts to (`dice.roll`), or a namespace, heard from the nodes its events edges bind. Or set `match`'
      ),
    match: z
      .string()
      .min(1)
      .refine((s) => {
        try {
          new RegExp(s, 'u');
          return true;
        } catch {
          return false;
        }
      }, 'expected a regular expression')
      .optional()
      .describe(
        'A regular expression the messages read on its chat input must match; its named groups, `(?<item>…)`, go into the payload. Or set `on`'
      ),
    in: z
      // A list (#7), as react() takes.
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        'With `match`: the chats whose messages it reads; every chat its edge reads if unset'
      ),
    ignoreCase: z.boolean().default(false).describe('With `match`: case does not matter'),
    when: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .default({})
      .describe(
        'Fields of the payload by dotted path, each equal to its value: `{ "outcome.kind": "gain" }`'
      ),
    chat: z
      .string()
      .min(1)
      .describe('The chat it sends to, a `{path}` template of the payload: `@QuestBot`, `{chat}`'),
    send: z
      .string()
      .min(1)
      .describe('What it sends, a `{path}` template of the payload: `/look {outcome.item}`'),
    maxAgeS: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'How old an event may be, in seconds, and still be reacted to; unset: any age (an event played back is skipped by its mark)'
      ),
  })
  .superRefine((c, ctx) => {
    if ((c.on === undefined) === (c.match === undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['on'],
        message: 'set either on (an event) or match (a message), not both',
      });
  });
export type ReactorConfig = z.output<typeof reactorConfig>;

/** Its last reaction, as its trace says it (`ReactionTrace`), with when. */
const lastReaction = z.object({
  at: z.string().describe('When, in UTC'),
  outcome: z.string().describe('What came of it: sent, dry-run, refused, skipped…'),
  reason: z.string().optional().describe('Why, when it was not sent'),
  chat: z.string().optional().describe('The chat it sent to'),
  text: z.string().optional().describe('What it sent'),
});

/** What its `status` read gives, and its node panel shows (#7). */
export const reactorStatus = z.object({
  last: lastReaction.optional().describe('Its last reaction'),
  counts: z
    .record(z.string(), z.number())
    .describe('Its reactions by outcome, since it was first started'),
  since: z.string().optional().describe('When it first reacted, in UTC'),
});
export type ReactorStatus = z.output<typeof reactorStatus>;

/** Where its status is kept, in its instance's store: it survives a restart. */
const STATUS_DOC = 'status';
const STATUS_SCHEMA = z.toJSONSchema(reactorStatus, { io: 'output', unrepresentable: 'any' });

/** Its card's line: its counts, sent first (`3 sent, 1 skipped`), or none before a reaction. */
export function statusLine(status: ReactorStatus): string | undefined {
  const order = (o: string): number => (o === 'sent' ? 0 : o === 'dry-run' ? 1 : 2);
  const parts = Object.entries(status.counts)
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([o, n]) => `${n} ${o}`);
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** The reactor plugin: one instance per reaction, each node with its own config. */
export function reactorPlugin(): Plugin {
  return definePlugin({
    manifest: {
      id: REACTOR,
      kinds: ['actor'],
      description:
        'Sends a command when an event is heard or a message matches, as its config says',
      config: reactorConfig,
      // The chat it sends to, and the one it reads, are picked among its connectors' (D96); the
      // chat it sends to may be a template instead (`{chat}`, the event's).
      configChats: [
        { key: 'chat', output: 'chat', template: true },
        { key: 'in', input: 'chat' },
      ],
      interface: {
        state: {
          status: {
            help: 'Its last reaction, and its reactions by outcome',
            output: reactorStatus,
          },
        },
      },
      inputs: {
        chat: {
          type: 'chat-in',
          when: { config: 'match' },
          help: 'With match: the account whose messages it reads, and the chats',
        },
        events: {
          type: 'events',
          namespace: { config: 'on' },
          // There only with `on`, and then required: a reactor on events no edge binds would
          // never fire, so the check refuses it.
          when: { config: 'on' },
          help: 'With on: the nodes whose events of its on type it hears',
        },
      },
      outputs: {
        chat: {
          type: 'chat-out',
          help: 'The account it sends through: the chat it sends to, and its commands',
        },
      },
    },
    create: (ctx) => {
      const c = ctx.config as ReactorConfig;
      let stop: (() => void) | undefined;
      let status: ReactorStatus = ctx.store.read<ReactorStatus>(STATUS_DOC) ?? { counts: {} };
      const observe = (t: ReactionTrace): void => {
        const now = new Date(ctx.clock.now()).toISOString();
        status = {
          last: {
            at: now,
            outcome: t.outcome,
            ...(t.reason === undefined ? {} : { reason: t.reason }),
            ...(t.chat === undefined ? {} : { chat: t.chat }),
            ...(t.text === undefined ? {} : { text: t.text }),
          },
          counts: { ...status.counts, [t.outcome]: (status.counts[t.outcome] ?? 0) + 1 },
          since: status.since ?? now,
        };
        ctx.store.write(STATUS_DOC, status);
      };
      const view = (): StateView => ({
        schema: STATUS_SCHEMA,
        state: status,
        ...(status.last === undefined ? {} : { updatedAt: Date.parse(status.last.at) }),
        pin: ['last'],
      });
      return {
        interface: { state: { status: () => status } },
        view: { read: view, summary: () => statusLine(status) },
        start() {
          stop = react(ctx, {
            on:
              c.on ??
              ({
                match: new RegExp(c.match as string, c.ignoreCase ? 'iu' : 'u'),
                ...(c.in === undefined ? {} : { chats: c.in }),
              } as const),
            when: c.when,
            chat: c.chat,
            send: c.send,
            record: `${REACTOR}.reaction`,
            name: ctx.id,
            observe,
            ...(c.maxAgeS === undefined ? {} : { maxAgeMs: c.maxAgeS * 1000 }),
          });
        },
        stop() {
          stop?.();
          stop = undefined;
        },
      };
    },
  });
}
