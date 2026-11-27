// @vitest-environment happy-dom
/**
 * A view node's panel (docs/bot-os.md D170): its path, set from its Path field, and its links to
 * its page; any node's links to the views that show it.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PathField, ViewLinks } from './NodeDetails.tsx';

afterEach(() => cleanup());

describe('a view’s path (D170)', () => {
  it('is set as written, its id when emptied, and only as lower-case words and dashes', () => {
    const set = vi.fn();
    const { rerender } = render(<PathField id="home" path={undefined} set={set} />);
    const field = screen.getByLabelText('path') as HTMLInputElement;
    const button = screen.getByRole('button', { name: 'Set' }) as HTMLButtonElement;
    expect(field.placeholder).toBe('home');
    expect(screen.getByText(/Served at \/v\/home\//u)).toBeDefined();
    expect(button.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'Not A Path' } });
    expect(screen.getByText('Lower-case words and dashes, as an id.')).toBeDefined();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(set).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: ' gold ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(set).toHaveBeenLastCalledWith('gold');
    rerender(<PathField id="home" path="gold" set={set} />);
    fireEvent.change(field, { target: { value: 'home' } });
    fireEvent.click(button);
    expect(set).toHaveBeenLastCalledWith(undefined);
    fireEvent.keyDown(field, { key: 'a' });
  });
});

describe('a node’s links to views (D170)', () => {
  it('opens a view’s page, and lists the views that show a node', () => {
    render(
      <ViewLinks
        view={{
          served: { path: 'gold', bound: {} },
          shownIn: [
            { node: 'home', path: 'gold' },
            { node: 'board', path: 'board' },
          ],
        }}
        running={false}
      />
    );
    expect(screen.getByRole('link', { name: 'Open its view: /v/gold/' }).getAttribute('href')).toBe(
      'v/gold/'
    );
    expect(screen.getByText('(once applied)')).toBeDefined();
    const views = screen.getByLabelText('its views');
    expect(within(views).getByRole('link', { name: 'board' }).getAttribute('href')).toBe(
      'v/board/'
    );
  });

  it('shows nothing for a node of no view', () => {
    const { container } = render(<ViewLinks view={{}} running />);
    expect(container.textContent).toBe('');
  });
});
