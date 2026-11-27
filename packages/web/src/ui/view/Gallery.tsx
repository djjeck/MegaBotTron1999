/**
 * A gallery (docs/bot-os.md D170): a list's items as cards, each its picture (or its pictures, one
 * at a time), its caption, its badges and its actions; searched and paged when it says so; and,
 * with a `detail`, a card opens its drawer, which the page keeps in its address (`?row=`).
 */
import { useRef } from 'react';
import type { MemberView, ViewLeaf } from '#src/ui/api.ts';
import type { CarouselAt } from '#src/ui/graph/TableRow.tsx';
import { CarouselCell, PictureCell, pictureSrc, RowActionButton } from '#src/ui/graph/TableRow.tsx';
import { at, words } from '#src/ui/graph/widget-text.ts';
import type { Col } from './cells.tsx';
import { Cell, pictures } from './cells.tsx';
import type { Opening } from './DataTable.tsx';
import { Drawer, RowDetail } from './Drawer.tsx';
import { keyOf, Pager, rowKeys, SearchBox, useList } from './list.tsx';

type GalleryLeaf = ViewLeaf & { show: 'gallery' };

export function Gallery(props: {
  label: string;
  leaf: GalleryLeaf;
  rows: readonly unknown[];
  /** Its badges, as columns are drawn. */
  badges: readonly Col[];
  detailCols: readonly Col[];
  empty: string;
  node: string;
  members: readonly MemberView[];
  reload?: (() => void) | undefined;
  selector?: string | undefined;
  opening: Opening;
}) {
  const { leaf, node } = props;
  const captionCol: Col[] =
    leaf.caption === undefined
      ? []
      : [{ path: leaf.caption, label: 'caption', format: 'text', source: 'files' }];
  const list = useList(props.rows, leaf, [...captionCol, ...props.badges]);
  const carousels = useRef(new Map<string, CarouselAt>()).current;
  const source = leaf.image.source ?? 'files';
  const nameOf = (row: unknown, i: number): string =>
    leaf.caption === undefined ? `item ${i + 1}` : words(at(row, leaf.caption));
  const detail = leaf.detail;
  const keys = rowKeys(list.shown);
  const opened =
    detail === undefined || props.opening.open === undefined
      ? undefined
      : props.rows.find((r) => keyOf(r, leaf.key) === props.opening.open);
  const titleOf = (row: unknown): string =>
    detail?.title === undefined ? nameOf(row, 0) : words(at(row, detail.title));
  return (
    <>
      {leaf.search === undefined ? null : (
        <SearchBox label={props.label} value={list.query} set={list.search} />
      )}
      {props.rows.length === 0 ? (
        <p className="empty">{props.empty}</p>
      ) : list.matching === 0 ? (
        <p className="empty">Nothing matches.</p>
      ) : (
        <ul className="gallery" aria-label={props.label}>
          {list.shown.map((row, i) => {
            const name = nameOf(row, i);
            const key = keyOf(row, leaf.key);
            return (
              <li
                key={leaf.key === undefined ? keys[i] : `k:${key}`}
                className="gallery-item"
                aria-label={name}
              >
                <div className="gallery-picture">
                  {leaf.image.carousel === true ? (
                    <CarouselCell
                      srcs={pictures(node, source, at(row, leaf.image.path))}
                      alt={`Pictures of ${name}`}
                      memory={carousels}
                      memoryKey={`${key}`}
                    />
                  ) : (
                    <PictureCell
                      src={pictureSrc(node, source, at(row, leaf.image.path))}
                      alt={`Picture of ${name}`}
                    />
                  )}
                </div>
                <div className="gallery-body">
                  {leaf.caption === undefined ? null : <strong className="caption">{name}</strong>}
                  {props.badges.length === 0 ? null : (
                    <span className="gallery-badges">
                      {props.badges.map((b) => (
                        <Cell key={b.path} col={b} row={row} node={node} name={name} />
                      ))}
                    </span>
                  )}
                  <span className="gallery-actions">
                    {(leaf.actions ?? []).map((a) => (
                      <RowActionButton
                        key={a.label}
                        node={node}
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
                        onClick={() => props.opening.setOpen(key)}
                      >
                        Open ›
                      </button>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Pager
        page={list.page}
        pages={list.pages}
        size={list.size}
        matching={list.matching}
        set={list.setPage}
      />
      {opened === undefined || detail === undefined ? null : (
        <Drawer title={titleOf(opened)} close={() => props.opening.setOpen(undefined)}>
          <RowDetail
            detail={detail}
            cols={props.detailCols}
            row={opened}
            name={titleOf(opened)}
            node={node}
            members={props.members}
            reload={props.reload}
            selector={props.selector}
          >
            {props.opening.more?.(opened)}
          </RowDetail>
        </Drawer>
      )}
    </>
  );
}
