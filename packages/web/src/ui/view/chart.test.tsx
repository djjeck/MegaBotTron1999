// @vitest-environment happy-dom
/** A view's chart (bot-os.md D174), drawn by Plot in the page's colours, as wide as its card. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Chart from './Chart.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROWS = [
  { at: Date.UTC(2026, 10, 20, 9), counted: true, amount: 120 },
  { at: Date.UTC(2026, 10, 21, 9), counted: false, amount: 40 },
];

describe('Chart', () => {
  it('draws its points with a legend for several series, in the palette when the view sets none', async () => {
    render(
      <Chart
        chart={{
          show: 'timeseries',
          label: 'Donations per day',
          x: 'at',
          interval: 'day',
          series: 'counted',
          seriesLabels: { true: 'Counted', false: 'Not counted' },
          stack: true,
          value: { path: 'amount', label: 'Value', unit: '₭' },
        }}
        value={ROWS}
        empty="No donation yet"
      />
    );
    const figure = screen.getByRole('figure', { name: 'Donations per day' });
    await waitFor(() => expect(figure.querySelector('svg')).not.toBeNull());
    expect(figure.textContent).toContain('Not counted');
    expect(figure.innerHTML).toContain('#2563eb');
  });

  it('says it is empty with no row, and follows the dark scheme', async () => {
    const listeners: (() => void)[] = [];
    let dark = false;
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, f: () => void) => listeners.push(f),
      removeEventListener: () => {},
    }));
    const { rerender } = render(
      <Chart chart={{ show: 'chart', x: 'a' }} value={[]} empty="None" />
    );
    expect(screen.getByText('None')).toBeDefined();
    rerender(<Chart chart={{ show: 'chart', x: 'a' }} value={[{ a: 'x' }]} empty="None" />);
    const figure = screen.getByRole('figure', { name: 'chart' });
    await waitFor(() => expect(figure.querySelector('svg')).not.toBeNull());
    dark = true;
    listeners.forEach((f) => f());
    await waitFor(() => expect(figure.innerHTML).toContain('#60a5fa'));
  });
});
