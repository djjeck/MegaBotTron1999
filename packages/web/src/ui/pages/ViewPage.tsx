/**
 * A view's page (docs/bot-os.md D170), at `/v/<path>/`: the view node whose path (its own, else
 * its id) is that, as the running graph's view describes it (`GET /graph/view`, its `served`).
 * Each section is drawn as a node page's is (`Widget.tsx`), from the read it names of the node
 * bound to its input (`from`), whose pictures and actions are that node's; a section of an input
 * left unbound says so. A selector, when the view has one, is a choice of the items of its read,
 * kept in the page's address (`?s=`), which its sections take where they say `'$selector'`. The
 * page names the nodes it shows, each a link to it in the graph.
 *
 * Its reads are asked once each however many sections show them, and again every five seconds
 * while the page is open, and at once after a row's action ran or the choice changed; each is
 * keyed by its node, its read and its input, so that pushed changes may later ask only theirs.
 */
import { useEffect, useMemo, useState } from 'react';
import type { GraphViewData, NodeView, ViewSection, ViewSelector, Widget } from '#src/ui/api.ts';
import { api, ApiError, seg } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { query } from '#src/ui/graph/NodeControls.tsx';
import { SELECTOR_REF } from '#src/ui/graph/TableRow.tsx';
import { WidgetSection } from '#src/ui/graph/Widget.tsx';
import { at, words } from '#src/ui/graph/widget-text.ts';
import { useLoad } from '#src/ui/hooks.ts';
import { PAGE_EVERY_MS } from './NodePage.tsx';

/** A read a view asks: of a node, by name, with its input. */
interface Ask {
  node: string;
  read: string;
  input: Record<string, unknown>;
}

const keyOf = (a: Ask): string => `${a.node}\n${a.read}${query(a.input)}`;

/** Each read's answer, or why not, by its key. */
type Answers = Record<string, { value: unknown } | { error: string }>;

/**
 * A read's input with the selected value in place of `'$selector'`; undefined while it needs one
 * and none is chosen.
 */
export function withSelected(
  input: Readonly<Record<string, unknown>> | undefined,
  selected: string | undefined
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (v !== SELECTOR_REF) out[k] = v;
    else if (selected === undefined) return undefined;
    else out[k] = selected;
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

/** The selected value from the page's address, or none. */
const selectedOf = (search: string): string | undefined =>
  new URLSearchParams(search).get('s') ?? undefined;

export function ViewPage(props: PageProps) {
  const path = props.section ?? '';
  const view = useLoad(() => api<GraphViewData | null>('/graph/view'), props.loggedOut, 600_000);
  const nodes = view.data?.nodes ?? [];
  const node = nodes.find((n) => n.served?.path === path);
  const page = node?.view;
  const bound = node?.served?.bound ?? {};
  const [selected, setSelected] = useState(() => selectedOf(window.location.search));
  const [answers, setAnswers] = useState<Answers>({});
  // Bumped after a row's action ran: the reads asked again at once.
  const [asked, setAsked] = useState(0);

  const choose = (value: string | undefined): void => {
    setSelected(value);
    const url = new URL(window.location.href);
    if (value === undefined) url.searchParams.delete('s');
    else url.searchParams.set('s', value);
    window.history.replaceState(null, '', url);
  };

  const asks = useMemo(() => {
    const out = new Map<string, Ask>();
    const add = (from: string, read: string, input: Record<string, unknown> | undefined): void => {
      const of = bound[from];
      if (of === undefined || input === undefined) return;
      const a = { node: of, read, input };
      out.set(keyOf(a), a);
    };
    if (page?.selector !== undefined)
      add(page.selector.from, page.selector.read, page.selector.input ?? {});
    for (const s of page?.sections ?? []) add(s.from, s.read, withSelected(s.input, selected));
    return out;
  }, [page, bound, selected]);
  const keys = [...asks.keys()].join('\u0000');

  useEffect(() => {
    if (asks.size === 0) return undefined;
    let live = true;
    const ask = (): void => {
      void Promise.all(
        [...asks].map(([key, a]) =>
          api<unknown>(`/plugins/${seg(a.node)}/state/${seg(a.read)}${query(a.input)}`).then(
            (value) => [key, { value }] as const,
            (e: unknown) => {
              if (e instanceof ApiError && e.status === 401) props.loggedOut();
              return [key, { error: e instanceof Error ? e.message : String(e) }] as const;
            }
          )
        )
      ).then((all) => {
        if (live) setAnswers(Object.fromEntries(all));
      });
    };
    ask();
    const timer = setInterval(ask, PAGE_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [keys, asked]);

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
  const answerOf = (from: string, read: string, input: Record<string, unknown> | undefined) => {
    const of = bound[from];
    return of === undefined || input === undefined
      ? undefined
      : answers[keyOf({ node: of, read, input })];
  };
  return (
    <>
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
          answer={answerOf(page.selector.from, page.selector.read, page.selector.input ?? {})}
          selected={selected}
          choose={choose}
        />
      )}
      {page.sections.length === 0 ? (
        <p className="muted">No section yet: add its sections in its node’s config.</p>
      ) : null}
      {page.sections.map((s, i) => (
        <ViewSectionPart
          key={i}
          section={s}
          node={bound[s.from] === undefined ? undefined : byId.get(bound[s.from] as string)}
          answer={answerOf(s.from, s.read, withSelected(s.input, selected))}
          waiting={withSelected(s.input, selected) === undefined}
          selected={selected}
          reload={() => setAsked((n) => n + 1)}
        />
      ))}
    </>
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

/** A view's section: drawn from its bound node's read, or why it cannot be yet. */
function ViewSectionPart(props: {
  section: ViewSection;
  node: NodeView | undefined;
  answer: { value: unknown } | { error: string } | undefined;
  waiting: boolean;
  selected: string | undefined;
  reload: () => void;
}) {
  const { section: s, node, answer } = props;
  const label = s.label ?? s.read;
  if (node === undefined)
    return (
      <section className="widget-section" aria-label={label}>
        <h3>{label}</h3>
        <p className="muted">Its input {s.from} is not wired: draw an edge to it.</p>
      </section>
    );
  if (props.waiting)
    return (
      <section className="widget-section" aria-label={label}>
        <h3>{label}</h3>
        <p className="muted">Pick one above.</p>
      </section>
    );
  const { from: _, ...widget } = s;
  return (
    <WidgetSection
      widget={widget as Widget}
      reads={node.interface.reads}
      value={answer !== undefined && 'value' in answer ? answer.value : undefined}
      error={answer !== undefined && 'error' in answer ? answer.error : undefined}
      node={node.id}
      actions={node.interface.actions}
      reload={props.reload}
      selector={props.selected}
    />
  );
}
