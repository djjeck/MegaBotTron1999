import { describe, expect, it } from 'vitest';
import { commandOf, DENY_REPLY_MS, Gate } from './telegram-gate.ts';

const lobby = { id: -100123, type: 'supergroup' };
const hall = { id: -100456, type: 'group', username: 'Guild_Hall' };
const dm = { id: 66, type: 'private' };

describe('Gate (D128)', () => {
  it('works in any group but those it blocks, by id or @username without case', () => {
    const g = new Gate({ groups: { block: ['@guild_hall'] }, now: () => 0 });
    expect(g.active).toBe(true);
    expect(g.refusesGroup(hall)).toBe('@guild_hall');
    expect(g.refusesGroup(lobby)).toBeUndefined();
    // A private chat or a channel is no group.
    expect(
      g.refusesGroup({ id: -100456, type: 'channel', username: 'guild_hall' })
    ).toBeUndefined();
    expect(g.refusesGroup(dm)).toBeUndefined();
  });

  it('works only in the groups it lists, none if the list is empty', () => {
    const g = new Gate({ groups: { only: [String(lobby.id)] }, now: () => 0 });
    expect(g.refusesGroup(lobby)).toBeUndefined();
    // Named as Telegram does: by @username, else by id.
    expect(g.refusesGroup(hall)).toBe('@Guild_Hall');
    expect(g.refusesGroup({ id: -1, type: 'group' })).toBe('-1');
    expect(g.refusesGroup(dm)).toBeUndefined();
    expect(new Gate({ groups: { only: [] }, now: () => 0 }).refusesGroup(lobby)).toBe('-100123');
  });

  it('works for anyone but those it blocks, or only those it lists; its owner always', () => {
    const block = new Gate({
      people: { block: ['66', '@Spam_Bot', '4242'] },
      owner: 4242,
      now: () => 0,
    });
    expect(block.refusesPerson({ id: 66 })).toBe('66');
    expect(block.refusesPerson({ id: 77, username: 'spam_bot' })).toBe('@Spam_Bot');
    expect(block.refusesPerson({ id: 77, username: 'ada_x' })).toBeUndefined();
    expect(block.refusesPerson(undefined)).toBeUndefined();
    expect(block.refusesPerson({ id: 4242 })).toBeUndefined();
    const only = new Gate({ people: { only: ['@ada_x'] }, owner: 4242, now: () => 0 });
    expect(only.refusesPerson({ id: 5, username: 'Ada_X' })).toBeUndefined();
    expect(only.refusesPerson({ id: 66, username: 'mallory_x' })).toBe('@mallory_x');
    expect(only.refusesPerson({ id: 66 })).toBe('66');
    // Its owner, though not listed.
    expect(only.refusesPerson({ id: 4242 })).toBeUndefined();
  });

  it('refuses nothing without a rule', () => {
    const g = new Gate({ groups: { block: undefined }, people: {}, now: () => 0 });
    expect(g.active).toBe(false);
    expect(g.refusesGroup(lobby)).toBeUndefined();
    expect(g.refusesPerson({ id: 66 })).toBeUndefined();
    expect(new Gate({ now: () => 0 }).active).toBe(false);
  });

  it('answers a person at most once in 10 minutes, and only with a line', () => {
    let now = 0;
    const g = new Gate({ people: { block: ['66'] }, reply: 'No.', now: () => now });
    expect(g.replyTo('66')).toBe('No.');
    expect(g.replyTo('66')).toBeUndefined();
    expect(g.replyTo('77')).toBe('No.');
    now = DENY_REPLY_MS;
    expect(g.replyTo('66')).toBe('No.');
    expect(new Gate({ people: { block: ['66'] }, now: () => 0 }).replyTo('66')).toBeUndefined();
  });

  it('counts what it denied, the last one dated', () => {
    const g = new Gate({ people: { block: ['66'] }, now: () => 5 });
    expect(g.denied()).toEqual({ count: 0 });
    const one = {
      chat: '-1',
      sender: '66',
      by: 'person' as const,
      command: '/roll',
      replied: false,
    };
    g.count(one);
    g.count(one);
    expect(g.denied()).toEqual({ count: 2, last: { ...one, t: 5 } });
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

  it('reads an alias Telegram does not mark as a command, typed as one (D162)', () => {
    const typed = new Set(['tiratə']);
    expect(commandOf({ text: '/tiratə 3' }, 'ExampleBot', typed)).toBe('/tiratə');
    expect(commandOf({ text: '/Tiratə@examplebot' }, 'ExampleBot', typed)).toBe('/tiratə');
    expect(commandOf({ text: '/tiratə@OtherBot' }, 'ExampleBot', typed)).toBeUndefined();
    expect(commandOf({ text: '/tiratəo 3' }, 'ExampleBot', typed)).toBeUndefined();
    expect(commandOf({ text: 'say /tiratə' }, 'ExampleBot', typed)).toBeUndefined();
    expect(commandOf({ text: '/tiratə' }, 'ExampleBot')).toBeUndefined();
  });
});
