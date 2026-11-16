/**
 * Creates the session string of a `telegram-user` connector (#55), in the image:
 *
 *   docker run -it --rm ghcr.io/djjeck/megabottron1999:latest \
 *     node packages/connectors/tools/telegram-login.ts
 *
 * It asks for the API id and hash (my.telegram.org → API development tools), the phone number,
 * the code Telegram sends and the 2FA password if the account has one (not echoed), logs in with
 * `login()` and prints the session string, to save as the `telegram_user_session` Docker secret
 * beside `telegram_user_api_id` and `telegram_user_api_hash`. It keeps nothing: the session string
 * gives full access to the account, so it goes to the terminal alone.
 */
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { type StringSession } from 'telegram/sessions/index.js';
import { apiProblems } from '#src/plugins/telegram-user.ts';
import { type Ask, login, type LoginClient } from '#src/transport/telegram-user.ts';

/**
 * Asks on a terminal: `secret` answers are not echoed. Lines typed (or piped) ahead of a question
 * wait for it; the input's end fails the question asked.
 */
export function terminal(
  input: NodeJS.ReadableStream & { isTTY?: boolean },
  output: NodeJS.WritableStream
): { ask: Ask; close(): void } {
  let muted = false;
  const echo = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const rl = readline.createInterface({ input, output: echo, terminal: input.isTTY === true });
  const lines: string[] = [];
  let ended = false;
  let waiting: { resolve(line: string): void; reject(e: Error): void } | undefined;
  rl.on('line', (line) => {
    if (waiting === undefined) lines.push(line);
    else waiting.resolve(line);
    waiting = undefined;
  });
  rl.on('close', () => {
    ended = true;
    waiting?.reject(new Error('the input ended'));
    waiting = undefined;
  });
  const next = (): Promise<string> => {
    const line = lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (ended) return Promise.reject(new Error('the input ended'));
    return new Promise((resolve, reject) => (waiting = { resolve, reject }));
  };
  return {
    ask: async (question, secret) => {
      output.write(question);
      muted = secret === true;
      try {
        return (await next()).trim();
      } finally {
        if (muted) output.write('\n');
        muted = false;
      }
    },
    close: () => rl.close(),
  };
}

/** The whole dialogue: the API pair, the login, the session string printed. */
export async function main(
  ask: Ask,
  print: (line: string) => void,
  make?: (session: StringSession, apiId: number, apiHash: string) => LoginClient
): Promise<void> {
  print('Your API id and hash: https://my.telegram.org → API development tools.');
  const apiId = await ask('API id: ');
  const apiHash = (await ask('API hash: ', true)).toLowerCase();
  const problems = apiProblems(apiId, apiHash, { id: 'the API id', hash: 'the API hash' });
  if (problems.length > 0) throw new Error(problems.join('; '));
  const credentials = { apiId: Number(apiId), apiHash };
  const session = await login(
    credentials,
    ask,
    ...(make === undefined ? [] : [(s: StringSession) => make(s, credentials.apiId, apiHash)])
  );
  print('');
  print('Logged in. Save these as Docker secrets (one file each, under /run/secrets):');
  print(`  telegram_user_api_id    ${apiId}`);
  print('  telegram_user_api_hash  (the hash you typed)');
  print('  telegram_user_session   the line below, which gives full access to the account:');
  print('');
  print(session);
}

if (import.meta.main) {
  const t = terminal(process.stdin, process.stdout);
  main(t.ask, (line) => process.stdout.write(`${line}\n`))
    .then(
      () => t.close(),
      (e: unknown) => {
        t.close();
        process.stderr.write(`Login failed: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
      }
    )
    .finally(() => process.exit());
}
