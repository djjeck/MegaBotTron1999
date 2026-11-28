/**
 * A fake of the UI's server for the app's tests: `fetch` answered from a table of routes, each
 * call kept. A route is the method and the path after `api` (`GET /status`, `POST /plugins/a/kill`).
 */
import { vi } from 'vitest';
import { type UploadProgress } from '#src/ui/api.ts';

export type Answer = [status: number, value: unknown] | ((body: unknown) => [number, unknown]);

export interface FakeApi {
  /** Every call: `GET /status`, `POST /login {"password":"x"}`. */
  calls: string[];
  routes: Record<string, Answer>;
  /** Every upload fails as a network error does, when set. */
  offline?: boolean;
  /** How many `POST /reads` batches were asked (D173), each read in it kept in `calls` as a GET. */
  batches: number;
  /** The change streams open (`GET /changes`, D173), with a way to tell them a change. */
  streams: FakeStream[];
}

/** A change stream as the page opened it: its URL, whether closed, and a change to tell it. */
export interface FakeStream {
  url: string;
  closed: boolean;
  /** Tells it these nodes changed, as the core's `changed` event does. */
  change(nodes: string[]): void;
  /** It broke and opened again, as an `EventSource` does on its own. */
  reopen(): void;
}

/**
 * Stubs `fetch`, and `XMLHttpRequest` (the uploads', with their progress: half the body, a
 * moment, then all of it), with the routes; an unknown route is a 404. `offline` makes every upload fail as a
 * network error does.
 */
export function fakeApi(routes: Record<string, Answer>): FakeApi {
  const api: FakeApi = { calls: [], routes, batches: 0, streams: [] };
  const answer = (method: string, url: string, text: string | undefined): [number, string] => {
    const path = url.replace(/^api/u, '');
    const body = text === undefined ? undefined : (JSON.parse(text) as unknown);
    // A batch of reads (D173), unless a test answers it itself: each read answered as its GET.
    if (method === 'POST' && path === '/reads' && api.routes['POST /reads'] === undefined) {
      api.batches += 1;
      const reads = (
        body as { reads: { node: string; read: string; input?: Record<string, string> }[] }
      ).reads;
      const answers = reads.map((r) => {
        const fields = Object.entries(r.input ?? {});
        const q = fields.length === 0 ? '' : `?${new URLSearchParams(fields).toString()}`;
        const [status, value] = answer(
          'GET',
          `/plugins/${encodeURIComponent(r.node)}/state/${encodeURIComponent(r.read)}${q}`,
          undefined
        );
        const parsed = value === 'not json' ? null : (JSON.parse(value) as unknown);
        return status < 300
          ? { value: parsed }
          : { error: (parsed as { error?: string } | null)?.error ?? `HTTP ${status}` };
      });
      return [200, JSON.stringify({ answers })];
    }
    api.calls.push(body === undefined ? `${method} ${path}` : `${method} ${path} ${text}`);
    const route = api.routes[`${method} ${path}`] ?? [404, { error: 'not found' }];
    const [status, value] = typeof route === 'function' ? route(body) : route;
    return [status, value === undefined ? 'not json' : JSON.stringify(value)];
  };
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const [status, text] = answer(
      init?.method ?? 'GET',
      url,
      typeof init?.body === 'string' ? init.body : undefined
    );
    return Promise.resolve(new Response(text, { status }));
  });
  vi.stubGlobal(
    'EventSource',
    class {
      private readonly listeners = new Map<string, ((e: { data: string }) => void)[]>();
      constructor(url: string) {
        api.calls.push(`STREAM ${url.replace(/^api/u, '')}`);
        const stream: FakeStream = {
          url: url.replace(/^api/u, ''),
          closed: false,
          change: (nodes) => this.emit('changed', JSON.stringify({ nodes })),
          reopen: () => this.emit('open', ''),
        };
        this.stream = stream;
        api.streams.push(stream);
        setTimeout(() => this.emit('open', ''), 0);
      }
      readonly stream: FakeStream;
      addEventListener(type: string, fn: (e: { data: string }) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      }
      close(): void {
        this.stream.closed = true;
      }
      private emit(type: string, data: string): void {
        if (this.stream.closed) return;
        for (const fn of this.listeners.get(type) ?? []) fn({ data });
      }
    }
  );
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      status = 0;
      responseText = '';
      withCredentials = false;
      upload: { onprogress?: (e: UploadProgress) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      private method = 'GET';
      private url = '';
      open(method: string, url: string): void {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(): void {}
      send(text: string): void {
        const total = text.length;
        const sent = (loaded: number): void =>
          this.upload.onprogress?.({ lengthComputable: true, loaded, total });
        setTimeout(() => {
          if (api.offline === true) return this.onerror?.();
          sent(Math.floor(total / 2));
          // Long enough for the page to show it.
          setTimeout(() => {
            sent(total);
            [this.status, this.responseText] = answer(this.method, this.url, text);
            this.onload?.();
          }, 30);
        }, 0);
      }
    }
  );
  return api;
}
