/**
 * A table (docs/bot-os.md D157, D170): rows of a list, a column each, formatted; searched, sorted by
 * its headers and paged when it says so; a button per row for each of its actions; and, with a
 * `detail`, a row opens its drawer, by a click or its button, which the page may keep in its
 * address (`open`, `setOpen`). It scrolls sideways within its card rather than past the page.
 */
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import type { Detail, MemberView, RowAction } from '#src/ui/api.ts';
import type { CarouselAt } from '#src/ui/graph/TableRow.tsx';
import { RowActionButton } from '#src/ui/graph/TableRow.tsx';
import type { Col } from './cells.tsx';
import { Cell } from './cells.tsx';
import { Drawer, nameOf, RowDetail } from './Drawer.tsx';
import type { ListSpec } from './list.tsx';
import { keyOf, Pager, rowKeys, SearchBox, useList } from './list.tsx';

/** What a table or a gallery that opens a drawer is given of it: the row open, and the way to change it. */
export interface Opening {
  open: string | undefined;
  setOpen: (key: string | undefined) => void;
  /** What the view adds to a row's drawer: sections read with its values. */
  more?: ((row: unknown) => ReactNode) | undefined;
}

export function DataTable(props: {
  label: string;
  spec: ListSpec & { actions?: RowAction[] | undefined; detail?: Detail | undefined };
  rows: readonly unknown[];
  cols: readonly Col[];
  detailCols: readonly Col[];
  empty: string;
  node: string | undefined;
  members: readonly MemberView[];
  reload?: (() => void) | undefined;
  selector?: string | undefined;
  opening?: Opening | undefined;
}) {
  const { spec, cols, node } = props;
  const list = useList(props.rows, spec, cols);
  const carousels = useRef(new Map<string, CarouselAt>()).current;
  const [own, setOwn] = useState<string>();
  const open = props.opening?.open ?? own;
  const setOpen = props.opening?.setOpen ?? setOwn;
  const detail = spec.detail;
  // Row actions need the node to run on: none outside a page.
  const actions = node === undefined ? [] : (spec.actions ?? []);
  // Each row kept apart by its key, else by what it holds, so that its buttons' state stays its own.
  const keys = rowKeys(list.shown);
  const opened =
    detail === undefined || open === undefined
      ? undefined
      : props.rows.find((r) => keyOf(r, spec.key) === open);
  return (
    <>
      {spec.search === undefined ? null : (
        <SearchBox label={props.label} value={list.query} set={list.search} />
      )}
      {props.rows.length === 0 ? (
        <p className="empty">{props.empty}</p>
      ) : list.matching === 0 ? (
        <p className="empty">Nothing matches.</p>
      ) : (
        <div className="table-scroll">
          <table aria-label={props.label}>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th
                    key={c.path}
                    scope="col"
                    className={c.format === 'number' || c.format === 'percent' ? 'num' : undefined}
                    aria-sort={
                      list.sort?.path === c.path
                        ? list.sort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                  >
                    {spec.sort === true ? (
                      <button type="button" className="sort" onClick={() => list.sortBy(c.path)}>
                        {c.label}
                        <span aria-hidden="true">
                          {list.sort?.path === c.path
                            ? list.sort.direction === 'asc'
                              ? ' ▲'
                              : ' ▼'
                            : ''}
                        </span>
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
                {actions.length === 0 && detail === undefined ? null : (
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {list.shown.map((row, i) => {
                const name = nameOf(row, detail?.title, cols, i);
                const key = keyOf(row, spec.key);
                return (
                  <tr
                    key={spec.key === undefined ? keys[i] : `k:${key}`}
                    className={detail === undefined ? undefined : 'opens'}
                    aria-selected={detail === undefined ? undefined : key === open}
                    onClick={detail === undefined ? undefined : () => setOpen(key)}
                  >
                    {cols.map((c) => (
                      <td
                        key={c.path}
                        className={
                          c.format === 'number' || c.format === 'percent' ? 'num' : undefined
                        }
                      >
                        <Cell col={c} row={row} node={node} name={name} carousels={carousels} />
                      </td>
                    ))}
                    {actions.length === 0 && detail === undefined ? null : (
                      <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                        {actions.map((a) => (
                          <RowActionButton
                            key={a.label}
                            node={node as string}
                            action={a}
                            row={row}
                            rowName={name}
                            members={props.members}
                            done={props.reload}
                            selector={props.selector}
                          />
                        ))}
                        {detail === undefined ? null : (
                          <button
                            type="button"
                            className="link"
                            aria-label={`open ${name}`}
                            onClick={() => setOpen(key)}
                          >
                            Open ›
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        page={list.page}
        pages={list.pages}
        size={list.size}
        matching={list.matching}
        set={list.setPage}
      />
      {opened === undefined || detail === undefined ? null : (
        <Drawer title={nameOf(opened, detail.title, cols, 0)} close={() => setOpen(undefined)}>
          <RowDetail
            detail={detail}
            cols={props.detailCols}
            row={opened}
            name={nameOf(opened, detail.title, cols, 0)}
            node={node}
            members={props.members}
            reload={props.reload}
            selector={props.selector}
          >
            {props.opening?.more?.(opened)}
          </RowDetail>
        </Drawer>
      )}
    </>
  );
}
