/**
 * A node's widget and its page's sections, drawn (docs/bot-os.md D112): the line its card shows
 * (`WidgetLine`), and a section in full (`WidgetSection`): fields as a list of terms, a count, a
 * list, a table, an amount out of its total as a bar, or a time as how long until it. What each
 * shows is the plugin's declaration and its read's output; nothing here knows a plugin. On a page,
 * a table's picture columns show thumbnails (a carousel's, one at a time, D163), and its row
 * actions a button per row (D157, `TableRow.tsx`).
 */
import { useEffect, useRef, useState } from 'react';
import type { MemberView, Widget } from '#src/ui/api.ts';
import type { CarouselAt } from './TableRow.tsx';
import { CarouselCell, PictureCell, pictureSrc, RowActionButton } from './TableRow.tsx';
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
  /** Its node, whose files a picture is and whose actions a row runs (D157); none: text alone. */
  node?: string | undefined;
  /** Its node's actions, as the graph view describes them, for a row action's form. */
  actions?: readonly MemberView[] | undefined;
  /** Asks the page's reads again, after a row's action ran. */
  reload?: (() => void) | undefined;
  /** A view's selected value, for a row action's input that names it (D170). */
  selector?: string | undefined;
}) {
  const { widget: w, reads, value, error } = props;
  const now = useNow(w.show === 'until');
  const label = sectionLabel(w, reads);
  const title = label ?? w.read;
  return (
    <section className="widget-section" aria-label={title}>
      <h3>{title}</h3>
      {error === undefined ? (
        <SectionBody
          widget={w}
          reads={reads}
          output={value}
          now={now}
          label={title}
          node={props.node}
          actions={props.actions ?? []}
          reload={props.reload}
          selector={props.selector}
        />
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
  node: string | undefined;
  actions: readonly MemberView[];
  reload: (() => void) | undefined;
  selector: string | undefined;
}) {
  const { widget: w, reads, output, now, node } = props;
  // The picture each carousel shows, by its column and row, kept as the page reads again (D163).
  const carousels = useRef(new Map<string, CarouselAt>()).current;
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
      const keys = rowKeys(shown);
      const columns = fieldsOf(w, reads, v, w.columns, '0').map((c, i) => {
        const spec = w.columns[i];
        return typeof spec === 'object' && 'show' in spec
          ? { ...c, from: spec.from, carousel: spec.show === 'carousel' }
          : c;
      });
      // Row actions need the node to run on: none outside a page.
      const rowActions = node === undefined ? [] : (w.actions ?? []);
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
                {rowActions.length === 0 ? null : (
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => {
                // The row's name: its first column's text, for its buttons and pictures.
                const first = columns[0];
                const name = first === undefined ? `row ${i + 1}` : words(at(row, first.path));
                return (
                  <tr key={keys[i]}>
                    {columns.map((c) => (
                      <td key={c.path}>
                        {'from' in c && c.from !== undefined ? (
                          node === undefined ? null : c.carousel ? (
                            <CarouselCell
                              srcs={pictures(node, c.from, at(row, c.path))}
                              alt={`${c.label} of ${name}`}
                              memory={carousels}
                              memoryKey={`${c.path}\n${name}`}
                            />
                          ) : (
                            <PictureCell
                              src={pictureSrc(node, c.from, at(row, c.path))}
                              alt={`${c.label} of ${name}`}
                            />
                          )
                        ) : (
                          words(at(row, c.path))
                        )}
                      </td>
                    ))}
                    {rowActions.length === 0 || node === undefined ? null : (
                      <td className="row-actions">
                        {rowActions.map((a) => (
                          <RowActionButton
                            key={a.label}
                            node={node}
                            action={a}
                            row={row}
                            rowName={name}
                            members={props.actions}
                            done={props.reload}
                            selector={props.selector}
                          />
                        ))}
                      </td>
                    )}
                  </tr>
                );
              })}
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

/** The addresses of a carousel's pictures (D163): those of its list that are one. */
function pictures(node: string, from: 'files' | 'media', value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((p: unknown) => pictureSrc(node, from, p) ?? []);
}

/** How many more items there are than shown. */
/**
 * Each row's key, by what it holds (a repeat counted apart): a row keyed by its place would hand its
 * buttons' state, an action's answer among it, to the row that takes its place when it goes.
 */
export function rowKeys(rows: readonly unknown[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const text = JSON.stringify(row) ?? String(row);
    const n = seen.get(text) ?? 0;
    seen.set(text, n + 1);
    return `${String(n)}:${text}`;
  });
}

function More(props: { shown: number; all: number }) {
  return props.all > props.shown ? (
    <p className="muted small">and {props.all - props.shown} more</p>
  ) : null;
}
