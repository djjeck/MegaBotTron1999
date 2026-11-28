// @vitest-environment happy-dom
/** A view's live updates (bot-os.md D173): the safety refresh, and no stream for no node. */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '#test/fake-api.ts';
import { readAll, SAFETY_REFRESH_MS, useLive } from './live.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Probe(props: { nodes: string[]; changed: (nodes?: ReadonlySet<string>) => void }) {
  useLive(props.nodes, props.changed);
  return null;
}

describe('useLive', () => {
  it('asks everything every SAFETY_REFRESH_MS while visible, and opens no stream for no node', () => {
    vi.useFakeTimers();
    const api = fakeApi({});
    const changed = vi.fn();
    render(<Probe nodes={['a', 'b', 'a']} changed={changed} />);
    expect(api.streams.map((s) => s.url)).toEqual(['/changes?nodes=a%2Cb']);
    act(() => vi.advanceTimersByTime(SAFETY_REFRESH_MS));
    expect(changed).toHaveBeenCalledWith();
    cleanup();
    expect(api.streams[0]?.closed).toBe(true);
    render(<Probe nodes={[]} changed={changed} />);
    expect(api.streams).toHaveLength(1);
  });

  it('tells the nodes a change names', () => {
    const api = fakeApi({});
    const changed = vi.fn();
    render(<Probe nodes={['a']} changed={changed} />);
    // A fake stream tells a nodes list; a broken message is everything.
    (api.streams[0] as unknown as { change: (n: unknown) => void }).change(['a']);
    expect(changed).toHaveBeenLastCalledWith(new Set(['a']));
  });

  it('asks no batch for no read', async () => {
    expect(await readAll([])).toEqual([]);
  });
});
