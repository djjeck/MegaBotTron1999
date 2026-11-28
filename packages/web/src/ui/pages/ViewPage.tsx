/**
 * A view's page (docs/bot-os.md D170), at `/v/<path>/`: the view node whose path (its own, else
 * its id) is that, as the running graph's view describes it (`GET /graph/view`, its `served`).
 *
 * - **Its layout:** its sections in order: tabs (one shown at a time), grids, cards, and leaves,
 *   each a card of its own, drawn from the read it names of the node bound to its input (`from`),
 *   whose pictures and actions are that node's.
 * - **Its address** keeps what is chosen, so that a link opens the same: the selector's value
 *   (`?s=`), the tab (`?tab=`, its title's slug) and the row whose drawer is open (`?row=`, its key).
 * - **Each leaf's state:** loading, empty (its `empty`), or its read's error, naming its input and
 *   its read: a read that fails breaks its own card, not the page. An input left unbound says so.
 * - **Its reads** are those the page shows now (the open tab's, its tabs' counts, the open drawer's,
 *   a form's preset; a tab not on screen asks nothing but its count), each asked once however many
 *   leaves show it, at once as it comes on screen (a tab switched to, a drawer opened, an older
 *   answer kept or not), again every five seconds while the page is open and visible (D172: none while its tab is hidden, at once when it shows again),
 *   never again while its last ask is unanswered, and those of a node at once after an action ran
 *   on it (once its unanswered ask is answered, if one is). Each is keyed by its
 *   node, its read and its input, so that pushed changes may later ask only theirs.
 */
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GraphViewData,
  NodeView,
  ViewCount,
  ViewLeaf,
  ViewSection,
  ViewSelector,
  Widget,
} from '#src/ui/api.ts';
import { api, ApiError, seg } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { query } from '#src/ui/graph/NodeControls.tsx';
import { SELECTOR_REF } from '#src/ui/graph/TableRow.tsx';
import { emptyOf, SectionBody, useNow } from '#src/ui/graph/Widget.tsx';
import { at, countOf, itemsOf, sectionLabel, words } from '#src/ui/graph/widget-text.ts';
import { poll, useLoad } from '#src/ui/hooks.ts';
import { colsOf } from '#src/ui/view/cells.tsx';
import type { Opening } from '#src/ui/view/DataTable.tsx';
import { Gallery } from '#src/ui/view/Gallery.tsx';
import { ActionForm, SettingsForm, StatTile } from '#src/ui/view/Leaves.tsx';
import { keyOf } from '#src/ui/view/list.tsx';
import { PAGE_EVERY_MS } from './NodePage.tsx';

/** A read a view asks: of a node, by name, with its input. */
interface Ask {
  node: string;
  read: string;
  input: Record<string, unknown>;
}

const keyOfAsk = (a: Ask): string => `${a.node}\n${a.read}${query(a.input)}`;

/** Each read's answer, or why not, by its key. */
type Answers = Record<string, { value: unknown } | { error: string }>;

/** A row's value of `'$row.<path>'`, `'$row'` the row itself. */
const ROW = /^\$row(?:\.(.+))?$/u;

/**
 * An input with the selected value in place of `'$selector'` and a row's in place of
 * `'$row.<path>'`; undefined while it needs a choice and none is made.
 */
export function withSelected(
  input: Readonly<Record<string, unknown>> | undefined,
  selected: string | undefined,
  row?: unknown
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const fromRow = typeof v === 'string' ? ROW.exec(v) : null;
    if (v === SELECTOR_REF) {
      if (selected === undefined) return undefined;
      out[k] = selected;
    } else if (fromRow !== null && row !== undefined) out[k] = at(row, fromRow[1]);
    else out[k] = v;
  }
  return out;
}

/** The options of a selector, from its read's answer: each its value and its label, as text. */
export function optionsOf(sel: ViewSelector, answer: unknown): { value: string; label: string }[] {
  const list = at(answer, sel.path);
  const items = Array.isArray(list)
    ? (list as unknown[])
    : typeof list === 'object' && list !== null
      ? Object.values(list)
      : [];
  return items.map((item) => {
    const value = words(at(item, sel.value));
    return { value, label: sel.label === undefined ? value : words(at(item, sel.label)) };
  });
}

