/**
 * The plugins the instance offers (`GET /available`), as the editor adds them (D55): grouped by
 * where they come from, the image first and then each module, the connectors first in each group
 * (a graph starts from its accounts), each with its kinds and description.
 */
import type { AvailablePlugin } from '#src/ui/api.ts';

/** The plugins by group, in the order shown: the image's, then each module's. */
export function groupPlugins(plugins: readonly AvailablePlugin[]): [string, AvailablePlugin[]][] {
  const groups = new Map<string, AvailablePlugin[]>();
  for (const p of plugins) {
    const key = p.module === undefined ? 'The image' : `Module ${p.module}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const connector = (p: AvailablePlugin): number => (p.kinds.includes('connector') ? 0 : 1);
  return [...groups]
    .sort(([a], [b]) => (a === 'The image' ? -1 : b === 'The image' ? 1 : a.localeCompare(b)))
    .map(([k, ps]) => [
      k,
      [...ps].sort((a, b) => connector(a) - connector(b) || a.id.localeCompare(b.id)),
    ]);
}

export function Palette(props: {
  plugins: readonly AvailablePlugin[];
  pick: (plugin: AvailablePlugin) => void;
  close: () => void;
}) {
  return (
    <aside className="details palette" aria-label="plugins">
      <h2>
        Add a node{' '}
        <button type="button" className="link" onClick={props.close}>
          close
        </button>
      </h2>
      {props.plugins.length === 0 ? (
        <p className="muted">This instance offers no plugin.</p>
      ) : (
        groupPlugins(props.plugins).map(([group, plugins]) => (
          <section key={group}>
            <h3>{group}</h3>
            <ul className="plugins">
              {plugins.map((p) => (
                <li key={p.id}>
                  <button type="button" className="plugin" onClick={() => props.pick(p)}>
                    <strong>{p.id}</strong> <span className="muted">{p.kinds.join(', ')}</span>
                    <br />
                    <small>{p.description}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </aside>
  );
}
