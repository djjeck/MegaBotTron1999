/**
 * The graph as text (bot-os-api.md §4.12, `graphText`), read-only, for reading and for pasting
 * into an issue or a chat: a node per line with its plugin, instance, mode and account, a line per
 * value of its config and settings, then an edge per line (D61). And two printouts' line diff, as
 * the core gives it (`lineDiff`): each line kept, removed (`-`) or added (`+`).
 */
import { useState } from 'react';
import type { DiffLine } from '#src/ui/api.ts';

/** A text, read-only, with a button that copies it. */
export function TextView(props: { text: string | undefined; label: string }) {
  const [copied, setCopied] = useState<string>();
  const { text, label } = props;
  const copy = (): void => {
    if (text === undefined) return;
    navigator.clipboard.writeText(text).then(
      () => setCopied('Copied.'),
      () => setCopied('Not copied: select the text and copy it.')
    );
  };
  return (
    <div className="graph-text">
      <p className="actions">
        <button type="button" onClick={copy} disabled={text === undefined}>
          Copy
        </button>{' '}
        {copied === undefined ? null : (
          <span role="status" className="muted small">
            {copied}
          </span>
        )}
      </p>
      <pre aria-label={label} tabIndex={0}>
        {text ?? 'Loading…'}
      </pre>
    </div>
  );
}

const SIGN: Record<DiffLine['op'], string> = { ' ': ' ', '-': '−', '+': '+' };
const WORD: Record<DiffLine['op'], string> = { ' ': 'kept', '-': 'removed', '+': 'added' };

/** A line diff: every line, those removed and added marked by a sign and a colour. */
export function LineDiffView(props: { lines: DiffLine[]; label: string }) {
  if (props.lines.every((l) => l.op === ' '))
    return <p className="muted">The two print the same.</p>;
  return (
    <pre className="line-diff" aria-label={props.label} tabIndex={0}>
      {props.lines.map((l, i) => (
        <span key={i} className={`line ${WORD[l.op]}`} title={WORD[l.op]}>
          {SIGN[l.op]} {l.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
