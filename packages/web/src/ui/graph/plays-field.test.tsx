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
function checklist(
  start: unknown,
  known: boolean | BotCommand[] = true,
  place?: { bot: string; group: boolean }
) {
  const declared = known === true ? DECLARED : known === false ? undefined : known;
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

describe('a command’s forms, each with its tick (D140)', () => {
  const ALIASED: BotCommand[] = [
    { command: '/quest', aliases: ['/play'], turn: true },
    { command: '/daily', cooldownMin: 1440 },
  ];

  it('lists each form in a group, all ticked, says how one is chosen, and writes the unticked', () => {
    const state = checklist(undefined, ALIASED, { bot: 'LoreBot', group: true });
    expect(screen.getByRole('note', { name: 'bare or addressed' }).textContent).toContain(
      'only @LoreBot takes it'
    );
    const forms = screen.getByRole('group', { name: 'forms of /quest' });
    expect(forms.textContent?.trim().split(/\s+/u)).toEqual([
      '/quest',
      '/quest@LoreBot',
      '/play',
      '/play@LoreBot',
    ]);
    expect(said('/quest')).toContain('sent as the form that plays the most ready turns at once');
    fireEvent.click(screen.getByLabelText('send /quest as /quest'));
    expect(state.value).toEqual([
      { command: '/quest', forms: ['/quest@LoreBot', '/play', '/play@LoreBot'] },
      { command: '/daily' },
    ]);
    fireEvent.click(screen.getByLabelText('send /quest as /play'));
    fireEvent.click(screen.getByLabelText('send /quest as /play@LoreBot'));
    expect(said('/quest')).toContain('sent as /quest@LoreBot, which only @LoreBot takes');
    // The last one ticked stays.
    expect(screen.getByLabelText<HTMLInputElement>('send /quest as /quest@LoreBot').disabled).toBe(
      true
    );
    for (const f of ['/quest', '/play', '/play@LoreBot'])
      fireEvent.click(screen.getByLabelText(`send /quest as ${f}`));
    expect(state.value).toBeUndefined();
  });

  it('lists only its names in its bot’s private chat, a single one not at all', () => {
    checklist([{ command: '/quest' }, { command: '/daily', forms: ['/daily@LoreBot'] }], ALIASED, {
      bot: 'LoreBot',
      group: false,
    });
    const text = (c: string) =>
      screen
        .getByRole('group', { name: `forms of ${c}` })
        .textContent?.trim()
        .split(/\s+/u);
    expect(text('/quest')).toEqual(['/quest', '/play']);
    // An addressed form its entry allows is listed, to untick.
    expect(text('/daily')).toEqual(['/daily', '/daily@LoreBot']);
    expect(screen.queryByRole('note', { name: 'bare or addressed' })).toBeNull();
    cleanup();
    checklist(undefined);
    expect(screen.queryByRole('group', { name: 'forms of /play' })).toBeNull();
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
