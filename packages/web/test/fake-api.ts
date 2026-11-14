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
}

/**
 * Stubs `fetch`, and `XMLHttpRequest` (the uploads', with their progress: half the body, a
 * moment, then all of it), with the routes; an unknown route is a 404. `offline` makes every upload fail as a
 * network error does.
 */
export function fakeApi(routes: Record<string, Answer>): FakeApi {
  const api: FakeApi = { calls: [], routes };
  const answer = (method: string, url: string, text: string | undefined): [number, string] => {
    const path = url.replace(/^api/u, '');
    const body = text === undefined ? undefined : (JSON.parse(text) as unknown);
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
