/**
 * The shell's health endpoint (docs/bot-os-api.md §4.11), for a container's healthcheck: `GET
 * /health` (and `HEAD`) answers 200 while every enabled connector is connected, 503 otherwise,
 * with the process's uptime, whether the instance is on and each connector's status as JSON; 404
 * elsewhere. It reveals no config, chat, account or secret: a connector is named by its node's id
 * and its plugin. A connector the owner disabled or stopped does not count; one failed, or not yet
 * connected, does. The instance being off is the owner's choice, said but not counted.
 */
import http from 'node:http';
import { type AccountControl } from './controls.ts';

/** What the health needs of the controls. */
export interface HealthSource {
  readonly off: boolean;
  accounts(): AccountControl[];
}

export interface ConnectorHealth {
  id: string;
  plugin: string;
  /** Its connection's (`connected`, `connecting`, `closed`), or its node's without one (`failed`). */
  status: string;
  /** False for a connector the owner disabled or stopped, which the verdict leaves out. */
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
  const connectors = source.accounts().map((a) => ({
    id: a.id,
    plugin: a.plugin,
    status: a.connection?.state ?? a.state,
    counted: !SET_ASIDE.has(a.state),
  }));
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
