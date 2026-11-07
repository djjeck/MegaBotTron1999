import { FakeConnector } from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { type ChannelLine, transportOver, type TransportStatus } from './transport.ts';

/** A transport over `over` on `#chan`: what it hears. */
function attach(over: Parameters<typeof transportOver>[0]) {
  const lines: ChannelLine[] = [];
  const statuses: [TransportStatus, string | undefined][] = [];
  const t = transportOver(
    over,
    '#Chan'
  )({ line: (l) => lines.push(l), status: (s, d) => statuses.push([s, d]) });
  return { t, lines, statuses };
}

describe('transportOver', () => {
  it("hears its chat's lines and the connector's status, and says lines to its chat", () => {
    const c = new FakeConnector({ account: 'irc:me' });
    const { t, lines, statuses } = attach(c);
    t.start();
    // A closed connector tells nothing at once.
    expect(statuses).toEqual([]);
    c.open('joined');
    c.hear({ chat: '#chan', sender: 'alice', text: 'hello', time: 5, playback: true });
    c.hear({ chat: '#other', sender: 'bob', text: 'elsewhere', time: 6 });
    expect(lines).toEqual([{ nick: 'alice', text: 'hello', time: 5, playback: true }]);
    expect(statuses).toEqual([['joined', undefined]]);
    expect(t.say('hi')).toBe(true);
    expect(c.sent).toEqual([{ chat: '#Chan', text: 'hi' }]);
    t.stop();
    c.hear({ chat: '#chan', sender: 'alice', text: 'after', time: 7 });
    expect(lines).toHaveLength(1);
  });

  it('tells the status at once of a connector already up, found when it starts', () => {
    const c = new FakeConnector({ account: 'irc:me' });
    c.open('registered');
    const ref: { found?: FakeConnector } = {};
    const { t, statuses } = attach(() => ref.found);
    // None yet: it says nothing, and the start is closed.
    expect(t.say('lost')).toBe(false);
    t.start();
    expect(statuses).toEqual([['closed', 'no connector']]);
    ref.found = c;
    t.start();
    expect(statuses.at(-1)).toEqual(['registered', undefined]);
  });
});
