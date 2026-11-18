/**
 * A player's `commands` as a checklist (bot-os.md D137, `plays.ts`): a row per command of the
 * parser its `parser` edge binds, in the parser's order, each with a checkbox (played or not; by
 * default every one but an interactive one), a sentence saying what the player will do with it,
 * and a choice of its policy when played: whenever ready, or only while another command is cooling
 * down; and, when played, its forms, each with its tick (D140): each of its names bare (`/play`,
 * which every bot in the group that declares it takes) and, where the player sends to a group,
 * addressed to its bot (`/play@QuestBot`). All ticked by default; the last one ticked cannot be
 * unticked. A single form is not offered: it is all it sends.
 * Left as the defaults, its config names no commands, and the player follows its parser.
 * Without a parser edge, or a parser that declares no commands, the list is typed as JSON, as it
 * always can be under "Edit as JSON".
 */
import { useState } from 'react';
import type { BotCommand } from '#src/ui/api.ts';
import type { PlayPlace, PlayRow, Policy } from './plays.ts';
import {
  entriesOf,
  listedForms,
  playRows,
  playSentence,
  rowsValue,
  unknownEntries,
} from './plays.ts';
import { JsonField } from './SchemaForm.tsx';

const READY = '';

export function PlaysField(props: {
  name: string;
  value: unknown;
  set: (v: unknown) => void;
  /** The commands of its parser, in its order; undefined: none known. */
  declared: readonly BotCommand[] | undefined;
  /** Why none are known, said instead of the checklist. */
  missing: string;
  /** Where it sends (D139): its bot, and whether in a group; undefined, unknown. */
  place?: PlayPlace | undefined;
}) {
  const [json, setJson] = useState(false);
  const { declared, place } = props;
  if (declared === undefined)
    return (
      <>
        <p className="note small" role="note">
          {props.missing}
        </p>
        <JsonField name={props.name} value={props.value} set={props.set} />
      </>
    );
  const rows = playRows(props.value, declared, place?.bot);
  const extra = unknownEntries(props.value, declared);
  const defaults = entriesOf(props.value) === undefined;
  const write = (next: PlayRow[]): void => props.set(rowsValue(next, extra));
  const change = (i: number, row: Partial<PlayRow>): void =>
    write(rows.map((r, j) => (j === i ? { ...r, ...row } : r)));
  return (
    <div className="plays-field">
      <ul aria-label={`${props.name}: what it plays`}>
        {rows.map((r, i) => {
          const c = r.command.command;
          const others = declared.filter((d) => d.command !== c).map((d) => d.command);
          return (
            <li key={c}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`play ${c}`}
                  checked={r.played}
                  onChange={(e) => change(i, { played: e.target.checked })}
                />{' '}
                <code>{c}</code>
              </label>{' '}
              <span className="muted small" aria-label={`what it does with ${c}`}>
                {playSentence(r, defaults, place)}
              </span>
              {r.played ? (
                <select
                  aria-label={`when it plays ${c}`}
                  className="small"
                  value={r.policy ?? READY}
                  onChange={(e) => {
                    const policy: Policy = e.target.value === READY ? undefined : e.target.value;
                    change(i, { policy });
                  }}
                >
                  <option value={READY}>whenever ready</option>
                  {others.map((o) => (
                    <option key={o} value={o}>
                      if {o} is cooling down
                    </option>
                  ))}
                </select>
              ) : null}
              {r.played ? (
                <Forms
                  row={r}
                  place={place}
                  set={(forms) => {
                    const { forms: _, addressed: __, ...rest } = r;
                    write(
                      rows.map((x, j) =>
                        j === i ? (forms === undefined ? rest : { ...rest, forms }) : x
                      )
                    );
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {place?.group === true ? (
        <p className="muted small" role="note" aria-label="bare or addressed">
          In a group, a bare command reaches every bot there that declares it and sees it (one that
          is an admin, or whose privacy mode is off), so one send plays them all; addressed, only @
          {place.bot} takes it. Each command goes as the ticked form that reaches the most bots,
          each of which would play it then, the first in order on a tie; an unticked form is never
          sent.
        </p>
      ) : null}
      {extra.length === 0 ? null : (
        <p className="warning small" role="note">
          Its parser declares none of {extra.map((e) => e.command).join(', ')}: kept, never played.
        </p>
      )}
      <p className="muted small">
        {defaults
          ? 'The defaults: it follows its parser, every command but those that need you to answer.'
          : 'Your choice: '}
        {defaults ? null : (
          <button type="button" className="link" onClick={() => props.set(undefined)}>
            back to the defaults
          </button>
        )}{' '}
        Its chat edge allows the commands it plays.
      </p>
      <p className="small">
        <button
          type="button"
          className="link"
          aria-expanded={json}
          onClick={() => setJson((was) => !was)}
        >
          Edit as JSON
        </button>
      </p>
      {json ? (
        <JsonField name={`${props.name} as JSON`} value={props.value} set={props.set} />
      ) : null}
    </div>
  );
}

/**
 * A played command's forms, each with its tick (D140), when it has more than one: unticking one
 * writes the rest, all ticked again writes none (every one); the last one ticked stays.
 */
function Forms(props: {
  row: PlayRow;
  place: PlayPlace | undefined;
  set: (forms: string[] | undefined) => void;
}) {
  const { row, place } = props;
  const listed = listedForms(row, place);
  if (listed.length < 2) return null;
  const on = row.forms ?? listed;
  const c = row.command.command;
  return (
    <span className="small" role="group" aria-label={`forms of ${c}`}>
      {listed.map((f) => {
        const ticked = on.includes(f);
        return (
          <label key={f}>
            {' '}
            <input
              type="checkbox"
              aria-label={`send ${c} as ${f}`}
              checked={ticked}
              disabled={ticked && on.length === 1}
              onChange={(e) => {
                const next = listed.filter((x) => (x === f ? e.target.checked : on.includes(x)));
                props.set(next.length === listed.length ? undefined : next);
              }}
            />{' '}
            <code>{f}</code>
          </label>
        );
      })}
    </span>
  );
}
