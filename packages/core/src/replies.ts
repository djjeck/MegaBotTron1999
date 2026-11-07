/**
 * Matching a bot's answer to the send that caused it (docs/bot-os-api.md §4.6), as far as each
 * network allows: by reply-to (Telegram), by a mention of the player who sent it (a bot that names
 * whom it answers), or within a time window of the send (a channel where nothing else ties them).
 * The matchers combine with `all`; `waitFor` waits on a connector handle for the first match.
 */
import { type Clock } from './clock.ts';
import { type ConnectorHandle, type Inbound } from './connector.ts';

export type Matcher = (m: Inbound) => boolean;

/** An answer to the message `id`. */
export const replyTo =
  (id: string): Matcher =>
  (m) =>
    m.replyTo === id;

/** A message that names `player`, as a word, with or without `@`. */
export function mentioning(player: string): Matcher {
  const escaped = player.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const word = new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?${escaped}(?![\\p{L}\\p{N}_])`, 'u');
  return (m) => word.test(m.text);
}

/** A message within `ms` after `sentAt`, live (not ZNC's playback). */
export const within =
  (sentAt: number, ms: number): Matcher =>
  (m) =>
    !m.playback && m.time >= sentAt && m.time - sentAt <= ms;

/** A message from `sender`. */
export const from =
  (sender: string): Matcher =>
  (m) =>
    m.sender === sender;

/** Every matcher at once. */
export const all =
  (...matchers: Matcher[]): Matcher =>
  (m) =>
    matchers.every((f) => f(m));

/** The first message on `connector` that matches, or undefined after `timeoutMs`. */
export function waitFor(
  connector: Pick<ConnectorHandle, 'onMessage'>,
  match: Matcher,
  timeoutMs: number,
  clock: Clock
): Promise<Inbound | undefined> {
  return new Promise((resolve) => {
    const timer = clock.setTimeout(() => {
      stop();
      resolve(undefined);
    }, timeoutMs);
    const stop = connector.onMessage((m) => {
      if (!match(m)) return;
      stop();
      clock.clearTimeout(timer);
      resolve(m);
    });
  });
}
