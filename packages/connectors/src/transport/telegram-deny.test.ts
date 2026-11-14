import { describe, expect, it } from 'vitest';
import { commandOf, DENY_REPLY_MS, DenyList } from './telegram-deny.ts';

const group = { type: 'supergroup' };

describe('DenyList (D100)', () => {
  it('denies those it lists, by id or @username without case, in a group only', () => {
    const d = new DenyList({ deny: ['66', '@Spam_Bot', '4242'], owner: 4242, now: () => 0 });
    expect(d.denies(group, { id: 66 })).toBe('66');
    expect(d.denies({ type: 'group' }, { id: 77, username: 'spam_bot' })).toBe('@Spam_Bot');
    expect(d.denies(group, { id: 77, username: 'ada_x' })).toBeUndefined();
    expect(d.denies(group, { id: 77 })).toBeUndefined();
    expect(d.denies({ type: 'private' }, { id: 66 })).toBeUndefined();
    expect(d.denies({ type: 'channel' }, { id: 66 })).toBeUndefined();
    expect(d.denies(group, undefined)).toBeUndefined();
    // Its owner, never, though listed.
    expect(d.denies(group, { id: 4242 })).toBeUndefined();
    expect(new DenyList({ deny: [], now: () => 0 }).denies(group, { id: 66 })).toBeUndefined();
  });

  it('answers a person at most once in 10 minutes, and only with a line', () => {
    let now = 0;
    const d = new DenyList({ deny: ['66'], reply: 'No.', now: () => now });
    expect(d.replyTo('66')).toBe('No.');
    expect(d.replyTo('66')).toBeUndefined();
    expect(d.replyTo('77')).toBe('No.');
    now = DENY_REPLY_MS;
    expect(d.replyTo('66')).toBe('No.');
    expect(new DenyList({ deny: ['66'], now: () => 0 }).replyTo('66')).toBeUndefined();
  });

  it('counts what it denied, the last one dated', () => {
    const d = new DenyList({ deny: ['66'], now: () => 5 });
    expect(d.denied()).toEqual({ count: 0 });
    const one = { chat: '-1', sender: '66', command: '/roll', replied: false };
    d.count(one);
    d.count(one);
    expect(d.denied()).toEqual({ count: 2, last: { ...one, t: 5 } });
  });
});

describe('commandOf', () => {
  const m = (text: string, length = text.split(' ')[0]?.length ?? 0, offset = 0) => ({
    text,
    entities: [{ type: 'bot_command' as const, offset, length }],
  });
  it('reads the command a message starts with, for this bot or any', () => {
    expect(commandOf(m('/roll 3'), 'ExampleBot')).toBe('/roll');
    expect(commandOf(m('/roll@examplebot 3'), 'ExampleBot')).toBe('/roll');
    expect(commandOf(m('/roll@OtherBot'), 'ExampleBot')).toBeUndefined();
    expect(commandOf(m('/roll@OtherBot'), undefined)).toBe('/roll');
    expect(commandOf(m('say /roll', 5, 4), 'ExampleBot')).toBeUndefined();
    expect(commandOf({ text: '/roll' }, 'ExampleBot')).toBeUndefined();
    expect(commandOf({ entities: m('/roll').entities }, 'ExampleBot')).toBeUndefined();
  });
});
