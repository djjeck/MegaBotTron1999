import { describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import { ConnectorBase, type Inbound } from './connector.ts';
import { all, from, mentioning, replyTo, waitFor, within } from './replies.ts';

const m = (o: Partial<Inbound>): Inbound => ({
  account: 'irc:alice',
  network: 'irc',
  chat: '#lobby',
  sender: 'GameBot',
  text: '',
  time: 1000,
  playback: false,
  ...o,
});

class Channel extends ConnectorBase {
  say(o: Partial<Inbound>): void {
    this.received(m(o));
  }
}

describe('the reply matchers', () => {
  it('match by reply-to, by mention, within a window, by sender, and all at once', () => {
    expect(replyTo('5')(m({ replyTo: '5' }))).toBe(true);
    expect(replyTo('5')(m({}))).toBe(false);
    const alice = mentioning('alice');
    expect(alice(m({ text: 'alice leaves for Bob' }))).toBe(true);
    expect(alice(m({ text: 'Bob was robbed by @alice!' }))).toBe(true);
    expect(alice(m({ text: 'alice2 leaves' }))).toBe(false);
    expect(alice(m({ text: 'xalice leaves' }))).toBe(false);
    expect(mentioning('a.b')(m({ text: 'axb' }))).toBe(false);
    expect(within(1000, 500)(m({ time: 1500 }))).toBe(true);
    expect(within(1000, 500)(m({ time: 1501 }))).toBe(false);
    expect(within(1000, 500)(m({ time: 999 }))).toBe(false);
    expect(within(1000, 500)(m({ playback: true }))).toBe(false);
    expect(from('GameBot')(m({}))).toBe(true);
    expect(all(from('GameBot'), alice)(m({ text: 'alice' }))).toBe(true);
    expect(all(from('Bob'), alice)(m({ text: 'alice' }))).toBe(false);
  });
});

describe('waitFor', () => {
  it('gives the first match, or nothing after the timeout', async () => {
    const clock = new VirtualClock();
    const channel = new Channel('irc:alice', 'irc');
    const got = waitFor(channel, mentioning('alice'), 10_000, clock);
    channel.say({ text: 'Bob leaves' });
    channel.say({ text: 'alice leaves', time: 2 });
    channel.say({ text: 'alice again', time: 3 });
    expect((await got)?.time).toBe(2);
    const none = waitFor(channel, mentioning('nobody'), 10_000, clock);
    clock.advance(10_000);
    expect(await none).toBeUndefined();
    channel.say({ text: 'nobody, too late' });
  });
});
