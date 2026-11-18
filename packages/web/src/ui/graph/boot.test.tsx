// @vitest-environment happy-dom
// The start in the background (D143): while the plugins load, the editor says so and the nodes are
// `loading`; a node whose plugin did not load says `failed to load`, naming the package or module
// and its error, and where to fix it; once the start moves on, the plugins are read again.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginControl, Status } from '#src/ui/api.ts';
import { fakeCore } from '#test/fake-core.ts';
import { status } from '#test/graph-view.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { GraphPage } from './GraphPage.tsx';
import { stateOf } from './PluginNode.tsx';

let restore: () => void;
beforeEach(() => {
  restore = stubReactFlow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restore();
});

const loggedOut = vi.fn();
const slow = { timeout: 5000 };

const FAILURE = { source: 'module dice', module: 'dice', error: "Unexpected token ';'" };

/** The status with the parser `as` given, and the start `phase`. */
const booting = (phase: 'loading' | 'started', parser: Partial<PluginControl>): Status => ({
  ...status(),
  boot: { phase, failures: phase === 'started' ? [FAILURE] : [] },
  plugins: status().plugins.map((p) => (p.id === 'parser' ? { ...p, ...parser } : p)),
});

describe('a node’s state as the plugins load (D143)', () => {
  it('draws loading, and failed to load with why', () => {
    const live = status().plugins[0] as PluginControl;
    expect(stateOf({ ...live, state: 'loading' }, false)).toEqual({
      look: 'loading',
      badge: 'loading',
      why: 'its plugin is loading',
    });
    expect(stateOf({ ...live, state: 'unloaded', reason: 'module dice failed' }, false)).toEqual({
      look: 'failed',
      badge: 'failed to load',
      why: 'module dice failed',
    });
    expect(stateOf({ ...live, state: 'unloaded' }, false)).toEqual({
      look: 'failed',
      badge: 'failed to load',
    });
  });

  it('says the plugins load, then names what failed to load on its node and in its panel', async () => {
    let phase: 'loading' | 'started' = 'loading';
    const { api } = fakeCore({
      routes: {
        'GET /status': () => [
          200,
          phase === 'loading'
            ? booting('loading', { state: 'loading' })
            : booting('started', {
                state: 'unloaded',
                reason: `its plugin parser did not load: module dice failed: ${FAILURE.error}`,
                failures: [FAILURE, { source: 'package @megabottron1999/turns', error: 'boom' }],
              }),
        ],
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    expect(await screen.findByText('Loading the plugins…', {}, slow)).toBeDefined();
    const card = await screen.findByLabelText('node parser', {}, slow);
    expect(within(card).getByText('loading')).toBeDefined();
    const available = api.calls.filter((c) => c.startsWith('GET /available')).length;
    const checks = api.calls.filter((c) => c.startsWith('POST /graph/check')).length;
    phase = 'started';
    // The status is read again every 5 s.
    act(() => void vi.advanceTimersByTime(5_100));
    const banner = await screen.findByRole('alert', { name: 'not loaded' }, slow);
    expect(banner.textContent).toContain(`module dice: ${FAILURE.error}`);
    expect(within(banner).getByRole('link', { name: 'Modules' }).getAttribute('href')).toBe(
      '#/modules'
    );
    const failed = await within(screen.getByLabelText('node parser')).findByText(
      'failed to load',
      {},
      slow
    );
    expect(failed.getAttribute('title')).toContain('module dice failed');
    expect(failed.className).toBe('badge failed-to-load');
    fireEvent.click(screen.getByLabelText('node parser'));
    const why = await screen.findByLabelText('why parser did not load', {}, slow);
    expect(why.textContent).toContain(`module dice: ${FAILURE.error}`);
    expect(why.textContent).toContain('Reinstall it, or roll it back, on the Modules page');
    expect(screen.getByText(/A package of the image that does not load/u)).toBeDefined();
    // The plugins, and the check of the draft, read again once the start moved on.
    await waitFor(() =>
      expect(api.calls.filter((c) => c.startsWith('GET /available')).length).toBeGreaterThan(
        available
      )
    );
    await waitFor(() =>
      expect(api.calls.filter((c) => c.startsWith('POST /graph/check')).length).toBeGreaterThan(
        checks
      )
    );
    vi.useRealTimers();
  });
});