/** A tab's slug, as the core makes it (`tabSlug`): its title's, for the address. */
export const tabSlug = (title: string): string =>
  title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'tab';

/** What the page's address keeps: the selector's value, the tab, the row open. */
interface Address {
  s?: string | undefined;
  tab?: string | undefined;
  row?: string | undefined;
}

const addressOf = (search: string): Address => {
  const p = new URLSearchParams(search);
  return {
    s: p.get('s') ?? undefined,
    tab: p.get('tab') ?? undefined,
    row: p.get('row') ?? undefined,
  };
};

/** The tab a tabs section shows: the address's, if one of its own, else its first. */
const openTab = (s: ViewSection & { show: 'tabs' }, tab: string | undefined): number => {
  const i = s.tabs.findIndex((t) => tabSlug(t.title) === tab);
  return i < 0 ? 0 : i;
};

/** What every leaf of the page is drawn with. */
interface Context {
  bound: Readonly<Record<string, string>>;
  byId: ReadonlyMap<string, NodeView>;
  answers: Answers;
  address: Address;
  set: (a: Partial<Address>) => void;
  refresh: (node: string) => void;
  loggedOut: () => void;
  now: number;
}

/** The value of a read the page asked, or why not: undefined while it is asked. */
function answerOf(
  c: Pick<Context, 'bound' | 'answers'>,
  from: string,
  read: string,
  input: Record<string, unknown> | undefined
): { value: unknown } | { error: string } | undefined {
  const node = c.bound[from];
  if (node === undefined || input === undefined) return undefined;
  return c.answers[keyOfAsk({ node, read, input })];
}

/** The rows of a leaf's value, as its read answered: none while it is asked or failed. */
function rowsOf(c: Context, leaf: ViewLeaf, row?: unknown): unknown[] {
  if (!('read' in leaf)) return [];
  const a = answerOf(c, leaf.from, leaf.read, withSelected(leaf.input, c.address.s, row));
  return a === undefined || 'error' in a ? [] : (itemsOf(at(a.value, leaf.path)) ?? []);
}

/** The reads the page shows now: the open tabs', the counts, the selector, the drawer, the forms'. */
export function asksOf(
  sections: readonly ViewSection[],
  c: Pick<Context, 'bound' | 'answers' | 'address'>,
  selector: ViewSelector | undefined
): Ask[] {
  const out = new Map<string, Ask>();
  const add = (from: string, read: string, input: Record<string, unknown> | undefined): void => {
    const node = c.bound[from];
    if (node === undefined || input === undefined) return;
    const a = { node, read, input };
    out.set(keyOfAsk(a), a);
  };
  if (selector !== undefined) add(selector.from, selector.read, selector.input ?? {});
  const leaf = (l: ViewLeaf, row?: unknown): void => {
    if (l.show === 'form') {
      if (l.current !== undefined)
        add(l.from, l.current.read, withSelected(l.current.input, c.address.s, row));
      return;
    }
    add(l.from, l.read, withSelected(l.input, c.address.s, row));
    // The row whose drawer is open: its sections read with its values.
    if (row !== undefined || !('detail' in l) || l.detail?.sections === undefined) return;
    if (c.address.row === undefined) return;
    const rows = rowsOf(c as Context, l);
    const opened = rows.find((r) => keyOf(r, l.key) === c.address.row);
    if (opened !== undefined) for (const d of l.detail.sections) leaf(d as ViewLeaf, opened);
  };
  const walk = (list: readonly ViewSection[]): void => {
    for (const s of list) {
      if (s.show === 'tabs') {
        for (const t of s.tabs)
          if (t.count !== undefined) add(t.count.from, t.count.read, t.count.input ?? {});
        walk(s.tabs[openTab(s, c.address.tab)]?.sections ?? []);
      } else if (s.show === 'grid' || s.show === 'card') walk(s.sections);
      else leaf(s);
    }
  };
  walk(sections);
  return [...out.values()];
}

