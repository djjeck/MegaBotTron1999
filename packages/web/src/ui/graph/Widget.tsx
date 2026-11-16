/**
 * A node's widget and its page's sections, drawn (docs/bot-os.md D112): the line its card shows
 * (`WidgetLine`), and a section in full (`WidgetSection`): fields as a list of terms, a count, a
 * list, a table, an amount out of its total as a bar, or a time as how long until it. What each
 * shows is the plugin's declaration and its read's output; nothing here knows a plugin.
 */
import { useEffect, useState } from 'react';
import type { MemberView, Widget } from '#src/ui/api.ts';
import {
  at,
  countOf,
  fieldsOf,
  itemsOf,
  relative,
  sectionLabel,
  timeOf,
  totalOf,
  utc,
  widgetLine,
  words,
} from './widget-text.ts';

/** The time now, again every `everyMs` while `ticking`: a time shown as how long until it moves. */
export function useNow(ticking: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [ticking, everyMs]);
  return now;
}

/** An amount out of its total, as a bar, or nothing when either is not a number. */
function Bar(props: { value: unknown; total: number | undefined; label: string }) {
  const { value, total } = props;
  if (typeof value !== 'number' || total === undefined || total <= 0) return null;
  return (
    <progress aria-label={props.label} value={Math.min(Math.max(value, 0), total)} max={total} />
  );
}

/** The one line a node's card shows of its widget: a line, cut short, whole on hover. */
export function WidgetLine(props: {
  widget: Widget;
  reads: readonly MemberView[];
  value: unknown;
}) {
  const { widget: w, reads, value } = props;
  const now = useNow(w.show === 'until');
  const text = widgetLine(w, reads, value, now);
  return (
    <div className="widget-line small" title={text} aria-label="its widget">
      {w.show === 'progress' ? (
        <Bar
          value={at(value, w.path)}
          total={totalOf(w, value)}
          label={sectionLabel(w, reads) ?? w.read}
        />
      ) : null}
      <span>{text}</span>
    </div>
  );
}

/** A section of a node's page, in full, from its read's output. */
export function WidgetSection(props: {
  widget: Widget;
  reads: readonly MemberView[];
  value: unknown;
  /** Why its read did not answer, if it did not. */
  error?: string | undefined;
}) {
  const { widget: w, reads, value, error } = props;
  const now = useNow(w.show === 'until');
  const label = sectionLabel(w, reads);
  const title = label ?? w.read;
  return (
    <section className="widget-section" aria-label={title}>
      <h3>{title}</h3>
      {error === undefined ? (
        <SectionBody widget={w} reads={reads} output={value} now={now} label={title} />
      ) : (
        <p className="error">{error}</p>
      )}
    </section>
  );
}

function SectionBody(props: {
  widget: Widget;
  reads: readonly MemberView[];
  output: unknown;
  now: number;
  label: string;
}) {
  const { widget: w, reads, output, now } = props;
  const v = at(output, w.path);
  if (v === undefined) return <p className="muted">—</p>;
  switch (w.show) {
    case 'keyValue': {
      const fields = fieldsOf(w, reads, v, w.fields);
      if (fields.length === 0) return <p>{words(v)}</p>;
      return (
        <dl>
          {fields.map((f) => (
            <div key={f.path} className="pair">
              <dt>{f.label}</dt>
              <dd>{words(at(v, f.path))}</dd>
            </div>
          ))}
        </dl>
      );
    }
    case 'counter':
      return (
        <p className="counter">
          <strong>{words(countOf(v))}</strong>
        </p>
      );
    case 'list': {
      const items = itemsOf(v) ?? [];
      const shown = items.slice(0, w.max ?? items.length);
      if (items.length === 0) return <p className="muted">none</p>;
      return (
        <>
          <ul>
            {shown.map((item, i) => (
              <li key={i}>{words(at(item, w.item))}</li>
            ))}
          </ul>
          <More shown={shown.length} all={items.length} />
        </>
      );
    }
    case 'table': {
      const rows = itemsOf(v) ?? [];
      const shown = rows.slice(0, w.max ?? rows.length);
      const columns = fieldsOf(w, reads, v, w.columns, '0');
      if (rows.length === 0) return <p className="muted">none</p>;
      return (
        <>
          <table aria-label={props.label}>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.path} scope="col">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.path}>{words(at(row, c.path))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <More shown={shown.length} all={rows.length} />
        </>
      );
    }
    case 'progress': {
      const total = totalOf(w, output);
      return (
        <p className="progress">
          <Bar value={v} total={total} label={props.label} /> {words(v)} / {words(total)}
        </p>
      );
    }
    case 'until': {
      const t = timeOf(v);
      return t === undefined ? (
        <p>{words(v)}</p>
      ) : (
        <p>
          {relative(t, now)} <span className="muted">({utc(t)})</span>
        </p>
      );
    }
  }
}

/** How many more items there are than shown. */
function More(props: { shown: number; all: number }) {
  return props.all > props.shown ? (
    <p className="muted small">and {props.all - props.shown} more</p>
  ) : null;
}
