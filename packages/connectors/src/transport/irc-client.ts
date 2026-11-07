/**
 * A minimal IRC client for ZNC: log in as a ZNC user's network, request
 * `server-time`, answer PINGs, join the channel, deliver its PRIVMSGs, and reconnect with backoff.
 * Written on `node:net`/`node:tls` rather than an IRC library, since this is all it needs.
 *
 * On its own it sends only what the protocol needs (login, CAP, PONG, JOIN); everything else
 * goes through `say`, which only the account's outbox calls, after its checks.
 *
 * ZNC replays its buffer when a client attaches. Lines whose `server-time` is older than the
 * moment the client registered are delivered with `playback: true`, so that the caller never
 * acts on them.
 */
import net from 'node:net';
import tls from 'node:tls';
import { formatIrcLine, type IrcMessage, messageTime, parseIrcLine } from './irc-protocol.ts';
import { type Transport, type TransportEvents } from './transport.ts';

export interface IrcClientOptions {
  host: string;
  port: number;
  tls: boolean;
  /** ZNC login: `user`, optionally `user@clientid`, and the ZNC network. */
  zncUser: string;
  zncNetwork: string;
  password: string;
  /** The nick to ask for; ZNC keeps the network's own. */
  nick: string;
  channel: string;
  /** First reconnect delay; doubled up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** How a socket is opened (tests pass a plain-TCP one). */
  connect?: (options: IrcClientOptions) => net.Socket;
  now?: () => number;
}

export type { ChannelLine } from './transport.ts';

export interface IrcClientEvents extends TransportEvents {
  raw?: (message: IrcMessage) => void;
}

const defaultConnect = (o: IrcClientOptions): net.Socket =>
  o.tls ? tls.connect({ host: o.host, port: o.port }) : net.connect({ host: o.host, port: o.port });

export class IrcClient implements Transport {
  private readonly options: IrcClientOptions;
  private readonly events: IrcClientEvents;
  private readonly now: () => number;
  private socket: net.Socket | undefined;
  private buffer = '';
  private backoff: number;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private registeredAt = Infinity;
  private offered: string[] = [];
  /** The nick the server gave us (ZNC's network nick), from the welcome. */
  nick = '';
  /** True once registered and joined. */
  connected = false;

  constructor(options: IrcClientOptions, events: IrcClientEvents) {
    this.options = options;
    this.events = events;
    this.now = options.now ?? Date.now;
    this.backoff = options.backoffMs ?? 2000;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  /** Sends one line to the channel; false if not in it. */
  say(text: string): boolean {
    if (!this.connected) return false;
    this.write('PRIVMSG', this.options.channel, text);
    return true;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.socket !== undefined) {
      this.write('QUIT', 'bye');
      this.socket.end();
    }
  }

  private open(): void {
    this.events.status('connecting');
    const socket = (this.options.connect ?? defaultConnect)(this.options);
    this.socket = socket;
    this.buffer = '';
    this.registeredAt = Infinity;
    this.offered = [];
    socket.setEncoding('utf8');
    socket.on('connect', () => this.login());
    socket.on('secureConnect', () => this.login());
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (err) => this.events.status('closed', err.message));
    socket.on('close', () => this.closed());
  }

  private login(): void {
    const o = this.options;
    this.write('CAP', 'LS', '302');
    this.write('PASS', `${o.zncUser}/${o.zncNetwork}:${o.password}`);
    this.write('NICK', o.nick);
    this.write('USER', o.nick, '0', '*', o.nick);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(end + 1);
      if (line !== '') this.handle(parseIrcLine(line));
    }
  }

  private handle(m: IrcMessage): void {
    this.events.raw?.(m);
    switch (m.command) {
      case 'PING':
        this.write('PONG', m.params[0] ?? '');
        return;
      case 'CAP':
        this.cap(m);
        return;
      case '001':
        this.nick = m.params[0] ?? this.options.nick;
        this.registeredAt = this.now();
        this.backoff = this.options.backoffMs ?? 2000;
        this.events.status('registered');
        this.write('JOIN', this.options.channel);
        return;
      case 'JOIN':
        if (
          m.source === this.nick &&
          m.params[0]?.toLowerCase() === this.options.channel.toLowerCase()
        ) {
          this.connected = true;
          this.events.status('joined');
        }
        return;
      case 'PRIVMSG': {
        if (m.params[0]?.toLowerCase() !== this.options.channel.toLowerCase()) return;
        const time = messageTime(m, this.now());
        this.events.line({
          nick: m.source ?? '',
          text: m.params[1] ?? '',
          time,
          playback: time < this.registeredAt,
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Requests `server-time` if offered, then ends capability negotiation. The offer may span several
   * `CAP * LS * :…` lines; the last one has no `*` before the list.
   */
  private cap(m: IrcMessage): void {
    const sub = m.params[1];
    if (sub === 'LS') {
      const more = m.params.length > 3 && m.params[2] === '*';
      this.offered.push(...String(m.params[m.params.length - 1]).split(' '));
      if (more) return;
      const wanted = this.offered.filter(
        (c) => c === 'server-time' || c === 'znc.in/server-time-iso'
      );
      if (wanted.length > 0) this.write('CAP', 'REQ', wanted.join(' '));
      else this.write('CAP', 'END');
    } else if (sub === 'ACK' || sub === 'NAK') {
      this.write('CAP', 'END');
    }
  }

  private closed(): void {
    this.connected = false;
    this.socket = undefined;
    this.events.status('closed');
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 300_000);
    this.timer = setTimeout(() => this.open(), delay);
  }

  private write(command: string, ...params: string[]): void {
    this.socket?.write(`${formatIrcLine(command, ...params)}\r\n`);
  }
}
