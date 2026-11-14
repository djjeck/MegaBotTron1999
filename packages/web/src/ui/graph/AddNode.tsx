/**
 * A node added to the draft (D55, bot-os-api.md §2.2): its id, and the instance whose kept state it
 * runs on, one of two:
 *
 * - **fresh**: a new instance, by default named as the node, made at its first start;
 * - **existing**: an instance of the same plugin kept already (`GET /instances`), with whether a
 *   node uses it and when one last did.
 */
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { AvailablePlugin, InstanceInfo } from '#src/ui/api.ts';
import { freeId, idProblem, NODE_ID } from './draft.ts';

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
  const [kind, setKind] = useState<'fresh' | 'existing'>('fresh');
  const [fresh, setFresh] = useState<string>();
  const ofPlugin = props.instances.filter((i) => i.plugin === plugin.id);
  const free = ofPlugin.filter((i) => !props.usedInstances.has(i.id));
  const [existing, setExisting] = useState(free[0]?.id ?? '');
  const instance = kind === 'fresh' ? (fresh ?? id) : existing;

  const kept = new Map(props.instances.map((i) => [i.id, i]));
  const problem = ((): string | undefined => {
    const bad = idProblem(id, props.nodes);
    if (bad !== undefined) return `node id: ${bad}`;
    if (kind === 'existing' && instance === '') return 'no instance of this plugin to take up';
    if (!NODE_ID.test(instance)) return 'instance: lower-case words and dashes';
    if (props.usedInstances.has(instance)) return `another node runs on the instance ${instance}`;
    const other = kept.get(instance);
    if (kind === 'fresh' && other !== undefined)
      return `an instance ${instance} is kept already (of ${other.plugin ?? 'no plugin'}): take it up as an existing one, or name another`;
    return undefined;
  })();

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (problem !== undefined) return;
    props.add({ id, plugin: plugin.id, instance });
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
        </fieldset>
        {problem === undefined ? null : <p className="error">{problem}</p>}
        <button type="submit" disabled={problem !== undefined}>
          Add {id}
        </button>
        <button type="button" onClick={props.cancel}>
          Cancel
        </button>
      </form>
    </aside>
  );
}
