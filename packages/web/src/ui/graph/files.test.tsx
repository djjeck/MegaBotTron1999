// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesView } from '#src/ui/api.ts';
import { fakeCore } from '#test/fake-core.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { sizeText } from './Files.tsx';
import { GraphPage } from './GraphPage.tsx';

let restore: () => void;
beforeEach(() => {
  restore = stubReactFlow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restore();
});

const slow = { timeout: 5000 };
const T = Date.parse('2026-11-12T09:00:00Z');

const FILES: FilesView = {
  files: [
    { name: 'card-42.png', size: 2_500_000, type: 'image/png', written: T },
    { name: 'notes.pdf', size: 300, type: 'application/pdf', written: T + 60_000 },
  ],
  used: 2_500_300,
  limits: { file: 16 * 2 ** 20, total: 256 * 2 ** 20 },
};

describe('a node’s files in its panel (D149)', () => {
  it('lists them, an image shown, each a download; none, nothing', async () => {
    let answer: [number, unknown] = [200, FILES];
    fakeCore({ routes: { 'GET /plugins/parser/files': () => answer } });
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node parser', {}, slow));
    const files = await screen.findByLabelText('files of parser');
    expect(within(files).getByText('2 files, 2.4 MB of the 256.0 MB it may keep.')).toBeDefined();
    const image = within(files).getByRole('img', { name: 'card-42.png' });
    expect(image.getAttribute('src')).toBe('api/plugins/parser/files/card-42.png');
    const link = within(files).getByRole('link', { name: 'notes.pdf' });
    expect(link.getAttribute('href')).toBe('api/plugins/parser/files/notes.pdf');
    expect(link.getAttribute('download')).toBe('notes.pdf');
    expect(
      within(files).getByText(/300 B · application\/pdf · 2026-11-12 09:01 UTC/u)
    ).toBeDefined();
    // Only an image is shown.
    expect(within(files).getAllByRole('img')).toHaveLength(1);
    answer = [200, { ...FILES, files: [FILES.files[1]], used: 300 }];
    fireEvent.click(screen.getByLabelText('node chat · out'));
    fireEvent.click(await screen.findByLabelText('node parser'));
    expect(await screen.findByText('1 file, 300 B of the 256.0 MB it may keep.')).toBeDefined();
    answer = [200, { ...FILES, files: [], used: 0 }];
    fireEvent.click(screen.getByLabelText('node chat · out'));
    fireEvent.click(await screen.findByLabelText('node parser'));
    // The answer read, the section is left out.
    const settled = () => new Promise((r) => setTimeout(r, 100));
    await settled();
    expect(screen.queryByLabelText('files of parser')).toBeNull();
    answer = [404, { error: 'no plugin parser' }];
    fireEvent.click(screen.getByLabelText('node chat · out'));
    fireEvent.click(await screen.findByLabelText('node parser'));
    await settled();
    expect(screen.queryByLabelText('files of parser')).toBeNull();
  }, 20_000);

  it('words a size', () => {
    expect(sizeText(5)).toBe('5 B');
    expect(sizeText(1536)).toBe('1.5 KB');
    expect(sizeText(3 * 2 ** 20)).toBe('3.0 MB');
  });
});
