import { describe, expect, it } from 'vitest';
import { formatIrcLine, messageTime, parseIrcLine } from './irc-protocol.ts';

describe('parseIrcLine', () => {
  it('reads tags, source, command and a trailing parameter', () => {
    expect(
      parseIrcLine(
        '@time=2026-10-22T02:16:35.000Z;msgid=a\\sb :Relay!~relay@host PRIVMSG #lobby :<Alfa> !roll Bravo'
      )
    ).toEqual({
      tags: { time: '2026-10-22T02:16:35.000Z', msgid: 'a b' },
      source: 'Relay',
      command: 'PRIVMSG',
      params: ['#lobby', '<Alfa> !roll Bravo'],
    });
  });

  it('reads a bare command, a valueless tag and escapes', () => {
    expect(parseIrcLine('PING :server.example')).toEqual({
      tags: {},
      command: 'PING',
      params: ['server.example'],
    });
    expect(parseIrcLine('@draft/bot;x=a\\:b\\\\c\\q 001 alice :Welcome').tags).toEqual({
      'draft/bot': '',
      x: 'a;b\\cq',
    });
    expect(parseIrcLine(':server cap * ls :server-time sasl')).toMatchObject({
      command: 'CAP',
      params: ['*', 'ls', 'server-time sasl'],
    });
  });

  it('reads a line that is only a trailing parameter after the command', () => {
    expect(parseIrcLine('ERROR :Closing link').params).toEqual(['Closing link']);
    expect(parseIrcLine(':nick JOIN #lobby').params).toEqual(['#lobby']);
  });
});

describe('formatIrcLine', () => {
  it('sends the last parameter as trailing when it must', () => {
    expect(formatIrcLine('PRIVMSG', '#lobby', '!roll Bravo')).toBe('PRIVMSG #lobby :!roll Bravo');
    expect(formatIrcLine('JOIN', '#lobby')).toBe('JOIN #lobby');
    expect(formatIrcLine('PONG', '')).toBe('PONG :');
    expect(formatIrcLine('PRIVMSG', '#lobby', ':)')).toBe('PRIVMSG #lobby ::)');
  });
});

describe('messageTime', () => {
  it('uses server-time, else the fallback', () => {
    expect(messageTime(parseIrcLine('@time=2026-10-22T02:16:35.000Z PING :x'), 0)).toBe(
      Date.UTC(2026, 9, 22, 2, 16, 35)
    );
    expect(messageTime(parseIrcLine('PING :x'), 42)).toBe(42);
    expect(messageTime(parseIrcLine('@time=soon PING :x'), 42)).toBe(42);
  });
});
