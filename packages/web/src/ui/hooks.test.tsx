// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, seg } from './api.ts';
import { duration, useLoad } from './hooks.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('duration', () => {
  it('says a span in its two largest units', () => {
    expect(duration(40)).toBe('40s');
    expect(duration(125)).toBe('2m 5s');
    expect(duration(7500)).toBe('2h 5m');
    expect(duration(3 * 86_400 + 4 * 3600)).toBe('3d 4h');
  });
});

describe('seg', () => {
  it('encodes a path segment', () => {
    expect(seg('a b/c')).toBe('a%20b%2Fc');
  });
});

function Probe(props: { load: () => Promise<string>; out: () => void }) {
  const l = useLoad(props.load, props.out, 1000);
  return (
    <p>
      {l.data ?? '-'} {l.error ?? ''}
    </p>
  );
}

describe('useLoad', () => {
  it('loads at once and again every while, keeping the last data on an error', async () => {
    vi.useFakeTimers();
    const answers: (string | Error)[] = ['one', new Error('down'), 'two'];
    const load = vi.fn(() => {
      const a = answers.shift() ?? 'last';
      return typeof a === 'string' ? Promise.resolve(a) : Promise.reject(a);
    });
    const out = vi.fn();
    render(<Probe load={load} out={out} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText(/one/u).textContent).toBe('one ');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText(/one/u).textContent).toBe('one down');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText(/two/u).textContent).toBe('two ');
    expect(out).not.toHaveBeenCalled();
  });

  it('tells the app of a 401, and drops what comes after the page is gone', async () => {
    const out = vi.fn();
    render(<Probe load={() => Promise.reject(new ApiError(401, 'log in'))} out={out} />);
    await act(() => Promise.resolve());
    expect(out).toHaveBeenCalledOnce();
    cleanup();
    let resolve: (v: string) => void = () => {};
    let reject: (e: unknown) => void = () => {};
    const { unmount } = render(
      <Probe load={() => new Promise<string>((r) => (resolve = r))} out={out} />
    );
    unmount();
    resolve('late');
    render(<Probe load={() => new Promise<string>((_r, j) => (reject = j))} out={out} />).unmount();
    reject('late');
    await act(() => Promise.resolve());
    expect(out).toHaveBeenCalledOnce();
  });
});
