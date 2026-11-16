import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { type Ask, type LoginClient } from '#src/transport/telegram-user.ts';
import { main, terminal } from './telegram-login.ts';

const HASH = '0123456789abcdef0123456789abcdef';

describe('the telegram-login tool', () => {
  it('asks for the API pair, logs in and prints the session string to save', async () => {
    const answers: Record<string, string> = {
      'API id: ': '123456',
      'API hash: ': HASH.toUpperCase(),
    };
    const asked: [string, boolean | undefined][] = [];
    const ask: Ask = (q, secret) => (asked.push([q, secret]), Promise.resolve(answers[q] ?? 'x'));
    const printed: string[] = [];
    const made: [number, string][] = [];
    await main(
      ask,
      (l) => printed.push(l),
      (session, apiId, apiHash): LoginClient => {
        made.push([apiId, apiHash]);
        return {
          start: async (p) => {
            if (typeof p.phoneNumber !== 'string') await p.phoneNumber();
            await p.phoneCode();
            await p.password?.();
            session.save = () => '1BQANOTAREALSESSION';
          },
          disconnect: () => Promise.resolve(),
        };
      }
    );
    expect(made).toEqual([[123456, HASH]]);
    expect(asked.map(([q, s]) => `${q}${s === true ? ' (hidden)' : ''}`)).toEqual([
      'API id: ',
      'API hash:  (hidden)',
      'Phone number (international, +39…): ',
      'The code Telegram sent: ',
      '2FA password:  (hidden)',
    ]);
    expect(printed.at(-1)).toBe('1BQANOTAREALSESSION');
    // The hash is not printed back.
    expect(printed.join('\n')).not.toContain(HASH);
  });

  it('refuses an API pair that cannot be one, before any login', async () => {
    const ask: Ask = (q) => Promise.resolve(q === 'API id: ' ? '0' : 'nothex');
    await expect(
      main(
        ask,
        () => undefined,
        () => expect.fail('no login')
      )
    ).rejects.toThrow('the API id is not an API id; the API hash is not 32 hex digits');
  });

  it('reads answers from a terminal, a secret one unechoed', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (c: Buffer) => (shown += c.toString()));
    const t = terminal(input, output);
    const first = t.ask('Name: ');
    input.write('alice\n');
    expect(await first).toBe('alice');
    const second = t.ask('Password: ', true);
    input.write('hunter22\n');
    expect(await second).toBe('hunter22');
    t.close();
    expect(shown).toContain('Name: ');
    expect(shown).toContain('Password: \n');
    expect(shown).not.toContain('hunter22');
  });
});

describe('the terminal', () => {
  it('keeps lines piped ahead of their question, and fails a question past the end', async () => {
    const input = new PassThrough();
    const t = terminal(input, new PassThrough());
    input.end('one\ntwo\n');
    expect(await t.ask('a: ')).toBe('one');
    expect(await t.ask('b: ')).toBe('two');
    await expect(t.ask('c: ')).rejects.toThrow('the input ended');
  });

  it('fails a question waiting when the input ends', async () => {
    const input = new PassThrough();
    const t = terminal(input, new PassThrough());
    const asked = t.ask('a: ');
    input.end();
    await expect(asked).rejects.toThrow('the input ended');
  });
});