export function ViewPage(props: PageProps) {
  const path = props.section ?? '';
  const view = useLoad(() => api<GraphViewData | null>('/graph/view'), props.loggedOut, 600_000);
  const nodes = view.data?.nodes ?? [];
  const node = nodes.find((n) => n.served?.path === path);
  const page = node?.view;
  const bound = node?.served?.bound ?? {};
  const [address, setAddress] = useState<Address>(() => addressOf(window.location.search));
  const [answers, setAnswers] = useState<Answers>({});
  const now = useNow(true, 30_000);

  const set = useCallback((change: Partial<Address>) => {
    setAddress((was) => {
      const next = { ...was, ...change };
      const url = new URL(window.location.href);
      for (const k of ['s', 'tab', 'row'] as const) {
        const v = next[k];
        if (v === undefined) url.searchParams.delete(k);
        else url.searchParams.set(k, v);
      }
      window.history.replaceState(null, '', url);
      return next;
    });
  }, []);

  const asks = useMemo(
    () => asksOf(page?.sections ?? [], { bound, answers, address }, page?.selector),
    [page, bound, answers, address]
  );
  const keys = asks.map(keyOfAsk).join('\u0000');
  const current = useRef(asks);
  current.current = asks;

  // The reads unanswered, by key, each with whether it is to be asked again once answered (D172).
  const inFlight = useRef(new Map<string, { again: boolean; ask: Ask }>());
  const ask = useCallback(
    (list: readonly Ask[], fresh = false): Promise<void> => {
      const flying = inFlight.current;
      const sent = list.filter((a) => {
        const f = flying.get(keyOfAsk(a));
        if (f !== undefined && fresh) f.again = true;
        return f === undefined;
      });
      for (const a of sent) flying.set(keyOfAsk(a), { again: false, ask: a });
      return Promise.all(
        sent.map((a) =>
          api<unknown>(`/plugins/${seg(a.node)}/state/${seg(a.read)}${query(a.input)}`).then(
            (value) => [keyOfAsk(a), { value }] as const,
            (e: unknown) => {
              if (e instanceof ApiError && e.status === 401) props.loggedOut();
              return [keyOfAsk(a), { error: e instanceof Error ? e.message : String(e) }] as const;
            }
          )
        )
      ).then((all) => {
        if (all.length > 0) setAnswers((was) => ({ ...was, ...Object.fromEntries(all) }));
        const again = all.flatMap(([key]) => {
          const f = flying.get(key);
          flying.delete(key);
          return f?.again === true ? [f.ask] : [];
        });
        if (again.length > 0) void ask(again);
      });
    },
    [props.loggedOut]
  );
  // What is shown now, asked at once when it changes, and again every five seconds while visible.
  // A read that comes on screen (a tab switched to, a drawer opened) is asked at once, even with an
  // older answer kept; the poll asks only those on screen.
  const shownBefore = useRef(new Set<string>());
  useEffect(() => {
    const before = shownBefore.current;
    const fresh = asks.filter((a) => !before.has(keyOfAsk(a)));
    shownBefore.current = new Set(asks.map(keyOfAsk));
    if (fresh.length > 0) void ask(fresh);
  }, [keys]);
  const started = useRef(false);
  useEffect(() => {
    // Its first run is the one above, of what is shown; the poll's own asks come after.
    started.current = false;
    const p = poll(() => {
      if (!started.current) {
        started.current = true;
        return Promise.resolve();
      }
      return ask(current.current);
    }, PAGE_EVERY_MS);
    return () => p.stop();
  }, [ask]);
  // After an action ran on a node: the reads of that node asked again at once.
  const refresh = useCallback(
    (of: string) => {
      void ask(
        current.current.filter((a) => a.node === of),
        true
      );
    },
    [ask]
  );

  const home = <a href="../../#/graph">← Graph</a>;
  if (view.data === undefined)
    return (
      <>
        {home}
        <p className={view.error === undefined ? 'muted' : 'error'}>{view.error ?? 'Loading…'}</p>
      </>
    );
  if (node === undefined || page === undefined)
    return (
      <>
        {home}
        <p className="muted">No view is at /v/{path}/: add a view node, then Apply.</p>
      </>
    );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const shown = [...new Set(Object.values(bound))];
  const c: Context = {
    bound,
    byId,
    answers,
    address,
    set,
    refresh,
    loggedOut: props.loggedOut,
    now,
  };
  return (
    <div className="view-page">
      {home}
      <h2>
        {page.title} <span className="muted small">{node.id}</span>
      </h2>
      <p className="muted small" aria-label="its nodes">
        {shown.length === 0 ? (
          <>Nothing is wired to it yet: draw an edge from a node to each of its inputs.</>
        ) : (
          <>
            Shows{' '}
            {shown.map((id, i) => (
              <span key={id}>
                {i === 0 ? '' : ', '}
                <a href={`../../#/graph/${encodeURIComponent(id)}`}>{id}</a>
              </span>
            ))}
            .
          </>
        )}
      </p>
      {page.selector === undefined ? null : (
        <Selector
          selector={page.selector}
          node={bound[page.selector.from]}
          answer={answerOf(c, page.selector.from, page.selector.read, page.selector.input ?? {})}
          selected={address.s}
          choose={(s) => set({ s, row: undefined })}
        />
      )}
      {page.sections.length === 0 ? (
        <p className="muted">No section yet: add its sections in its node’s config.</p>
      ) : (
        <Sections sections={page.sections} c={c} />
      )}
    </div>
  );
}

