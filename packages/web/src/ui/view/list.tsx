/**
 * What a table and a gallery share (docs/bot-os.md D170): their rows searched (`search`: every text
 * shown, or the paths named), sorted (`sort`, by a column's header; `defaultSort` first), and paged
 * (`pageSize`), a phase-1 `max` cutting them first; and the drawer a row opens (`detail`), its rows
 * told apart by `key` (`id` by default), as the page's address names it (`?row=`).
 */
import { useState } from 'react';
import type { Format } from '#src/ui/api.ts';
import { at, words } from '#src/ui/graph/widget-text.ts';
import type { Col } from './cells.tsx';
import { formatted, sortKey } from './cells.tsx';

/** How a list is searched, sorted and paged, as its section says. */
export interface ListSpec {
  search?: true | string[] | undefined;
  sort?: true | undefined;
  defaultSort?: { path: string; direction: 'asc' | 'desc' } | undefined;
  pageSize?: number | undefined;
  max?: number | undefined;
  key?: string | undefined;
}

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

/** A row's key, as the address names it: its `key` path's text (`id` by default). */
export const keyOf = (row: unknown, key: string | undefined): string => words(at(row, key ?? 'id'));

/** The rows a list shows now, and the means to search, sort and page them. */
export function useList(rows: readonly unknown[], spec: ListSpec, cols: readonly Col[]) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(spec.defaultSort);
  const [page, setPage] = useState(0);
  const capped = rows.slice(0, spec.max ?? rows.length);
  const formats = new Map<string, Format>(cols.map((c) => [c.path, c.format]));
  const searched = (() => {
    const q = query.trim().toLowerCase();
    if (spec.search === undefined || q === '') return capped;
    const paths = spec.search === true ? cols.map((c) => c.path) : spec.search;
    return capped.filter((row) =>
      paths.some((p) =>
        formatted(at(row, p), formats.get(p) ?? 'text')
          .toLowerCase()
          .includes(q)
      )
    );
  })();
  const sorted =
    sort === undefined
      ? searched
      : [...searched].sort((a, b) => {
          const f = formats.get(sort.path) ?? 'text';
          const x = sortKey(at(a, sort.path), f);
          const y = sortKey(at(b, sort.path), f);
          const by =
            typeof x === 'number' && typeof y === 'number'
              ? x - y
              : String(x).localeCompare(String(y));
          return sort.direction === 'desc' ? -by : by;
        });
  const size = spec.pageSize ?? sorted.length;
  const pages = Math.max(1, Math.ceil(sorted.length / Math.max(size, 1)));
  const current = Math.min(page, pages - 1);
  const shown = sorted.slice(current * size, current * size + size);
  return {
    query,
    search: (q: string) => {
      setQuery(q);
      setPage(0);
    },
    sort,
    sortBy: (path: string) => {
      setPage(0);
      setSort((s) =>
        s?.path === path
          ? { path, direction: s.direction === 'asc' ? 'desc' : 'asc' }
          : { path, direction: 'asc' }
      );
    },
    shown,
    matching: sorted.length,
    page: current,
    pages,
    setPage,
    size,
  };
}

/** A list's search box, when it has one. */
export function SearchBox(props: { label: string; value: string; set: (q: string) => void }) {
  return (
    <input
      className="list-search"
      type="search"
      aria-label={`search ${props.label}`}
      placeholder="Search…"
      value={props.value}
      onChange={(e) => props.set(e.target.value)}
    />
  );
}

/** A list's pages: where it is, and the way to the previous and the next. */
export function Pager(props: {
  page: number;
  pages: number;
  size: number;
  matching: number;
  set: (page: number) => void;
}) {
  if (props.pages <= 1) return null;
  const from = props.page * props.size + 1;
  const to = Math.min(props.matching, from + props.size - 1);
  return (
    <nav className="pager" aria-label="pages">
      <button type="button" disabled={props.page === 0} onClick={() => props.set(props.page - 1)}>
        ← Previous
      </button>
      <span className="muted small">
        {from}–{to} of {props.matching}
      </span>
      <button
        type="button"
        disabled={props.page >= props.pages - 1}
        onClick={() => props.set(props.page + 1)}
      >
        Next →
      </button>
    </nav>
  );
}
