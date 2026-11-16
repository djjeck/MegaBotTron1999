// @vitest-environment happy-dom
// A model connector (D117): a `$` on its card, and what it spent in the costs.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeView, PluginControl } from '#src/ui/api.ts';
import { VIEW } from '#test/graph-view.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { CostLine, CostTable, ranking, spent } from './Costs.tsx';
import { PluginNode } from './PluginNode.tsx';

let restore: () => void;
beforeEach(() => {
  restore = stubReactFlow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restore();
});

const CHAT = VIEW.nodes[0] as NodeView;

/** A node's card, as the map draws it. */
function card(view: NodeView) {
  const props = {
    id: view.id,
    data: { view, portTypes: VIEW.portTypes },
    selected: false,
  } as unknown as Parameters<typeof PluginNode>[0];
  render(
    <ReactFlowProvider>
      <PluginNode {...props} />
    </ReactFlowProvider>
  );
}

const control = (id: string, cost: PluginControl['cost']): PluginControl => ({
  id,
  plugin: id,
  description: id,
  kinds: ['connector'],
  state: 'running',
  settings: {},
  reads: [],
  actions: [],
  ...(cost === undefined ? {} : { cost }),
});

const PLUGINS = [
  control('llm', {
    dispatch: { calls: 0, ms: 0, maxMs: 0 },
    own: { spend: { usd: 1.234, calls: 14, unpriced: 2 } },
  }),
  control('cheap', {
    dispatch: { calls: 0, ms: 0, maxMs: 0 },
    own: { spend: { usd: 0.0031, calls: 1, unpriced: 0 } },
  }),
  control('tg', { dispatch: { calls: 40, ms: 0.4, maxMs: 0.05 } }),
];

describe('a model connector (D117)', () => {
  it('is marked with a $ on its card; another node is not', () => {
    card({ ...CHAT, model: true });
    expect(screen.getByRole('img', { name: 'a model: it spends money' }).textContent).toBe('$');
    cleanup();
    card(CHAT);
    expect(screen.queryByRole('img', { name: 'a model: it spends money' })).toBeNull();
  });

  it('says what it spent over the last 24 hours, and the calls of no price', () => {
    expect(spent({ usd: 0, calls: 1, unpriced: 0 })).toBe('$0, 1 call');
    expect(spent({ usd: 0.0031, calls: 2, unpriced: 0 })).toBe('$0.0031, 2 calls');
    expect(spent({ usd: 1.234, calls: 14, unpriced: 2 })).toBe(
      '$1.23, 14 calls (2 of no price, cost unknown)'
    );
    const ranked = ranking(PLUGINS);
    render(<CostLine cost={ranked.get('llm')!} />);
    expect(document.body.textContent).toContain('$1.23, 14 calls');
    expect(document.body.textContent).toContain('over the last 24 hours');
    cleanup();
    render(<CostLine cost={ranked.get('tg')!} />);
    expect(document.body.textContent).not.toContain('24 hours');
  });

  it('shows it in the Costs sheet, sortable by it', () => {
    render(<CostTable plugins={PLUGINS} select={vi.fn()} />);
    const table = screen.getByRole('table', { name: 'nodes by cost' });
    expect(table.textContent).toContain('$1.23, 14 calls');
    const ids = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.querySelector('code')?.textContent);
    fireEvent.click(within(table).getByRole('button', { name: 'Spent' }));
    expect(ids()).toEqual(['llm', 'cheap', 'tg']);
    fireEvent.click(within(table).getByRole('button', { name: /Spent/u }));
    expect(ids()).toEqual(['tg', 'cheap', 'llm']);
  });
});
