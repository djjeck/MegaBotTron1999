/**
 * A sensitive config field (docs/bot-os.md D124): its value is never shown back. The editor is given
 * `{ "$sensitive": "set" }` for a value that is set, sends it back as it is to keep the value, and
 * writes a new one only when the owner types it: so the field says whether it is set, and offers to
 * replace it (typed unseen) or clear it.
 */
import { useState } from 'react';

/** Whether a value is the core's `HIDDEN`: set, not shown. */
export const isHidden = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && (v as Record<string, unknown>)['$sensitive'] === 'set';

export function SensitiveField(props: { name: string; value: unknown; set: (v: unknown) => void }) {
  const { name, value, set } = props;
  const [typing, setTyping] = useState(false);
  const state =
    value === undefined ? 'not set' : isHidden(value) ? 'set' : 'set anew, saved with Apply';
  return (
    <span className="sensitive">
      <span className={value === undefined ? 'muted' : 'ok'} aria-label={`${name} state`}>
        {state}
      </span>{' '}
      {typing ? (
        <input
          aria-label={name}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="the new value"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)}
        />
      ) : (
        <button type="button" onClick={() => setTyping(true)}>
          {value === undefined ? 'Set' : 'Replace'}
        </button>
      )}
      {value === undefined ? null : (
        <>
          {' '}
          <button
            type="button"
            onClick={() => {
              setTyping(false);
              set(undefined);
            }}
          >
            Clear
          </button>
        </>
      )}
    </span>
  );
}
