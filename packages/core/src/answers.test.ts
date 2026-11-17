import { describe, expect, it } from 'vitest';
import {
  type AnswerDeclaration,
  type AnswerDeclarationInput,
  Answers,
  answerSchema,
  answerWindowMs,
  type CommandAnswer,
  GUARD_BASE_MS,
  readAnswer,
} from './answers.ts';
import { VirtualClock } from './clock.ts';
import { type Notice } from './notices.ts';

const declare = (d: AnswerDeclarationInput): AnswerDeclaration => answerSchema.parse(d);

/** A game's answers to `/give`, as its parser would declare them. */
const GIVE: AnswerDeclaration[] = [
  declare({
    event: 'quest.give',
    commands: ['/give', '/throw'],
    when: { result: 'refused', why: 'cooldown' },
    status: 'refused',
    reason: 'cooldown',
    retryAtFrom: 'until',
    holds: ['/give'],
  }),
  declare({
    event: 'quest.give',
    commands: ['/give', '/throw'],
    when: { result: 'refused' },
    status: 'refused',
    reason: 'invalid',
    reasonFrom: 'why',
  }),
  declare({
    event: 'quest.give',
    commands: ['/give', '/throw'],
    unless: { result: 'unknown' },
    status: 'ok',
    withinS: 30,
  }),
];

describe('readAnswer', () => {
  it('reads an event by the first declaration that matches it', () => {
    expect(
      readAnswer(GIVE, 'quest.give', { result: 'refused', why: 'cooldown', until: 9000 }, 5)
    ).toEqual({
      commands: ['/give', '/throw'],
      holds: ['/give'],
      answer: {
        status: 'refused',
        reason: 'cooldown',
        retryAt: 9000,
        event: { type: 'quest.give', t: 5, result: 'refused', why: 'cooldown', until: 9000 },
      },
    });
    // Its reason from the payload; the fixed one where the payload has none.
    expect(
      readAnswer(GIVE, 'quest.give', { result: 'refused', why: 'missing' }, 5)?.answer
    ).toEqual(expect.objectContaining({ status: 'refused', reason: 'missing' }));
    expect(readAnswer(GIVE, 'quest.give', { result: 'refused', why: '' }, 5)?.answer.reason).toBe(
      'invalid'
    );
    const ok = readAnswer(GIVE, 'quest.give', { result: 'given' }, 5);
    expect(ok?.answer).toEqual({
      status: 'ok',
      event: { type: 'quest.give', t: 5, result: 'given' },
    });
    expect(ok?.holds).toEqual(['/give', '/throw']);
    // Not an answer: `unless` holds, another type, a retryAt that is not a time.
    expect(readAnswer(GIVE, 'quest.give', { result: 'unknown' }, 5)).toBeUndefined();
    expect(readAnswer(GIVE, 'quest.other', { result: 'given' }, 5)).toBeUndefined();
    expect(
      readAnswer(GIVE, 'quest.give', { result: 'refused', why: 'cooldown', until: 'soon' }, 5)
        ?.answer.retryAt
    ).toBeUndefined();
  });

  it('gives the longest window of the declarations that answer a command', () => {
    expect(answerWindowMs(GIVE, '/give')).toBe(120_000);
    expect(answerWindowMs(GIVE.slice(2), '/give')).toBe(30_000);
    expect(answerWindowMs(GIVE, '/look')).toBeUndefined();
  });
});

const read = (status: 'ok' | 'refused', o: { reason?: string; retryAt?: number } = {}) => ({
  commands: ['/give'],
  holds: ['/give', '/throw'],
  answer: { status, ...o } as CommandAnswer,
});

function answers() {
  const clock = new VirtualClock(0);
  const notices: Omit<Notice, 't'>[] = [];
  const unanswered: string[] = [];
  const a = new Answers({
    account: 'tg:me',
    clock,
    notice: (n) => notices.push(n),
    unanswered: (plugins, chat, command) =>
      unanswered.push(`${plugins.join('+')} ${chat} ${command}`),
  });
  return { clock, a, notices, unanswered };
}