/** A list of sections: each a layout or a leaf, in order; in a titled card, `titled`. */
function Sections(props: {
  sections: readonly ViewSection[];
  c: Context;
  titled?: boolean;
}): ReactNode {
  return props.sections.map((s, i) => (
    <Section key={i} section={s} c={props.c} titled={props.titled === true} />
  ));
}

function Section(props: { section: ViewSection; c: Context; titled: boolean }): ReactNode {
  const { section: s, c } = props;
  switch (s.show) {
    case 'tabs':
      return <Tabs section={s} c={c} />;
    case 'grid':
      return (
        <div className="view-grid" style={{ ['--columns' as string]: String(s.columns ?? 3) }}>
          <Sections sections={s.sections} c={c} />
        </div>
      );
    case 'card':
      return (
        <section className="card view-card" aria-label={s.title}>
          {s.title === undefined ? null : <h3>{s.title}</h3>}
          <Sections sections={s.sections} c={c} titled={s.title !== undefined} />
        </section>
      );
    default:
      return <Leaf leaf={s} c={c} titled={props.titled} />;
  }
}

/** A tabs section: its tabs' titles (and counts), and the open one's sections. */
function Tabs(props: { section: ViewSection & { show: 'tabs' }; c: Context }) {
  const { section: s, c } = props;
  const open = openTab(s, c.address.tab);
  const count = (n: ViewCount | undefined): string | undefined => {
    if (n === undefined) return undefined;
    const a = answerOf(c, n.from, n.read, n.input ?? {});
    return a === undefined || 'error' in a ? undefined : words(countOf(at(a.value, n.path)));
  };
  return (
    <div className="view-tabs">
      <div role="tablist" className="tablist">
        {s.tabs.map((t, i) => {
          const n = count(t.count);
          return (
            <button
              key={t.title}
              type="button"
              role="tab"
              aria-selected={i === open}
              className={i === open ? 'tab open' : 'tab'}
              onClick={() => c.set({ tab: tabSlug(t.title), row: undefined })}
            >
              {t.title}
              {n === undefined ? null : <span className="tab-count">{n}</span>}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={s.tabs[open]?.title}>
        <Sections sections={s.tabs[open]?.sections ?? []} c={c} />
      </div>
    </div>
  );
}

/**
 * A leaf as a card: its label, then its value, or its state (loading, empty, failed, unwired). In a
 * titled card, one with no label of its own has no heading: the card's title names it.
 */
function Leaf(props: { leaf: ViewLeaf; c: Context; row?: unknown; titled?: boolean }) {
  const { leaf, c, row } = props;
  const node =
    c.bound[leaf.from] === undefined ? undefined : c.byId.get(c.bound[leaf.from] as string);
  const reads = node?.interface.reads ?? [];
  const label =
    leaf.label ??
    (leaf.show === 'form'
      ? (leaf.action ?? 'Settings')
      : (sectionLabel(leaf as Widget, reads) ?? leaf.read));
  const card = (body: ReactNode, cls = '') => (
    <section className={`card leaf leaf-${leaf.show}${cls}`} aria-label={label}>
      {leaf.show === 'stat' || (props.titled === true && leaf.label === undefined) ? null : (
        <h3>{label}</h3>
      )}
      {body}
    </section>
  );
  if (node === undefined)
    return card(<p className="muted">Its input {leaf.from} is not wired: draw an edge to it.</p>);
  if (leaf.show === 'form') {
    if (leaf.settings !== undefined)
      return card(
        <SettingsForm
          leaf={leaf}
          label={label}
          node={node.id}
          schema={node.settingsSchema}
          loggedOut={c.loggedOut}
        />
      );
    const input = withSelected(leaf.input, c.address.s, row);
    if (input === undefined) return card(<p className="muted">Pick one above.</p>);
    const current =
      leaf.current === undefined
        ? undefined
        : answerOf(
            c,
            leaf.from,
            leaf.current.read,
            withSelected(leaf.current.input, c.address.s, row)
          );
    return card(
      <ActionForm
        leaf={leaf}
        label={label}
        node={node.id}
        members={node.interface.actions}
        input={input}
        current={
          current !== undefined && 'value' in current
            ? at(current.value, leaf.current?.path)
            : undefined
        }
        done={() => c.refresh(node.id)}
      />
    );
  }
  const input = withSelected(leaf.input, c.address.s, row);
  if (input === undefined) return card(<p className="muted">Pick one above.</p>);
  const answer = answerOf(c, leaf.from, leaf.read, input);
  if (answer === undefined) return card(<p className="muted loading">Loading…</p>, ' loading');
  if ('error' in answer)
    return card(
      <p className="error" role="alert">
        {leaf.from}.{leaf.read} did not answer: {answer.error}
      </p>,
      ' failed'
    );
  const reload = () => c.refresh(node.id);
  // The drawer a table or a gallery opens (?row=), and the sections it adds, read with its row.
  const opening: Opening | undefined =
    row !== undefined || !('detail' in leaf) || leaf.detail === undefined
      ? undefined
      : {
          open: c.address.row,
          setOpen: (key) => c.set({ row: key }),
          more:
            leaf.detail.sections === undefined
              ? undefined
              : (r: unknown) =>
                  (leaf.detail?.sections ?? []).map((d, i) => (
                    <Leaf key={i} leaf={d as ViewLeaf} c={c} row={r} />
                  )),
        };
  const value = at(answer.value, leaf.path);
  if (leaf.show === 'stat')
    return card(
      <StatTile leaf={leaf} label={label} value={value} output={answer.value} />,
      ' stat-card'
    );
  if (leaf.show === 'gallery') {
    const rows = itemsOf(value) ?? [];
    return card(
      <Gallery
        label={label}
        leaf={leaf}
        rows={rows}
        badges={colsOf(leaf as unknown as Widget, reads, value, leaf.badges, '0')}
        detailCols={
          leaf.detail?.fields === undefined
            ? []
            : colsOf(leaf as unknown as Widget, reads, value, leaf.detail.fields, '0')
        }
        empty={emptyOf(leaf)}
        node={node.id}
        members={node.interface.actions}
        reload={reload}
        selector={c.address.s}
        opening={opening ?? { open: undefined, setOpen: () => {} }}
      />
    );
  }
  return card(
    <SectionBody
      widget={leaf as Widget}
      reads={reads}
      output={answer.value}
      now={c.now}
      label={label}
      node={node.id}
      actions={node.interface.actions}
      reload={reload}
      selector={c.address.s}
      opening={opening}
    />
  );
}

/** A view's choice: the items of its read, by label; none chosen, a prompt. */
function Selector(props: {
  selector: ViewSelector;
  node: string | undefined;
  answer: { value: unknown } | { error: string } | undefined;
  selected: string | undefined;
  choose: (value: string | undefined) => void;
}) {
  const { selector: sel, answer } = props;
  const title = sel.title ?? sel.read;
  if (props.node === undefined)
    return (
      <p className="muted">
        {title}: its input {sel.from} is not wired.
      </p>
    );
  if (answer !== undefined && 'error' in answer) return <p className="error">{answer.error}</p>;
  const options = answer === undefined ? [] : optionsOf(sel, answer.value);
  return (
    <div className="field view-selector">
      <label>
        {title}{' '}
        <select
          aria-label={title}
          value={props.selected ?? ''}
          onChange={(e) => props.choose(e.target.value === '' ? undefined : e.target.value)}
        >
          <option value="">pick one…</option>
          {props.selected === undefined ||
          options.some((o) => o.value === props.selected) ? null : (
            <option value={props.selected}>{props.selected}</option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
