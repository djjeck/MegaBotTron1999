/**
 * A connector's queue (bot-os.md D73), in its node's panel: each send waiting, in order, from
 * `GET /plugins/<id>/queue`, read again every few seconds while the panel is open: its chat and
 * text, until when it waits (its command's interval in that chat, and the account's pace), and
 * each node that asked for it (several, coalesced into one send) with what cancels it: events, a
 * test of the plugin's own, a deadline. Read only.
 */
import { useEffect, useState } from 'react';
import type { QueueEntryView } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';

const EVERY_MS = 3000;

const when = (t: number): string => new Date(t).toISOString().slice(11, 19);

/** A node's cancel conditions in words: `on game.changed (sections = inventory) · by 09:05:00`. */
export function cancelText(c: QueueEntryView['nodes'][number]['cancel']): string {
  if (c === undefined) return 'no cancel';
  const parts: string[] = [];
  if (c.on !== undefined) {
    const fields = Object.entries(c.when ?? {}).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
    parts.push(`on ${c.on.join(', ')}${fields.length === 0 ? '' : ` (${fields.join(', ')})`}`);
  }
  if (c.test === true) parts.push('a test of its own');
  if (c.deadline !== undefined) parts.push(`by ${when(c.deadline)}`);
  return parts.join(' · ');
}

export function ConnectorQueue(props: { id: string }) {
  const [entries, setEntries] = useState<QueueEntryView[] | string>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    const load = (): void => {
      api<{ entries: QueueEntryView[] }>(`/plugins/${seg(props.id)}/queue`).then(
        (r) => {
          if (!live) return;
          setEntries(r.entries);
          setNow(Date.now());
        },
        (e: unknown) => {
          if (live) setEntries(e instanceof Error ? e.message : String(e));
        }
      );
    };
    load();
    const timer = setInterval(load, EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [props.id]);
  if (entries === undefined) return null;
  return (
    <section aria-label={`queue of ${props.id}`}>
      <h3>Queue</h3>
      {typeof entries === 'string' ? (
        <p className="muted">{entries}</p>
      ) : entries.length === 0 ? (
        <p className="muted">Nothing waits.</p>
      ) : (
        <ol className="queue">
          {entries.map((e) => (
            <li key={`${e.chat} ${e.text}`}>
              <code>{e.text}</code> <span className="muted">to {e.chat}</span>
              <div className="small">
                {e.waitingUntil <= now ? 'goes now' : `waits until ${when(e.waitingUntil)} UTC`}
                {e.intervalS > 0 ? (
                  <span className="muted">
                    {' '}
                    ({e.intervalS} s between two {e.command})
                  </span>
                ) : null}
              </div>
              <ul className="small">
                {e.nodes.map((n) => (
                  <li key={n.plugin}>
                    <code>{n.plugin}</code>
                    {n.origin === n.plugin ? '' : ` (${n.origin})`}:{' '}
                    <span className="muted">{cancelText(n.cancel)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
