/**
 * A node's full page (docs/bot-os.md P16, D112), at `#/node/<id>`, opened from its panel in the
 * graph editor: the page its plugin declares (`page`: a title and its sections), each section
 * drawn from the output of the read it names (`GET /plugins/<id>/state/<read>`, its input as the
 * query's fields), every read asked once however many sections show it, and asked again every
 * five seconds while the page is open, and at once after a table's row action ran (D157: its
 * pictures from the node's files, its buttons running the node's actions). The node is the
 * running graph's (`GET /graph/view`): its page is its node's, two nodes of one plugin each
 * showing their own.
 */
import { useEffect, useState } from 'react';
import type { GraphViewData, Widget } from '#src/ui/api.ts';
import { api, ApiError, seg } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { query } from '#src/ui/graph/NodeControls.tsx';
import { WidgetSection } from '#src/ui/graph/Widget.tsx';
import { useLoad } from '#src/ui/hooks.ts';

/** How often a page's reads are asked again. */
export const PAGE_EVERY_MS = 5_000;

/** A read as a section asks it: its name and its input, the key of its answer. */
const readKey = (w: Widget): string => `${w.read}${query(w.input ?? {})}`;

/** Each read's answer, or why not, by its key. */
type Answers = Record<string, { value: unknown } | { error: string }>;

export function NodePage(props: PageProps) {
  const id = props.section ?? '';
  const view = useLoad(() => api<GraphViewData | null>('/graph/view'), props.loggedOut, 600_000);
  const node = view.data?.nodes.find((n) => n.id === id);
  const page = node?.page;
  const [answers, setAnswers] = useState<Answers>({});
  // Bumped after a row's action ran (D157): the reads asked again at once.
  const [asked, setAsked] = useState(0);
  const keys = page === undefined ? '' : JSON.stringify(page.sections.map(readKey));

  useEffect(() => {
    if (page === undefined) return undefined;
    let live = true;
    const reads = new Map(page.sections.map((s) => [readKey(s), s]));
    const ask = (): void => {
      void Promise.all(
        [...reads].map(([key, s]) =>
          api<unknown>(`/plugins/${seg(id)}/state/${seg(s.read)}${query(s.input ?? {})}`).then(
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
    // The reads are the page's: asked anew when its node or its sections change, or after an action.
  }, [id, keys, asked]);

  const back = <a href="#/graph">← Graph</a>;
  if (view.data === undefined)
    return (
      <>
        {back}
        <p className={view.error === undefined ? 'muted' : 'error'}>{view.error ?? 'Loading…'}</p>
      </>
    );
  if (node === undefined || page === undefined)
    return (
      <>
        {back}
        <p className="muted">
          {node === undefined
            ? `No node ${id} runs: apply the graph first.`
            : `${id} declares no page.`}
        </p>
      </>
    );
  return (
    <>
      {back}
      <h2>
        {page.title} <span className="muted small">{id}</span>
      </h2>
      {page.sections.map((s, i) => {
        const a = answers[readKey(s)];
        return (
          <WidgetSection
            key={i}
            widget={s}
            reads={node.interface.reads}
            value={a !== undefined && 'value' in a ? a.value : undefined}
            error={a !== undefined && 'error' in a ? a.error : undefined}
            node={id}
            actions={node.interface.actions}
            reload={() => setAsked((n) => n + 1)}
          />
        );
      })}
    </>
  );
}
