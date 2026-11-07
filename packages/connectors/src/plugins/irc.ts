/**
 * The `irc` connector plugin (docs/bot-os-api.md §4.5): one IRC account through a ZNC bouncer,
 * on packages/connectors/src/transport/irc-client.ts. It holds the ZNC login (P9): other
 * plugins get a handle, which reads the channel and tells the status, and the sends go through the
 * account's outbox, which keeps to the account's limits.
 *
 * It opens one connection per account, and a second `start` opens nothing: many networks
 * kill extra connections from one host (their clone limits), and ZNC already holds the account's own.
 *
 * It logs what it hears: every line of the channel, played back or live, as `irc.line`, and
 * every step of the connection as `irc.status`, which it prints too. With a `healthPort` it serves
 * the health endpoint: `GET /health` answers 200 while it is in the channel, 503 when it is not,
 * with the health as JSON.
 */
import {
  type Connector,
  ConnectorBase,
  type ConnectorStatus,
  definePlugin,
  type Limits,
  type Plugin,
} from '@megabottron1999/core';
import http from 'node:http';
import { z } from 'zod';
import { IrcClient, type IrcClientOptions } from '#src/transport/irc-client.ts';
import {
  type Transport,
  type TransportEvents,
  type TransportStatus,
} from '#src/transport/transport.ts';

export const IRC = 'irc';
/** The Docker secret of the ZNC login's password. */
export const ZNC_PASSWORD = 'znc_password';

/** IRC's own steps, as the connector's states. */
const STATES: Record<TransportStatus, ConnectorStatus['state']> = {
  connecting: 'connecting',
  registered: 'connecting',
  joined: 'connected',
  closed: 'closed',
};

/** An IRC account's connection, as a connector: the channel's lines in, lines to it out. */
export class IrcConnector extends ConnectorBase implements Connector {
  /** The account's limits (`MIN_INTERVAL_S`, `MAX_PER_HOUR`), which its outbox keeps to. */
  readonly limits?: Limits;
  private readonly channel: string;
  private readonly client: Transport;
  private started = false;

  /** `client` makes the IRC client on the connector's events (tests pass a fake). */
  constructor(
    options: IrcClientOptions & { limits?: Limits },
    client: (events: TransportEvents) => Transport = (events) => new IrcClient(options, events)
  ) {
    super(`irc:${options.nick}`, 'irc');
    this.named(options.nick);
    if (options.limits !== undefined) this.limits = options.limits;
    this.channel = options.channel;
    this.client = client({
      line: (l) =>
        this.received({
          chat: this.channel,
          sender: l.nick,
          text: l.text,
          time: l.time,
          playback: l.playback,
        }),
      status: (status, detail) =>
        this.changed({
          state: STATES[status],
          phase: status,
          ...(detail === undefined ? {} : { detail }),
        }),
    });
  }

  /** Connects, once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.client.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.client.stop();
  }

  send(chat: string, text: string): boolean {
    if (chat.toLowerCase() !== this.channel.toLowerCase()) return false;
    return this.client.say(text);
  }
}

/** The connection's health, as `/health` answers it. */
export interface IrcHealth {
  /** In the channel. */
  connected: boolean;
  /** Time of the last live (not played back) line of the channel, if any. */
  lastLine?: number;
}

/** The health endpoint: `GET /health`, 200 while connected and 503 otherwise; 404 elsewhere. */
export function healthServer(health: () => IrcHealth): http.Server {
  return http.createServer((req, res) => {
    const now = health();
    const ok = req.url === '/health' && now.connected;
    res.writeHead(req.url === '/health' ? (ok ? 200 : 503) : 404, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify(now));
  });
}

/** The event types it registers: the channel's lines and the connection's steps. */
export const LINE_EVENT = 'irc.line';
export const STATUS_EVENT = 'irc.status';

/** The `irc` plugin's configuration : the ZNC login, the nick and channel, the rate limiter. */
export const ircConfig = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  tls: z.boolean(),
  zncUser: z.string().min(1),
  zncNetwork: z.string().min(1),
  nick: z.string().min(1),
  channel: z.string().regex(/^[#&]\S+$/u, 'expected a channel, such as #lobby'),
  /** The least seconds between two sends, and the most sends in any hour. */
  minIntervalS: z.number().int().min(0),
  maxPerHour: z.number().int().min(1),
  /** The health endpoint's port (`HEALTH_PORT`); none, no endpoint. */
  healthPort: z.number().int().min(0).max(65_535).optional(),
});
export type IrcConfig = z.infer<typeof ircConfig>;

/**
 * The `irc` plugin of the account `irc:<nick>`: it makes its connector at `create`, from its
 * configuration as the core checked it; `client` makes the IRC client (tests pass a fake).
 */
export function ircPlugin(o: {
  nick: string;
  client?: (options: IrcClientOptions, events: TransportEvents) => Transport;
}): Plugin {
  return definePlugin({
    manifest: {
      id: IRC,
      version: '0.1.0',
      kinds: ['connector'],
      description: 'An IRC account through ZNC',
      account: `irc:${o.nick}`,
      config: ircConfig,
      // The ZNC login's password (P9): the plugin alone receives it.
      secrets: [ZNC_PASSWORD],
      games: { registers: [IRC] },
      events: {
        [LINE_EVENT]: z.object({ nick: z.string(), text: z.string(), playback: z.boolean() }),
        [STATUS_EVENT]: z.object({ status: z.string(), detail: z.string().optional() }),
      },
    },
    create: (ctx) => {
      const c = ctx.config as IrcConfig;
      const options: IrcClientOptions & { limits: Limits } = {
        host: c.host,
        port: c.port,
        tls: c.tls,
        zncUser: c.zncUser,
        zncNetwork: c.zncNetwork,
        password: ctx.secrets?.get(ZNC_PASSWORD) ?? '',
        nick: c.nick,
        channel: c.channel,
        limits: { minIntervalMs: c.minIntervalS * 1000, maxPerHour: c.maxPerHour },
      };
      const make = o.client;
      const connector = new IrcConnector(
        options,
        make === undefined ? undefined : (events) => make(options, events)
      );
      const health: IrcHealth = { connected: false };
      connector.onMessage((m) => {
        if (!m.playback) health.lastLine = m.time;
        ctx.bus.publish(LINE_EVENT, { nick: m.sender, text: m.text, playback: m.playback }, m.time);
      });
      connector.onStatus((s) => {
        health.connected = s.state === 'connected';
        ctx.bus.publish(STATUS_EVENT, {
          status: s.phase,
          ...(s.detail === undefined ? {} : { detail: s.detail }),
        });
        ctx.log.info(`${s.phase}${s.detail === undefined ? '' : ` (${s.detail})`}`);
      });
      let server: http.Server | undefined;
      return {
        connector,
        start: () => {
          if (c.healthPort !== undefined)
            server = healthServer(() => ({ ...health })).listen(c.healthPort);
          connector.start();
        },
        stop: () => {
          connector.stop();
          server?.close();
          server = undefined;
        },
      };
    },
  });
}
