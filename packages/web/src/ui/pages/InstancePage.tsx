/**
 * The instance and its health: on or off (the off switch, §4.11, with its button), how long the
 * process has run, its memory, and its plugins and accounts counted by state. The kill switch is
 * the instance's own, as on Telegram (D30, D44).
 */
import { useState } from 'react';
import type { InstanceHealth } from '#src/ui/api.ts';
import { api } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { duration, useLoad } from '#src/ui/hooks.ts';

function Counts({ of }: { of: Record<string, number> }) {
  const entries = Object.entries(of);
  if (entries.length === 0) return <span className="muted">none</span>;
  return (
    <>
      {entries.map(([state, n]) => (
        <span key={state} className={`badge ${state}`}>
          {n} {state}
        </span>
      ))}
    </>
  );
}

export function InstancePage({ loggedOut }: PageProps) {
  const health = useLoad(() => api<InstanceHealth>('/instance'), loggedOut);
  const [said, setSaid] = useState<string>();
  const act = (route: string, ask?: string): void => {
    if (ask !== undefined && !window.confirm(ask)) return;
    api<{ result: string }>(route, {}).then(
      (r) => {
        setSaid(r.result);
        health.reload();
      },
      (e: unknown) => setSaid(e instanceof Error ? e.message : String(e))
    );
  };
  const h = health.data;
  if (h === undefined) return <p className="muted">{health.error ?? 'Loading…'}</p>;
  return (
    <>
      <dl>
        <dt>Instance</dt>
        <dd>
          <span className={`badge ${h.off ? 'off' : 'running'}`}>{h.off ? 'off' : 'on'}</span>{' '}
          {h.off ? (
            <button type="button" onClick={() => act('/on')}>
              Turn on
            </button>
          ) : (
            <button type="button" onClick={() => act('/off', 'Turn the instance off?')}>
              Turn off
            </button>
          )}
        </dd>
        {h.version === undefined ? null : (
          <>
            <dt>Release</dt>
            <dd>
              {h.version}
              {h.commit === undefined ? null : <code> {h.commit.slice(0, 12)}</code>}
            </dd>
          </>
        )}
        <dt>Up for</dt>
        <dd>{duration(h.uptimeS)}</dd>
        <dt>Node</dt>
        <dd>{h.node}</dd>
        <dt>Memory</dt>
        <dd>
          {h.memoryMb.rss} MB ({h.memoryMb.heap} MB heap)
        </dd>
        <dt>Plugins</dt>
        <dd>
          <Counts of={h.plugins} />
        </dd>
        <dt>Accounts</dt>
        <dd>
          <Counts of={h.accounts} />
        </dd>
      </dl>
      <p>
        <button
          type="button"
          className="danger"
          onClick={() => act('/kill', "Kill: run every plugin's safety stop?")}
        >
          Kill
        </button>
      </p>
      {said === undefined ? null : <p role="status">{said}</p>}
      {health.error === undefined ? null : <p role="alert">{health.error}</p>}
    </>
  );
}