describe('Answers', () => {
  it('pairs an answer with the send it replies to, else the oldest, by any name of the chat', () => {
    const { a } = answers();
    const heard: string[] = [];
    const one = a.expect(['p'], '@QuestBot', '/give', 60_000);
    const two = a.expect(['q'], '@QuestBot', '/give', 60_000);
    const three = a.expect(['r'], '@QuestBot', '/give', 60_000);
    one.identify('11');
    two.identify('12');
    one.wait((x) => heard.push(`one ${x.status}`));
    two.wait((x) => heard.push(`two ${x.status}`));
    three.wait((x) => heard.push(`three ${x.status}`));
    // A reply to the second; then a reply to a message it knows nothing of: the one of no id.
    expect(a.answered(['42', '@questbot'], '12', read('ok'))).toEqual({
      plugins: ['q'],
      chat: '@QuestBot',
      command: '/give',
    });
    expect(a.answered(['@QuestBot'], '99', read('ok'))?.plugins).toEqual(['r']);
    // Not its chat, not its command: nothing.
    expect(a.answered(['#lobby'], undefined, read('ok'))).toBeUndefined();
    expect(a.answered(['@QuestBot'], undefined, { ...read('ok'), commands: ['/look'] })).toBe(
      undefined
    );
    expect(a.answered(['@QuestBot'], undefined, read('refused'))?.plugins).toEqual(['p']);
    expect(heard).toEqual(['two ok', 'three ok', 'one refused']);
    // Heard after it settled, it is told at once.
    one.wait((x) => heard.push(`late ${x.status}`));
    expect(heard.at(-1)).toBe('late refused');
  });

  it('settles a send with no answer in its window as unanswered, and a dropped one never', () => {
    const { a, clock, unanswered } = answers();
    const heard: string[] = [];
    a.expect(['p', 'q'], '@QuestBot', '/give', 1000).wait((x) => heard.push(x.status));
    const dropped = a.expect(['p'], '@QuestBot', '/give', 1000);
    dropped.wait((x) => heard.push(`dropped ${x.status}`));
    dropped.drop();
    dropped.wait((x) => heard.push(`dropped ${x.status}`));
    clock.advance(1000);
    expect(heard).toEqual(['unanswered']);
    expect(unanswered).toEqual(['p+q @QuestBot /give']);
    expect(a.answered(['@QuestBot'], undefined, read('ok'))).toBeUndefined();
  });

  it('tells the owner once of a command no answer came for, until one of its sends is answered', () => {
    const { a, clock, notices } = answers();
    // The bot ignores /buy in this chat: each send goes unanswered.
    for (let i = 0; i < 3; i++) a.expect(['p'], '@QuestBot', '/buy', 120_000);
    clock.advance(120_000);
    expect(notices).toEqual([
      {
        kind: 'unanswered',
        node: 'p',
        text: 'p sent /buy to @QuestBot and read no answer to it within 120 s: the bot may ignore it there',
        detail: { account: 'tg:me', chat: '@QuestBot', command: '/buy', withinS: 120 },
      },
    ]);
    // Another node's, another command's: told apart.
    a.expect(['q'], '@QuestBot', '/buy', 1000);
    a.expect(['p'], '@QuestBot', '/give', 1000);
    clock.advance(1000);
    expect(notices.map((n) => `${String(n.node)} ${String(n.detail?.['command'])}`)).toEqual([
      'p /buy',
      'q /buy',
      'p /give',
    ]);
    // Answered once, a later silence is told again.
    a.expect(['p'], '@QuestBot', '/buy', 1000);
    a.answered(['@QuestBot'], undefined, { ...read('ok'), commands: ['/buy'] });
    a.expect(['p'], '@QuestBot', '/buy', 1000);
    clock.advance(1000);
    expect(notices).toHaveLength(4);
  });

  it("holds a command group back until an answer's retryAt, the latest kept", () => {
    const { a, clock } = answers();
    a.answered(
      ['42', '@QuestBot'],
      undefined,
      read('refused', { reason: 'cooldown', retryAt: 5000 })
    );
    expect(a.held('p', '@questbot', '/throw')).toEqual({
      until: 5000,
      reason: 'cooldown: cooldown',
    });
    expect(a.held('p', '42', '/give')?.until).toBe(5000);
    a.answered(['@QuestBot'], undefined, read('ok', { retryAt: 3000 }));
    expect(a.held('q', '@QuestBot', '/give')).toEqual({
      until: 5000,
      reason: 'cooldown: cooldown',
    });
    a.answered(['@QuestBot'], undefined, read('ok', { retryAt: 8000 }));
    expect(a.held('q', '@QuestBot', '/give')).toEqual({ until: 8000, reason: 'cooldown: ok' });
    // A retryAt past is none; another command, another chat: free.
    a.answered(['#lobby'], undefined, read('ok', { retryAt: -1 }));
    expect(a.held('p', '#lobby', '/give')).toBeUndefined();
    expect(a.held('p', '@QuestBot', '/look')).toBeUndefined();
    clock.advance(8000);
    expect(a.held('p', '@QuestBot', '/give')).toBeUndefined();
  });

  it('sets the cooldowns an answer names as they are, an earlier one too, a past one cleared (D132)', () => {
    const { a, clock } = answers();
    a.answered(['@QuestBot'], undefined, read('ok', { retryAt: 9000 }));
    a.answered(['@QuestBot', '42'], undefined, {
      ...read('ok'),
      commands: ['/coffee'],
      holds: ['/coffee'],
      holdsAt: { '/give': 4000 },
    });
    expect(a.held('p', '@QuestBot', '/give')).toEqual({ until: 4000, reason: 'cooldown: ok' });
    expect(a.held('p', '42', '/give')?.until).toBe(4000);
    // The group's other command keeps its own.
    expect(a.held('p', '@QuestBot', '/throw')?.until).toBe(9000);
    a.answered(['@QuestBot'], undefined, { ...read('ok'), holdsAt: { '/give': 0, '/look': 6000 } });
    expect(a.held('p', '@QuestBot', '/give')).toBeUndefined();
    expect(a.held('p', '@QuestBot', '/look')).toEqual({ until: 6000, reason: 'cooldown: ok' });
    clock.advance(6000);
    expect(a.held('p', '@QuestBot', '/look')).toBeUndefined();
  });

  it('reads the cooldowns an answer sets from its payload, its other entries left out', () => {
    const [d] = [
      declare({ event: 'quest.answer', commands: ['/coffee'], status: 'ok', holdsAtFrom: 'holds' }),
    ];
    expect(
      readAnswer([d as AnswerDeclaration], 'quest.answer', { holds: { '/give': 5, '/x': 'no' } }, 1)
        ?.holdsAt
    ).toEqual({ '/give': 5 });
    for (const holds of [undefined, [], { '/x': 'no' }])
      expect(readAnswer([d as AnswerDeclaration], 'quest.answer', { holds }, 1)).not.toHaveProperty(
        'holdsAt'
      );
  });

  it('backs off a node refused for the same reason again and again, longer each time', () => {
    const { a, clock, notices } = answers();
    const refuse = (plugin: string, reason?: string, retryAt?: number) => {
      a.expect([plugin], '@QuestBot', '/give', 60_000);
      a.answered(
        ['@QuestBot'],
        undefined,
        read('refused', {
          ...(reason === undefined ? {} : { reason }),
          ...(retryAt === undefined ? {} : { retryAt }),
        })
      );
    };
    refuse('p', 'missing');
    refuse('p', 'missing');
    expect(a.held('p', '@QuestBot', '/give')).toBeUndefined();
    // Another reason starts the count again; a cooldown with its retryAt counts for nothing.
    refuse('p', 'invalid');
    refuse('p', 'invalid');
    refuse('p', 'invalid', 100);
    clock.advance(100);
    expect(a.backoffs('p')).toEqual([]);
    refuse('p', 'invalid');
    expect(a.held('p', '@QuestBot', '/give')).toEqual({
      until: 100 + GUARD_BASE_MS,
      reason: 'backed off: refused 3 times in a row (invalid)',
    });
    expect(a.held('q', '@QuestBot', '/give')).toBeUndefined();
    expect(notices).toEqual([
      {
        kind: 'backoff',
        node: 'p',
        text: 'p sent /give to @QuestBot 3 times, refused each time (invalid): held back, longer at each refusal more',
        detail: {
          account: 'tg:me',
          chat: '@QuestBot',
          command: '/give',
          reason: 'invalid',
          count: 3,
        },
      },
    ]);
    refuse('p', 'invalid');
    expect(a.backoffs('p')).toEqual([
      {
        account: 'tg:me',
        chat: '@QuestBot',
        command: '/give',
        reason: 'invalid',
        count: 4,
        until: 100 + 2 * GUARD_BASE_MS,
      },
    ]);
    expect(notices).toHaveLength(1);
    // A refusal of no reason is `refused`; an ok clears it.
    refuse('q');
    expect(a.backoffs('q')).toEqual([]);
    a.expect(['p'], '@QuestBot', '/give', 60_000);
    a.answered(['@QuestBot'], undefined, read('ok'));
    expect(a.backoffs('p')).toEqual([]);
    expect(a.held('p', '@QuestBot', '/give')).toBeUndefined();
  });

  it('caps the hold at an hour', () => {
    const { a } = answers();
    for (let i = 0; i < 12; i++) {
      a.expect(['p'], '@QuestBot', '/give', 60_000);
      a.answered(['@QuestBot'], undefined, read('refused', { reason: 'missing' }));
    }
    expect(a.held('p', '@QuestBot', '/give')?.until).toBe(3_600_000);
  });
});
