/**
 * A view's live updates (docs/bot-os.md D173, #87 phase 3): one stream of the core's changes per
 * open view (`GET /changes?nodes=…`, server-sent events), and the reads of the nodes it names asked
 * again, in one batch (`POST /reads`), in place of asking every read every few seconds.
 *
 * - **While the page's tab is hidden** (Page Visibility), the stream is closed: nothing is asked.
 *   When it shows again, the stream opens and every read is asked once.
 * - **A safety refresh** asks every read every `SAFETY_REFRESH_MS` while the tab is visible, for a
 *   change the core cannot see (a read that depends on the time).
 * - A stream that broke and opened again asks every read once, for what it missed meanwhile.
 */
import { useEffect, useRef } from 'react';
import { api } from '#src/ui/api.ts';

/**
 * How often a view open and visible asks every read, whatever changed (D173): two minutes. One
 * constant, the owner's to change.
 */
export const SAFETY_REFRESH_MS = 120_000;

/** A read as a view asks it: of a node, by name, each field of its input a text, as a query's. */
export interface ReadAsk {
  node: string;
  read: string;
  input: Record<string, string>;
}

/** An answer of `POST /reads`: the read's output, or why not. */
export type ReadAnswer = { value: unknown } | { error: string };

/** Several reads at once (`POST /reads`), their answers in order. */
export async function readAll(reads: readonly ReadAsk[]): Promise<ReadAnswer[]> {
  if (reads.length === 0) return [];
  const { answers } = await api<{ answers: ReadAnswer[] }>('/reads', {
    reads: reads.map((r) => ({
      node: r.node,
      read: r.read,
      ...(Object.keys(r.input).length === 0 ? {} : { input: r.input }),
    })),
  });
  return answers;
}

const hidden = (): boolean => document.visibilityState === 'hidden';

/**
 * Hears the changes of `nodes` while the page is visible: `changed(nodes)` with those that changed,
 * `changed()` for every read (shown again, the stream back, the safety refresh).
 */
export function useLive(nodes: readonly string[], changed: (nodes?: ReadonlySet<string>) => void) {
  const latest = useRef(changed);
  latest.current = changed;
  const key = [...new Set(nodes)].sort().join(',');
  useEffect(() => {
    if (key === '') return undefined;
    let stream: EventSource | undefined;
    const open = (): void => {
      if (stream !== undefined || hidden() || typeof EventSource === 'undefined') return;
      const s = new EventSource(`api/changes?nodes=${encodeURIComponent(key)}`);
      let opened = false;
      s.addEventListener('open', () => {
        // Opened again after it broke: what changed meanwhile was not heard.
        if (opened) latest.current();
        opened = true;
      });
      s.addEventListener('changed', (e) => {
        try {
          const { nodes: told } = JSON.parse((e as MessageEvent<string>).data) as {
            nodes: string[];
          };
          latest.current(new Set(told));
        } catch {
          latest.current();
        }
      });
      stream = s;
    };
    const close = (): void => {
      stream?.close();
      stream = undefined;
    };
    const shown = (): void => {
      if (hidden()) close();
      else {
        open();
        latest.current();
      }
    };
    open();
    document.addEventListener('visibilitychange', shown);
    const safety = setInterval(() => {
      if (!hidden()) latest.current();
    }, SAFETY_REFRESH_MS);
    return () => {
      close();
      clearInterval(safety);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [key]);
}
