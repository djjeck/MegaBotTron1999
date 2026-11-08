/**
 * A node added to the draft (D55, bot-os-api.md §2.2): its id, and the instance whose kept state it
 * runs on, one of three:
 *
 * - **fresh**: a new instance, by default named as the node, made at its first start;
 * - **existing**: an instance of the same plugin kept already (`GET /instances`), with whether a
 *   node uses it and when one last did;
 * - **imported**: a store of an older data directory (`GET /legacy`, those of the plugin's id
 *   first), copied into a fresh instance now (`POST /instances/import`); an instance no node uses
 *   is deleted after 7 days, as any.
 */
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import type { AvailablePlugin, InstanceInfo, LegacyReport } from '#src/ui/api.ts';
import { api, ApiError } from '#src/ui/api.ts';
import { freeId, idProblem, NODE_ID } from './draft.ts';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const when = (t: number | undefined): string =>
  t === undefined ? 'never' : new Date(t).toISOString().slice(0, 16).replace('T', ' ');

export interface NewNode {
  id: string;
  plugin: string;
  /** The instance; the node's id when the same. */
  instance: string;
}

export function AddNode(props: {
  plugin: AvailablePlugin;
  /** The draft's node ids, and the instances its nodes name. */
  nodes: ReadonlySet<string>;
  usedInstances: ReadonlySet<string>;
  instances: readonly InstanceInfo[];
  add: (node: NewNode) => void;
  cancel: () => void;
}) {
  const { plugin } = props;
  const [id, setId] = useState(() => freeId(plugin.id, props.nodes));
  const [kind, setKind] = useState<'fresh' | 'existing' | 'imported'>('fresh');
  const [fresh, setFresh] = useState<string>();
  const ofPlugin = props.instances.filter((i) => i.plugin === plugin.id);
  const free = ofPlugin.filter((i) => !props.usedInstances.has(i.id));
  const [existing, setExisting] = useState(free[0]?.id ?? '');
  const [legacy, setLegacy] = useState<LegacyReport | string>();
  const [allStores, setAllStores] = useState(false);
  const [store, setStore] = useState('');
  const [imported, setImported] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (kind !== 'imported' || legacy !== undefined) return;
    api<LegacyReport>('/legacy').then(setLegacy, (e: unknown) =>
      setLegacy(
        e instanceof ApiError && e.status === 404
          ? 'No older data directory is mounted (LEGACY_DIR).'
          : message(e)
      )
    );
  }, [kind, legacy]);

  const stores =
    typeof legacy === 'object' ? legacy.stores.filter((s) => allStores || s.id === plugin.id) : [];
  const chosenStore = stores.some((s) => s.id === store) ? store : (stores[0]?.id ?? '');
  const instance =
    kind === 'fresh' ? (fresh ?? id) : kind === 'existing' ? existing : (imported ?? chosenStore);

  const kept = new Map(props.instances.map((i) => [i.id, i]));
  const problem = ((): string | undefined => {
    const bad = idProblem(id, props.nodes);
    if (bad !== undefined) return `node id: ${bad}`;
    if (kind === 'existing' && instance === '') return 'no instance of this plugin to take up';
    if (kind === 'imported' && chosenStore === '') return 'no store to import';
    if (!NODE_ID.test(instance)) return 'instance: lower-case words and dashes';
    if (props.usedInstances.has(instance)) return `another node runs on the instance ${instance}`;
    const other = kept.get(instance);
    if (kind !== 'existing' && other !== undefined)
      return `an instance ${instance} is kept already (of ${other.plugin ?? 'no plugin'}): take it up as an existing one, or name another`;
    return undefined;
  })();

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (problem !== undefined) return;
    if (kind !== 'imported') {
      props.add({ id, plugin: plugin.id, instance });
      return;
    }
    setBusy(true);
    api<{ instance: string }>('/instances/import', {
      from: chosenStore,
      instance,
      plugin: plugin.id,
    }).then(
      (r) => props.add({ id, plugin: plugin.id, instance: r.instance }),
      (err: unknown) => {
        setBusy(false);
        setError(message(err));
      }
    );
  };

  return (
    <aside className="details" aria-label={`add ${plugin.id}`}>
      <h2>Add {plugin.id}</h2>
      <p>
        {plugin.description} <span className="muted">({plugin.kinds.join(', ')})</span>
      </p>
      <form onSubmit={submit}>
        <div className="field">
          <label>
            Node id
            <input aria-label="node id" value={id} onChange={(e) => setId(e.target.value.trim())} />
          </label>
        </div>
        <fieldset>
          <legend>Its instance: the state it keeps</legend>
          <label className="choice">
            <input
              type="radio"
              name="instance"
              checked={kind === 'fresh'}
              onChange={() => setKind('fresh')}
            />
            A fresh one
          </label>
          {kind === 'fresh' ? (
            <input
              aria-label="fresh instance"
              value={fresh ?? id}
              onChange={(e) => setFresh(e.target.value.trim())}
            />
          ) : null}
          <label className="choice">
            <input
              type="radio"
              name="instance"
              checked={kind === 'existing'}
              disabled={ofPlugin.length === 0}
              onChange={() => setKind('existing')}
            />
            One kept of {plugin.id}{' '}
            {ofPlugin.length === 0 ? <span className="muted">(none)</span> : null}
          </label>
          {kind === 'existing' ? (
            <select
              aria-label="existing instance"
              value={existing}
              onChange={(e) => setExisting(e.target.value)}
            >
              <option value="" />
              {ofPlugin.map((i) => (
                <option key={i.id} value={i.id} disabled={props.usedInstances.has(i.id)}>
                  {i.id}: {i.used ? `used${i.node === undefined ? '' : ` by ${i.node}`}` : 'unused'}
                  , last referenced {when(i.referenced)}
                </option>
              ))}
            </select>
          ) : null}
          <label className="choice">
            <input
              type="radio"
              name="instance"
              checked={kind === 'imported'}
              onChange={() => setKind('imported')}
            />
            Imported from the older data directory
          </label>
          {kind === 'imported' ? (
            typeof legacy === 'string' ? (
              <p className="muted">{legacy}</p>
            ) : legacy === undefined ? (
              <p className="muted">Loading…</p>
            ) : (
              <>
                <select
                  aria-label="store"
                  value={chosenStore}
                  onChange={(e) => setStore(e.target.value)}
                >
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}: {s.documents.length} documents, version {s.version}
                      {s.timers.length === 0 ? '' : `, timers ${s.timers.join(' ')}`}
                      {s.mode === undefined ? '' : `, was ${s.mode}`}
                    </option>
                  ))}
                </select>
                {stores.length === 0 ? <p className="muted">No store of {plugin.id}.</p> : null}
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={allStores}
                    onChange={(e) => setAllStores(e.target.checked)}
                  />
                  Every store, not only {plugin.id}’s
                </label>
                <input
                  aria-label="imported instance"
                  value={imported ?? chosenStore}
                  onChange={(e) => setImported(e.target.value.trim())}
                />
                <small className="muted">
                  Copied now into this new instance; its mode is not (it starts read-only, or in the
                  node’s mode).
                </small>
              </>
            )
          ) : null}
        </fieldset>
        {problem === undefined ? null : <p className="error">{problem}</p>}
        {error === undefined ? null : <p role="alert">{error}</p>}
        <button type="submit" disabled={problem !== undefined || busy}>
          Add {id}
        </button>
        <button type="button" onClick={props.cancel}>
          Cancel
        </button>
      </form>
    </aside>
  );
}
