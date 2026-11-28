// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, seg } from './api.ts';
import { duration, poll, useLoad } from './hooks.ts';

/** The page shown or hidden, as a browser says when its tab is switched (D172). */
function show(visible: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  cleanup();
  show(true);
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

describe('poll (D172)', () => {
  it('asks at once and every while, none while hidden, once at once when shown again', async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => Promise.resolve());
    const p = poll(run, 5000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
    show(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    show(true);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4999);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(4);
    p.stop();
    show(false);
    show(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('never asks while its last ask is unanswered; a now() then asks once more after it', async () => {
    vi.useFakeTimers();
    const answers: (() => void)[] = [];
    const run = vi.fn(() => new Promise<void>((r) => answers.push(r)));
    const p = poll(run, 1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    p.now();
    p.now();
    expect(run).toHaveBeenCalledTimes(1);
    answers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    answers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
    p.stop();
    p.now();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('asks on after a failed ask', async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => Promise.reject(new Error('down')));
    const p = poll(run, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('starts hidden with one ask, then none until shown', async () => {
    vi.useFakeTimers();
    show(false);
    const run = vi.fn(() => Promise.resolve());
    const p = poll(run, 1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    show(true);
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
  });
});

describe('useLoad while hidden (D172)', () => {
  it('stops loading while the page is hidden and reloads at once when it shows', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.resolve('x'));
    render(<Probe load={load} out={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(load).toHaveBeenCalledTimes(1);
    act(() => show(false));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(load).toHaveBeenCalledTimes(1);
    act(() => show(true));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
