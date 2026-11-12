/**
 * The reactor (docs/bot-os-api.md §5): one reaction (`react`, §4.15) made from its node's config,
 * with no code, run as one instance per reaction. When an event of its `on` type is heard (from the
 * nodes its `events` edges bind), or a message read on its `chat` input matches its `match`, and
 * the payload's fields equal its `when`, it sends its `send` to its `chat` through the outbox of its
 * `chat` output (chat-out, bot-os.md D60): within its edge's reach, a dry run while that edge is
 * one (D64; the editor draws a new one so), at the account's pace, each attempt logged as
 * `core.send` and each reaction recorded as `reactor.reaction`.
 *
 * Its `events` input takes its namespace from `on` (§2.1): the namespace of the event type it
 * reacts to. A reactor on messages has no such port; one on events has no chat-in input (its
 * `chat` input is there only with `match`), and only sends.
 */
import { definePlugin, type Plugin, react } from '@megabottron1999/core';
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
      .string()
      .min(1)
      .optional()
      .describe(
        'With `match`: the chat whose messages it reads; every chat its edge reads if unset'
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
      .default(120)
      .describe('How old an event may be, in seconds, and still be reacted to'),
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

/** The reactor plugin: one instance per reaction, each node with its own config. */
export function reactorPlugin(): Plugin {
  return definePlugin({
    manifest: {
      id: REACTOR,
      version: '0.1.0',
      kinds: ['actor'],
      description:
        'Sends a command when an event is heard or a message matches, as its config says',
      config: reactorConfig,
      inputs: {
        chat: {
          type: 'chat-in',
          when: { config: 'match' },
          help: 'With match: the account whose messages it reads, and the chats',
        },
        events: {
          type: 'events',
          namespace: { config: 'on' },
          optional: true,
          help: 'The nodes whose events of its on type it hears (none for a reactor on messages)',
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
      return {
        start() {
          stop = react(ctx, {
            on:
              c.on ??
              ({
                match: new RegExp(c.match as string, c.ignoreCase ? 'iu' : 'u'),
                ...(c.in === undefined ? {} : { chats: [c.in] }),
              } as const),
            when: c.when,
            chat: c.chat,
            send: c.send,
            record: `${REACTOR}.reaction`,
            name: ctx.id,
            maxAgeMs: c.maxAgeS * 1000,
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
