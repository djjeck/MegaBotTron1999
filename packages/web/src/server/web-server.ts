/**
 * The web UI's server (docs/bot-os.md P16, D26, D40, D43): the React app that Vite built
 * (`dist/`), and the core's control API (`controlHandler`, docs/bot-os-api.md §4.11) under `/api/`,
 * only behind the owner's login. It knows no game and no plugin: the pages are made from what the
 * control API says.
 *
 * - `GET /api/session`: whether the request is logged in, and the process's `boot` id, a random one
 *   per start, by which the page sees that a restart has happened (its session outlives it).
 * - `POST /api/login {"password": "…"}`: a session cookie, or 401; 429 with `Retry-After` past the
 *   limit of failed logins (`auth.ts`).
 * - `POST /api/logout`: the session ended, the cookie cleared.
 * - `/api/<route>`: the control API's `/<route>`, logged in only (401 otherwise).
 * - Anything else: a file of the built app, `index.html` for a path it does not have; 503 while
 *   the app is not built.
 *
 * Fail closed: without the `web_ui_password` secret, or with one too short, there is no server at
 * all (`startWebUi`), and the instance runs as without a UI. A POST or a PUT must come from the UI's
 * own origin and carry JSON, so that no other site's page can make one (beside SameSite=Strict). The
 * cookie is `Secure` when the request came over HTTPS (TLS here, or `X-Forwarded-Proto: https`
 * from the proxy in front).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  LoginLimiter,
  MIN_PASSWORD,
  samePassword,
  SESSION_COOKIE,
  SESSION_MS,
  Sessions,
  type SessionStore,
} from './auth.ts';

/** The Docker secret that holds the owner's password. */
export const WEB_SECRET = 'web_ui_password';
/** The app as Vite builds it (`npm run build`). */
export const DIST = path.resolve(import.meta.dirname, '../../dist');

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export interface WebOptions {
  password: string;
  /** The control API (`controlHandler`), reached under `/api/`. */
  api: Handler;
  /** The built app; `DIST` by default. */
  dist?: string;
  now?: () => number;
  /** A session's length (`SESSION_MS`). */
  sessionMs?: number;
  /** Where the sessions are kept across restarts (the core's own store); memory only without. */
  store?: SessionStore;
  /** Failed logins allowed per client within `windowMs`. */
  maxFailures?: number;
  windowMs?: number;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

/** The largest body a login may have. */
const MAX_LOGIN = 4096;

function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Whether the request came over HTTPS, here or at the proxy in front. */
function overHttps(req: http.IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim();
  return (req.socket as { encrypted?: boolean }).encrypted === true || first === 'https';
}

/**
 * Whether a POST or a PUT is the UI's own: JSON, and from the page's origin when the browser says where
 * from (`Origin`, or `Sec-Fetch-Site`).
 */
function sameOrigin(req: http.IncomingMessage): boolean {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/iu.test(type)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const host = req.headers.host ?? '';
    return origin === `http://${host}` || origin === `https://${host}`;
  }
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

async function readBody(req: http.IncomingMessage, max: number): Promise<string | undefined> {
  let text = '';
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > max) return undefined;
  }
  return text;
}

