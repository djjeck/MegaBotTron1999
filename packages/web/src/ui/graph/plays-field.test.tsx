// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotCommand } from '#src/ui/api.ts';
import { PlaysField } from './PlaysField.tsx';

afterEach(cleanup);

const DECLARED: BotCommand[] = [
  { command: '/play', turn: true },
  { command: '/coffee', effects: [{ command: '/play', clear: true }] },
  { command: '/daily', cooldownMin: 1440 },
  { command: '/shop', interactive: true },
];

/** The checklist, keeping its value as the editor's draft does, seen in `state.value`. */
function checklist(start: unknown, known = true, place?: { bot: string; group: boolean }) {
  const declared = known ? DECLARED : undefined;
  const state = { value: start };
  function Field() {
    const [value, setValue] = useState(start);
    return (
      <PlaysField
        name="commands"
        value={value}
        set={(v) => {
          state.value = v;
          setValue(v);
        }}
        declared={declared}
        missing="Draw its parser edge first."
        place={place}
      />
    );
  }
  render(<Field />);
  return state;
}

const said = (c: string): string | null =>
  screen.getByLabelText(`what it does with ${c}`).textContent;

describe('a command’s form in a group (D139)', () => {
  it('offers bare or addressed in a group, says it, and writes it', () => {
    const state = checklist(undefined, true, { bot: 'QuestBot', group: true });
    expect(screen.getByRole('note', { name: 'bare or addressed' }).textContent).toContain(
      'only @QuestBot takes it'
    );
    expect(said('/play')).toContain('sent bare, which every bot in the group that sees it takes');
    fireEvent.change(screen.getByLabelText('how it sends /play'), {
      target: { value: 'addressed' },
    });
    expect(state.value).toEqual([
      { command: '/play', addressed: true },
      { command: '/coffee' },
      { command: '/daily' },
    ]);
    expect(said('/play')).toContain('sent as /play@QuestBot');
    fireEvent.change(screen.getByLabelText('how it sends /play'), { target: { value: 'bare' } });
    expect(state.value).toBeUndefined();
  });

  it('offers no form in its bot’s private chat, unless one is addressed already', () => {
    checklist([{ command: '/play' }, { command: '/daily', addressed: true }], true, {
      bot: 'QuestBot',
      group: false,
    });
    expect(screen.queryByLabelText('how it sends /play')).toBeNull();
    expect(screen.getByLabelText('how it sends /daily')).not.toBeNull();
    expect(screen.queryByRole('note', { name: 'bare or addressed' })).toBeNull();
  });
});

describe('a player’s commands as a checklist (D137)', () => {
  it('checks every command but an interactive one, and says what it will do with each', () => {
    checklist(undefined);
    expect(screen.getByLabelText<HTMLInputElement>('play /play').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('play /shop').checked).toBe(false);
    expect(said('/play')).toBe("a turn: played whenever the bot's rest is over");
    expect(said('/coffee')).toBe('played if /play is cooling down; ends its cool-down');
    expect(said('/shop')).toBe('needs you to answer: not played by default');
    expect(screen.getByLabelText<HTMLSelectElement>('when it plays /coffee').value).toBe('/play');
    expect(screen.queryByLabelText('when it plays /shop')).toBeNull();
  });

  it('writes the list once it differs from the defaults, and goes back to them', () => {
    const state = checklist(undefined);
    fireEvent.click(screen.getByLabelText('play /daily'));
    expect(state.value).toEqual([{ command: '/play' }, { command: '/coffee' }]);
    expect(said('/daily')).toBe('not played');
    fireEvent.change(screen.getByLabelText('when it plays /coffee'), { target: { value: '' } });
    expect(state.value).toEqual([{ command: '/play' }, { command: '/coffee', whenReady: true }]);
    expect(said('/coffee')).toBe("played whenever ready; ends /play's cool-down");
    fireEvent.click(screen.getByRole('button', { name: 'back to the defaults' }));
    expect(state.value).toBeUndefined();
    // Checking the interactive one is a choice of the owner's.
    fireEvent.click(screen.getByLabelText('play /shop'));
    expect(state.value).toHaveLength(4);
    fireEvent.click(screen.getByLabelText('play /shop'));
    expect(state.value).toBeUndefined();
  });

  it('keeps a command its parser does not declare, and says so', () => {
    checklist([{ command: '/play' }, { command: '/dance' }]);
    expect(screen.getByRole('note').textContent).toContain('Its parser declares none of /dance');
  });

  it('is typed as JSON without its parser’s commands, and under Edit as JSON', () => {
    const state = checklist([{ command: '/play' }], false);
    expect(screen.getByRole('note').textContent).toBe('Draw its parser edge first.');
    const text = screen.getByLabelText('commands');
    fireEvent.change(text, { target: { value: '[{"command":"/go"}]' } });
    fireEvent.blur(text);
    expect(state.value).toEqual([{ command: '/go' }]);
    cleanup();
    const again = checklist(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Edit as JSON' }));
    const json = screen.getByLabelText('commands as JSON');
    fireEvent.change(json, { target: { value: '[]' } });
    fireEvent.blur(json);
    expect(again.value).toEqual([]);
  });
});
