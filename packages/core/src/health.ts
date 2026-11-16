/**
 * The shell's health endpoint (docs/bot-os-api.md §4.11), for a container's healthcheck: `GET
 * /health` (and `HEAD`) answers 200 while every enabled connector is connected, 503 otherwise,
 * with the process's uptime, whether the instance is on and each connector's status as JSON; 404
 * elsewhere. It reveals no config, chat, account or secret: a connector is named by its node's id
 * and its plugin. A connector the owner disabled or stopped does not count, nor one waiting for its
 * login (bot-os.md D125: it is logged in from the web UI, which a failing check would take off the
 * proxy); one failed, or not yet connected, does. The instance being off is the owner's choice,
 * said but not counted.
 */
import http from 'node:http';
import { type AccountControl } from './controls.ts';
import { NEEDS_LOGIN } from './login.ts';

/** What the health needs of the controls. */
export interface HealthSource {
  readonly off: boolean;
  accounts(): AccountControl[];
}

export interface ConnectorHealth {
  id: string;
  plugin: string;
  /**
   * Its connection's (`connected`, `connecting`, `closed`), `needs login` for one waiting for its
   * login, or its node's without a connection (`failed`).
   */
  status: string;
  /** False for a connector the owner disabled or stopped, or waiting for its login: left out. */
  counted: boolean;
}

export interface Health {
  /** Up, and every counted connector connected. */
  ok: boolean;
  uptimeS: number;
  /** Whether the instance is on (the owner's switch). */
  on: boolean;
  connectors: ConnectorHealth[];
}

/** The node states of a connector the owner set aside, which the verdict leaves out. */
const SET_ASIDE = new Set(['disabled', 'stopped']);

/** The health now. */
export function health(source: HealthSource, uptimeS: number): Health {
  const connectors = source.accounts().map((a) => {
    const login = a.connection?.phase === NEEDS_LOGIN;
    return {
      id: a.id,
      plugin: a.plugin,
      status: login ? NEEDS_LOGIN : (a.connection?.state ?? a.state),
      counted: !login && !SET_ASIDE.has(a.state),
    };
  });
  return {
    ok: connectors.every((c) => !c.counted || c.status === 'connected'),
    uptimeS,
    on: !source.off,
    connectors,
  };
}

/** The health endpoint as a request handler. */
export function healthHandler(
  source: HealthSource,
  uptimeS: () => number = () => Math.round(process.uptime())
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const path = new URL(req.url ?? '/', 'http://health').pathname;
    if (path !== '/health' || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}\n');
      return;
    }
    const h = health(source, uptimeS());
    res.writeHead(h.ok ? 200 : 503, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : `${JSON.stringify(h)}\n`);
  };
}

/** The health endpoint on a server of its own (the wiring's, on `HEALTH_PORT`). */
export function healthServer(source: HealthSource, uptimeS?: () => number): http.Server {
  return http.createServer(healthHandler(source, uptimeS));
}