/** The web UI as a request handler. */
export function webHandler(o: WebOptions): Handler {
  const now = o.now ?? Date.now;
  const dist = o.dist ?? DIST;
  const sessions = new Sessions({
    now,
    password: o.password,
    ...(o.sessionMs === undefined ? {} : { ttlMs: o.sessionMs }),
    ...(o.store === undefined ? {} : { store: o.store }),
  });
  const boot = crypto.randomBytes(8).toString('hex');
  const limiter = new LoginLimiter({
    now,
    ...(o.maxFailures === undefined ? {} : { max: o.maxFailures }),
    ...(o.windowMs === undefined ? {} : { windowMs: o.windowMs }),
  });

  const json = (res: http.ServerResponse, status: number, value: unknown, headers = {}): void => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(`${JSON.stringify(value)}\n`);
  };

  const cookie = (req: http.IncomingMessage, value: string, maxAgeS: number): string =>
    [
      `${SESSION_COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeS}`,
      ...(overHttps(req) ? ['Secure'] : []),
    ].join('; ');

  const login = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const client = req.socket.remoteAddress ?? '';
    const wait = limiter.retryIn(client);
    if (wait > 0) {
      const s = Math.ceil(wait / 1000);
      return json(
        res,
        429,
        { error: 'too many failed logins', retryAfterS: s },
        { 'retry-after': String(s) }
      );
    }
    const text = await readBody(req, MAX_LOGIN);
    let given: unknown;
    try {
      given =
        text === undefined ? undefined : (JSON.parse(text) as { password?: unknown }).password;
    } catch {
      given = undefined;
    }
    if (typeof given !== 'string' || !samePassword(given, o.password)) {
      limiter.failed(client);
      return json(res, 401, { error: 'wrong password' });
    }
    limiter.succeeded(client);
    const token = sessions.create();
    const maxAgeS = Math.floor((o.sessionMs ?? SESSION_MS) / 1000);
    json(res, 200, { authenticated: true }, { 'set-cookie': cookie(req, token, maxAgeS) });
  };

  const serveFile = (req: http.IncomingMessage, res: http.ServerResponse, route: string): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const index = path.join(dist, 'index.html');
    if (!fs.existsSync(index)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('The web UI is not built: npm run build\n');
      return;
    }
    let file = path.resolve(dist, `.${decodeURIComponent(route)}`);
    const inside = file.startsWith(`${path.resolve(dist)}${path.sep}`);
    if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = index;
    const hashed = path.basename(path.dirname(file)) === 'assets';
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  };

  return (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://web');
      const route = url.pathname;
      if (route !== '/api' && !route.startsWith('/api/')) return serveFile(req, res, route);
      const post = req.method === 'POST';
      // Every request that changes something (a POST, the graph's PUT, a module's DELETE) is the
      // page's own.
      const change = req.method !== 'GET' && req.method !== 'HEAD';
      if (change && !sameOrigin(req)) return json(res, 403, { error: 'not from this page' });
      const token = cookies(req)[SESSION_COOKIE];
      if (route === '/api/session')
        return json(res, 200, { authenticated: sessions.valid(token), boot });
      if (post && route === '/api/login') return login(req, res);
      if (post && route === '/api/logout') {
        sessions.end(token);
        return json(res, 200, { authenticated: false }, { 'set-cookie': cookie(req, '', 0) });
      }
      if (!sessions.valid(token)) return json(res, 401, { error: 'log in first' });
      req.url = `${route.slice('/api'.length) || '/'}${url.search}`;
      o.api(req, res);
    };
    handle().catch((err: unknown) => {
      if (!res.headersSent) json(res, 400, { error: String(err) });
      else res.end();
    });
  };
}

/** Why the password cannot open the UI, or undefined. */
export function passwordRefusal(password: string | undefined): string | undefined {
  if (password === undefined || password === '') return `no ${WEB_SECRET} secret`;
  if (password.length < MIN_PASSWORD)
    return `the ${WEB_SECRET} secret is shorter than ${MIN_PASSWORD} characters`;
  return undefined;
}

/**
 * The web UI's server, listening on `port` (all interfaces, for the proxy on the container's
 * network), when the owner's password is provided; none otherwise, with why (fail closed).
 */
export function startWebUi(o: {
  secrets: { read(name: string): string | undefined };
  api: Handler;
  port: number;
  host?: string;
  dist?: string;
  /** Where the sessions are kept across restarts: the core's own store. */
  store?: SessionStore;
  now?: () => number;
  print: (line: string) => void;
}): http.Server | undefined {
  const password = o.secrets.read(WEB_SECRET);
  const refused = passwordRefusal(password);
  if (refused !== undefined || password === undefined) {
    o.print(`web UI: off (${refused ?? ''})`);
    return undefined;
  }
  const server = http.createServer(
    webHandler({
      password,
      api: o.api,
      ...(o.dist === undefined ? {} : { dist: o.dist }),
      ...(o.store === undefined ? {} : { store: o.store }),
      ...(o.now === undefined ? {} : { now: o.now }),
    })
  );
  server.listen(o.port, o.host ?? '0.0.0.0');
  o.print(`web UI: on port ${o.port}`);
  return server;
}
