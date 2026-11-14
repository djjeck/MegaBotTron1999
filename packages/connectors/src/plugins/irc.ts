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
 * with the health as JSON. The shell's own (`HEALTH_PORT`, docs/bot-os-api.md §4.11) covers every
 * connector, this one included; this one is kept for the configs that set it, on another port.
 */
import {
  commandIntervalS,
  type Connector,
  ConnectorBase,
  type ConnectorStatus,
  definePlugin,
  type Limits,
  type Plugin,
  type Surface,
  type SurfaceQuery,
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
  private readonly channel: string;
  private readonly client: Transport;
  private started = false;
  /** When the channel's last line was said, played back or live. */
  private lastLine: number | undefined;

  /** `client` makes the IRC client on the connector's events (tests pass a fake). */
  constructor(
    options: IrcClientOptions & { limits?: Limits; account?: string },
    client: (events: TransportEvents) => Transport = (events) => new IrcClient(options, events)
  ) {
    super(options.account ?? `irc:${options.nick}`, 'irc');
    this.named(options.nick);
    if (options.limits !== undefined) this.limits = options.limits;
    this.channel = options.channel;
    this.client = client({
      line: (l) => {
        this.lastLine = Math.max(this.lastLine ?? 0, l.time);
        this.received({
          chat: this.channel,
          sender: l.nick,
          text: l.text,
          time: l.time,
          playback: l.playback,
        });
      },
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

  /** Its surfaces (bot-os.md D63): its channel, the one it is in, matching the search if any. */
  surfaces(query: SurfaceQuery = {}): Promise<Surface[]> {
    const search = query.search?.trim().toLowerCase() ?? '';
    const channel: Surface = {
      id: this.channel,
      title: this.channel,
      kind: 'group',
      ...(this.lastLine === undefined ? {} : { lastActive: this.lastLine }),
    };
    return Promise.resolve(
      search === '' || this.channel.toLowerCase().includes(search) ? [channel] : []
    );
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
  host: z.string().min(1).describe('The ZNC bouncer’s host name'),
  port: z.number().int().min(1).max(65_535).describe('The ZNC bouncer’s port'),
  tls: z.boolean().describe('Whether the connection to ZNC is over TLS'),
  zncUser: z.string().min(1).describe('The ZNC user it logs in as (its password is a secret)'),
  zncNetwork: z.string().min(1).describe('The network of that ZNC user to join'),
  nick: z.string().min(1).describe('Its nick on the network'),
  channel: z
    .string()
    .regex(/^[#&]\S+$/u, 'expected a channel, such as #lobby')
    .describe('The channel it reads and sends to, such as #lobby'),
  minIntervalS: z
    .number()
    .int()
    .min(0)
    .describe('The least seconds between two sends (the rate limiter)'),
  maxPerHour: z.number().int().min(1).describe('The most sends in any hour (the rate limiter)'),
  commandIntervalS,
  healthPort: z
    .number()
    .int()
    .min(0)
    .max(65_535)
    .optional()
    .describe('The port of its health endpoint; unset, no endpoint'),
});
export type IrcConfig = z.infer<typeof ircConfig>;

/**
 * The `irc` plugin: it makes its connector at `create`, from its configuration alone, as the core
 * checked it, on its node's account (`irc:<nick>`; `irc:irc` until a node names one). `nick` only
 * names the manifest's placeholder account, and `client` makes the IRC client (tests pass a fake).
 */
export function ircPlugin(
  o: {
    nick?: string;
    client?: (options: IrcClientOptions, events: TransportEvents) => Transport;
  } = {}
): Plugin {
  return definePlugin({
    manifest: {
      id: IRC,
      version: '0.1.0',
      kinds: ['connector'],
      description: 'An IRC account through ZNC',
      account: `irc:${o.nick ?? 'irc'}`,
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
      const options: IrcClientOptions & { limits: Limits; account?: string } = {
        ...(ctx.account === undefined ? {} : { account: ctx.account }),
        host: c.host,
        port: c.port,
        tls: c.tls,
        zncUser: c.zncUser,
        zncNetwork: c.zncNetwork,
        password: ctx.secrets?.get(ZNC_PASSWORD) ?? '',
        nick: c.nick,
        channel: c.channel,
        limits: {
          minIntervalMs: c.minIntervalS * 1000,
          maxPerHour: c.maxPerHour,
          commandIntervalMs: c.commandIntervalS * 1000,
        },
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
