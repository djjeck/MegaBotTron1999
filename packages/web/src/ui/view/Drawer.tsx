/**
 * A row's drawer (docs/bot-os.md D170): a panel at the side of the page (the whole screen on a
 * phone) with the row's fields, its actions, and, in a view, sections read with its values. It
 * closes with its button, a click beside it, or Escape.
 */
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import type { Detail, MemberView } from '#src/ui/api.ts';
import { RowActionButton } from '#src/ui/graph/TableRow.tsx';
import { at, words } from '#src/ui/graph/widget-text.ts';
import type { Col } from './cells.tsx';
import { Cell } from './cells.tsx';

export function Drawer(props: { title: string; close: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [props.close]);
  return (
    <div className="drawer-backdrop" onClick={props.close}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3>{props.title}</h3>
          <button type="button" className="link" aria-label="close" onClick={props.close}>
            ✕
          </button>
        </header>
        <div className="drawer-body">{props.children}</div>
      </aside>
    </div>
  );
}

/** A row's drawer's content: its fields, its actions, then whatever the view adds. */
export function RowDetail(props: {
  detail: Pick<Detail, 'fields' | 'actions'>;
  cols: readonly Col[];
  row: unknown;
  name: string;
  node: string | undefined;
  members: readonly MemberView[];
  reload?: (() => void) | undefined;
  selector?: string | undefined;
  children?: ReactNode;
}) {
  const { row, node } = props;
  return (
    <>
      {props.cols.length === 0 ? null : (
        <dl className="detail-fields">
          {props.cols.map((c) => (
            <div key={c.path} className="pair">
              <dt>{c.label}</dt>
              <dd>
                <Cell col={c} row={row} node={node} name={props.name} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {node === undefined || (props.detail.actions ?? []).length === 0 ? null : (
        <div className="detail-actions">
          {(props.detail.actions ?? []).map((a) => (
            <RowActionButton
              key={a.label}
              node={node}
              action={a}
              row={row}
              rowName={props.name}
              members={props.members}
              done={props.reload}
              selector={props.selector}
            />
          ))}
        </div>
      )}
      {props.children}
    </>
  );
}

/** A row's name: its title path's text, else its first column's, for its labels. */
export const nameOf = (
  row: unknown,
  title: string | undefined,
  cols: readonly Col[],
  i: number
): string => {
  const p = title ?? cols[0]?.path;
  return p === undefined ? `row ${i + 1}` : words(at(row, p));
};
