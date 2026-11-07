import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type ChannelLine, IrcClient, type IrcClientOptions } from './irc-client.ts';

/** A fake ZNC on a local port: records what the client sends, and lets the test answer. */
class FakeZnc {
  readonly received: string[] = [];
  readonly server: net.Server;
  socket: net.Socket | undefined;
  private waiters: { re: RegExp; resolve: () => void }[] = [];

  constructor() {
    this.server = net.createServer((s) => {
      this.socket = s;
      s.setEncoding('utf8');
      let buf = '';
      s.on('data', (chunk: string) => {
        buf += chunk;
        let end: number;
        while ((end = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, end);
          buf = buf.slice(end + 2);
          this.received.push(line);
          this.waiters = this.waiters.filter((w) =>
            w.re.test(line) ? (w.resolve(), false) : true
          );
        }
      });
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return (this.server.address() as net.AddressInfo).port;
  }

  /** Resolves when the client sends (or has sent) a line matching `re`. */
  sent(re: RegExp): Promise<void> {
    if (this.received.some((l) => re.test(l))) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ re, resolve }));
  }

  send(...lines: string[]): void {
    for (const l of lines) this.socket?.write(`${l}\r\n`);
  }

  close(): Promise<void> {
    this.socket?.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }
}

const options = (port: number, now: () => number): IrcClientOptions => ({
  host: '127.0.0.1',
  port,
  tls: false,
  zncUser: 'alice@bot',
  zncNetwork: 'examplenet',
  password: 'secret',
  nick: 'alice',
  channel: '#lobby',
  backoffMs: 10,
  maxBackoffMs: 20,
  now,
});

let znc: FakeZnc;
let client: IrcClient | undefined;
afterEach(async () => {
  client?.stop();
  await znc.close();
});

describe('IrcClient', () => {
  it('logs in to ZNC, negotiates server-time, joins, and delivers channel lines', async () => {
    znc = new FakeZnc();
    const port = await znc.listen();
    const lines: ChannelLine[] = [];
    const statuses: string[] = [];
    let now = Date.UTC(2026, 9, 22, 2, 0, 0);
    client = new IrcClient(
      options(port, () => now),
      {
        line: (l) => lines.push(l),
        status: (s) => statuses.push(s),
      }
    );
    client.start();

    await znc.sent(/^USER /u);
    expect(znc.received).toEqual([
      'CAP LS 302',
      'PASS alice@bot/examplenet:secret',
      'NICK alice',
      'USER alice 0 * alice',
    ]);
    znc.send(':znc CAP * LS * :multi-prefix', ':znc CAP * LS :server-time sasl');
    await znc.sent(/^CAP REQ :?server-time$/u);
    znc.send(':znc CAP alice ACK :server-time');
    await znc.sent(/^CAP END$/u);
    znc.send(':irc.example.net 001 alice_ :Welcome', 'PING :tok');
    await znc.sent(/^JOIN #lobby$/u);
    await znc.sent(/^PONG tok$/u);
    expect(client.nick).toBe('alice_');

    znc.send(':Bravo!b@h JOIN #lobby');
    znc.send(':alice_!d@h JOIN #lobby');
    znc.send(
      '@time=2026-10-22T01:00:00.000Z :Relay!r@h PRIVMSG #lobby :<Alfa> old',
      '@time=2026-10-22T02:00:05.000Z :Relay!r@h PRIVMSG #lobby :<Alfa> new',
      ':Bravo!b@h PRIVMSG alice_ :private',
      ':Bravo!b@h NOTICE #lobby :notice'
    );
    now += 10_000;
    znc.send(':Bravo!b@h PRIVMSG #LOBBY :no time');
    await new Promise((r) => setTimeout(r, 50));

    expect(statuses).toEqual(['connecting', 'registered', 'joined']);
    expect(client.connected).toBe(true);
    expect(client.say('!profile')).toBe(true);
    await znc.sent(/^PRIVMSG #lobby :?!profile$/u);
    expect(lines).toEqual([
      { nick: 'Relay', text: '<Alfa> old', time: Date.UTC(2026, 9, 22, 1), playback: true },
      {
        nick: 'Relay',
        text: '<Alfa> new',
        time: Date.UTC(2026, 9, 22, 2, 0, 5),
        playback: false,
      },
      { nick: 'Bravo', text: 'no time', time: now, playback: false },
    ]);
  });

  it('ends negotiation at once when server-time is not offered, and reconnects after a drop', async () => {
    znc = new FakeZnc();
    const port = await znc.listen();
    const statuses: string[] = [];
    client = new IrcClient(options(port, Date.now), {
      line: () => {},
      status: (s) => statuses.push(s),
    });
    client.start();
    await znc.sent(/^USER /u);
    expect(client.say('!profile')).toBe(false);
    znc.send(':znc CAP * LS :sasl');
    await znc.sent(/^CAP END$/u);
    znc.send(':znc CAP alice NAK :x');

    const first = znc.socket;
    znc.received.length = 0;
    first?.destroy();
    await znc.sent(/^USER /u);
    expect(znc.socket).not.toBe(first);
    expect(statuses.filter((s) => s === 'connecting')).toHaveLength(2);
    expect(statuses).toContain('closed');
  });

  it('does not reconnect once stopped', async () => {
    znc = new FakeZnc();
    const port = await znc.listen();
    const statuses: string[] = [];
    client = new IrcClient(options(port, Date.now), {
      line: () => {},
      status: (s) => statuses.push(s),
    });
    client.start();
    await znc.sent(/^USER /u);
    client.stop();
    await znc.sent(/^QUIT :?bye$/u);
    await new Promise((r) => setTimeout(r, 60));
    expect(statuses.filter((s) => s === 'connecting')).toHaveLength(1);
    client = undefined;
  });

  it('reports a connection error', async () => {
    znc = new FakeZnc();
    const port = await znc.listen();
    await znc.close();
    znc = new FakeZnc();
    await znc.listen();
    const details: (string | undefined)[] = [];
    client = new IrcClient(
      { ...options(port, Date.now), maxBackoffMs: 1000 },
      { line: () => {}, status: (s, d) => s === 'closed' && details.push(d) }
    );
    client.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(details.some((d) => d !== undefined)).toBe(true);
  });
});
