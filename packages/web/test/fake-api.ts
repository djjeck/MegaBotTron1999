/**
 * A fake of the UI's server for the app's tests: `fetch` answered from a table of routes, each
 * call kept. A route is the method and the path after `api` (`GET /status`, `POST /plugins/a/kill`).
 */
import { vi } from 'vitest';

export type Answer = [status: number, value: unknown] | ((body: unknown) => [number, unknown]);

export interface FakeApi {
  /** Every call: `GET /status`, `POST /login {"password":"x"}`. */
  calls: string[];
  routes: Record<string, Answer>;
}

/** Stubs `fetch` with the routes; an unknown route is a 404. */
export function fakeApi(routes: Record<string, Answer>): FakeApi {
  const api: FakeApi = { calls: [], routes };
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^api/u, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    api.calls.push(
      body === undefined ? `${method} ${path}` : `${method} ${path} ${init?.body as string}`
    );
    const answer = api.routes[`${method} ${path}`] ?? [404, { error: 'not found' }];
    const [status, value] = typeof answer === 'function' ? answer(body) : answer;
    return Promise.resolve(
      new Response(value === undefined ? 'not json' : JSON.stringify(value), { status })
    );
  });
  return api;
}
