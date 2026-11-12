// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '#test/fake-api.ts';
import { Restart } from './Restart.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Restart', () => {
  it('waits while the old process answers, then hands back once a new one does', async () => {
    let polls = 0;
    fakeApi({
      'POST /restart': [200, { restarting: true }],
      'GET /session': () => {
        polls++;
        // Before the restart, then twice the old process still, then down, then the new one.
        if (polls <= 3) return [200, { authenticated: true, boot: 'old' }];
        if (polls === 4) return [502, {}];
        return [200, { authenticated: true, boot: 'new' }];
      },
    });
    const done = vi.fn();
    render(<Restart done={done} loggedOut={vi.fn()} failed={vi.fn()} everyMs={5} />);
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(polls).toBe(5);
  });

  it('restarts even when the session cannot be read first, and stops when closed', async () => {
    const api = fakeApi({
      'POST /restart': [200, { restarting: true }],
      'GET /session': [502, {}],
    });
    const { unmount } = render(
      <Restart done={vi.fn()} loggedOut={vi.fn()} failed={vi.fn()} everyMs={5} />
    );
    expect(
      await screen.findByText('Starting again: waiting for the instance to answer…')
    ).toBeDefined();
    unmount();
    const calls = api.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(api.calls.length).toBe(calls);
    expect(api.calls).toContain('POST /restart {}');
  });

  it('asks nothing more once closed before the instance answers', async () => {
    let answer: (v: Response) => void = () => {};
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      fetched.push(url);
      return new Promise<Response>((r) => (answer = r));
    });
    const failed = vi.fn();
    const { unmount } = render(
      <Restart done={vi.fn()} loggedOut={vi.fn()} failed={failed} everyMs={5} />
    );
    unmount();
    answer(new Response(JSON.stringify({ authenticated: true, boot: 'x' }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched).toEqual(['api/session']);
    expect(failed).not.toHaveBeenCalled();
  });
});
