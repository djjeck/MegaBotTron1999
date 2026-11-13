/**
 * A script node's ports, edited in its panel (docs/bot-os.md D76, D78): its events inputs (the
 * namespaces it hears, picked from those offered or typed), its interface inputs (a plugin, picked
 * the same way, and the members it uses, from what the plugin offers), its chat-out outputs (the commands each sends, and their spacing), its own
 * event types (their help and fields), and its limits. Each change is a change of the draft's
 * config, which the core checks and turns into the node's manifest (D74), so the graph draws the
 * new ports at once. A port's name is renamed once typed (left, or Enter), not at each keystroke,
 * and each row keeps its identity across a rename, so that the field keeps the focus. A node may
 * have several ports of a kind, each its own name (D84); each row's Remove takes its port away, and
 * the edges bound to it in the same change (asking first when there are any).
 */
import { useRef, useState } from 'react';
import type { GraphEdge, PluginView } from '#src/ui/api.ts';
import type { PortChange } from '#src/ui/graph/draft.ts';
import { edgesOfPort, freeName } from '#src/ui/graph/draft.ts';
import { portsOf } from './types.ts';

type Config = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const recordOf = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** A record with one key renamed in place, its order kept. */
export function renamed(
  r: Record<string, unknown>,
  from: string,
  to: string
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k === from ? to : k, v]));
}

/** A comma-separated list's items, trimmed, none empty. */
export const listOf = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** Fields written `item: string, n: number`, as a record of their types. */
export function fieldsOf(text: string): Record<string, string> {
  return Object.fromEntries(
    listOf(text).map((f) => {
      const [name = '', type = 'unknown'] = f.split(':').map((x) => x.trim());
      return [name, type === '' ? 'unknown' : type];
    })
  );
}

/** The choice that opens the text box, for a value not (yet) offered. */
const OTHER = '\u0000other';

/**
 * A value picked from those offered, or typed: a plugin not installed yet offers nothing, yet may
 * be named. A `<select>` rather than a datalist, which a browser filters by the value already typed,
 * so that every offered value shows whatever the field holds.
 */
/**
 * A port's name, typed in place: kept as typed while the owner types, then renamed once left or on
 * Enter; a name empty or taken is refused, marked so, and the name put back when left or on Escape.
 */
function PortName(props: {
  label: string;
  name: string;
  taken: readonly string[];
  rename: (to: string) => void;
}) {
  const [text, setText] = useState<string>();
  const to = (text ?? props.name).trim();
  const why =
    to === props.name
      ? undefined
      : to === ''
        ? 'a name is needed'
        : props.taken.includes(to)
          ? `${to} is taken`
          : undefined;
  const done = (): void => {
    setText(undefined);
    if (why === undefined && to !== props.name) props.rename(to);
  };
  return (
    <input
      aria-label={props.label}
      aria-invalid={why !== undefined}
      className={`script-port-name${why === undefined ? '' : ' refused'}`}
      {...(why === undefined ? {} : { title: why })}
      value={text ?? props.name}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done();
        else if (e.key === 'Escape') setText(undefined);
      }}
    />
  );
}

/**
 * Keys for rows named by their ports, which a rename keeps: a row renamed is the same row, its
 * field focused still.
 */
function useRowKeys(): {
  keyOf: (name: string) => string;
  moved: (from: string, to: string) => void;
  dropped: (name: string) => void;
} {
  const rows = useRef({ next: 0, keys: new Map<string, string>() });
  return {
    keyOf: (name) => {
      const r = rows.current;
      let key = r.keys.get(name);
      if (key === undefined) {
        key = `row-${r.next++}`;
        r.keys.set(name, key);
      }
      return key;
    },
    moved: (from, to) => {
      const r = rows.current;
      const key = r.keys.get(from);
      r.keys.delete(from);
      if (key !== undefined) r.keys.set(to, key);
    },
    // A port removed: a new one of its name later is a new row, its fields empty.
    dropped: (name) => {
      rows.current.keys.delete(name);
    },
  };
}

export function Picker(props: {
  label: string;
  value: string;
  offered: readonly string[];
  /** The first choice's text, for no value. */
  none: string;
  /** The text box's placeholder. */
  placeholder: string;
  set: (value: string) => void;
}) {
  // Shown typed, the text box stays while the owner types, even through a value offered.
  const [other, setOther] = useState(
    () => !(props.value === '' || props.offered.includes(props.value))
  );
  const typed = other || !(props.value === '' || props.offered.includes(props.value));
  return (
    <>
      <select
        aria-label={props.label}
        value={typed ? OTHER : props.value}
        onChange={(e) => {
          const v = e.target.value;
          setOther(v === OTHER);
          if (v !== OTHER) props.set(v);
        }}
      >
        <option value="">{props.none}</option>
        {props.offered.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        <option value={OTHER}>other…</option>
      </select>
      {typed ? (
        <input
          aria-label={`${props.label}, typed`}
          placeholder={props.placeholder}
          value={props.value}
          onChange={(e) => props.set(e.target.value.trim())}
        />
      ) : null}
    </>
  );
}

export function ScriptPorts(props: {
  /** Its node's id, for the edges bound to its ports. */
  id: string;
  config: Config;
  /**
   * Its config changed; with a port renamed or removed, its edges move with it or go, in the same
   * change.
   */
  change: (config: Config, port?: PortChange) => void;
  /** The plugins and nodes it may use or hear, for the choices. */
  plugins: readonly PluginView[];
  /** The draft's edges, to say which a removed port takes with it. */
  edges: readonly GraphEdge[];
  /** The check's problems, by config key. */
  errors: Record<string, string[]>;
}) {
  const { config, change } = props;
  const inputs = recordOf(config['inputs']);
  const outputs = recordOf(config['outputs']);
  const events = recordOf(config['events']);
  const limits = recordOf(config['limits']);
  const ports = portsOf(config);
  const set = (key: string, value: unknown): void => change({ ...config, [key]: value });
  const setInput = (name: string, value: Record<string, unknown>): void =>
    set('inputs', { ...inputs, [name]: value });
  const namespaces = [
    ...new Set(
      props.plugins.flatMap((p) =>
        Object.values(p.outputs).flatMap((o) =>
          o.type === 'events' && o.namespace !== undefined ? [o.namespace] : []
        )
      )
    ),
  ].sort();
  const offered = props.plugins
    .filter((p) => p.interface.reads.length + p.interface.actions.length > 0)
    .map((p) => p.plugin)
    .sort();
  const errors = (key: string) =>
    (props.errors[key] ?? []).length === 0 ? null : (
      <ul className="problems" aria-label={`problems of its ${key}`}>
        {(props.errors[key] ?? []).map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    );
  const rows = {
    inputs: useRowKeys(),
    outputs: useRowKeys(),
    events: useRowKeys(),
  };
  const portName = (kind: 'inputs' | 'outputs' | 'events', name: string, label: string) => {
    const r = kind === 'inputs' ? inputs : kind === 'outputs' ? outputs : events;
    return (
      <PortName
        label={label}
        name={name}
        taken={Object.keys(r)}
        rename={(to) => {
          rows[kind].moved(name, to);
          change(
            { ...config, [kind]: renamed(r, name, to) },
            kind === 'events'
              ? undefined
              : { side: kind === 'inputs' ? 'in' : 'out', from: name, to }
          );
        }}
      />
    );
  };
  /**
   * A port's Remove: its port gone from the config, and the edges bound to it with it, in one
   * change of the draft (D84), once the owner says so when it has any.
   */
  const remove = (kind: 'inputs' | 'outputs' | 'events', name: string, label: string) => {
    const side = kind === 'inputs' ? 'in' : 'out';
    const bound = kind === 'events' ? [] : edgesOfPort(props.edges, props.id, side, name);
    const other = (e: GraphEdge): string => (side === 'in' ? e.from : e.to);
    return (
      <button
        type="button"
        className="link danger port-remove"
        aria-label={`remove ${label}`}
        title={
          bound.length === 0
            ? `Remove ${label}`
            : `Remove ${label} and its edge${bound.length === 1 ? '' : 's'} (${bound.map(other).join(', ')})`
        }
        onClick={() => {
          if (
            bound.length > 0 &&
            !window.confirm(
              `Remove ${label}? ${bound.length === 1 ? 'Its edge goes' : `Its ${bound.length} edges go`} with it: ${bound.map(other).join(', ')}.`
            )
          )
            return;
          rows[kind].dropped(name);
          const { [name]: _, ...rest } =
            kind === 'inputs' ? inputs : kind === 'outputs' ? outputs : events;
          change(
            { ...config, [kind]: rest },
            kind === 'events' ? undefined : { side, removed: name }
          );
        }}
      >
        Remove
      </button>
    );
  };
  return (
    <div className="script-ports">
      <fieldset>
        <legend>Events it hears</legend>
        {Object.entries(ports.inputs).flatMap(([name, p]) =>
          p.type !== 'events'
            ? []
            : [
                <div
                  className="port-row"
                  key={rows.inputs.keyOf(name)}
                  role="group"
                  aria-label={`events input ${name}`}
                >
                  {portName('inputs', name, `port of events input ${name}`)}
                  <Picker
                    label={`namespace of ${name}`}
                    value={p.namespace}
                    offered={namespaces}
                    none="pick a namespace"
                    placeholder="namespace"
                    set={(namespace) => setInput(name, { ...recordOf(inputs[name]), namespace })}
                  />
                  <label className="choice">
                    <input
                      type="checkbox"
                      aria-label={`${name} is optional`}
                      checked={p.optional === true}
                      onChange={(e) =>
                        setInput(name, { ...recordOf(inputs[name]), optional: e.target.checked })
                      }
                    />
                    optional
                  </label>
                  {remove('inputs', name, `events input ${name}`)}
                </div>,
              ]
        )}
        <button
          type="button"
          onClick={() =>
            setInput(freeName('events', Object.keys(inputs)), { type: 'events', namespace: '' })
          }
        >
          + events input
        </button>
      </fieldset>
      <fieldset>
        <legend>Interfaces it uses</legend>
        {Object.entries(ports.inputs).flatMap(([name, p]) => {
          if (p.type !== 'interface') return [];
          const view = props.plugins.find((v) => v.plugin === p.plugin);
          const members =
            view === undefined
              ? []
              : [
                  ...view.interface.reads.map((m) => `state.${m.name}`),
                  ...view.interface.actions.map((m) => `actions.${m.name}`),
                ];
          const setMembers = (m: string[]): void =>
            setInput(name, { ...recordOf(inputs[name]), members: m });
          return [
            <div
              className="port-row"
              key={rows.inputs.keyOf(name)}
              role="group"
              aria-label={`interface input ${name}`}
            >
              {portName('inputs', name, `port of interface input ${name}`)}
              <Picker
                label={`plugin of ${name}`}
                value={p.plugin ?? ''}
                offered={offered}
                none="any plugin"
                placeholder="plugin"
                set={(v) => {
                  const { plugin: _, ...rest } = recordOf(inputs[name]);
                  setInput(name, v === '' ? rest : { ...rest, plugin: v });
                }}
              />
              <label className="choice">
                <input
                  type="checkbox"
                  aria-label={`${name} is optional`}
                  checked={p.optional === true}
                  onChange={(e) =>
                    setInput(name, { ...recordOf(inputs[name]), optional: e.target.checked })
                  }
                />
                optional
              </label>
              {remove('inputs', name, `interface input ${name}`)}
              <div className="members" aria-label={`members of ${name}`}>
                {members.map((m) => (
                  <label className="choice" key={m}>
                    <input
                      type="checkbox"
                      checked={p.members.includes(m)}
                      onChange={(e) =>
                        setMembers(
                          e.target.checked ? [...p.members, m] : p.members.filter((x) => x !== m)
                        )
                      }
                    />
                    <code>{m}</code>
                  </label>
                ))}
                {members.length > 0 ? null : (
                  <input
                    aria-label={`members of ${name}, by name`}
                    placeholder="state.get, actions.sent"
                    defaultValue={p.members.join(', ')}
                    onBlur={(e) => setMembers(listOf(e.target.value))}
                  />
                )}
              </div>
            </div>,
          ];
        })}
        <button
          type="button"
          onClick={() =>
            setInput(freeName('interface', Object.keys(inputs)), { type: 'interface', members: [] })
          }
        >
          + interface input
        </button>
      </fieldset>
      {errors('inputs')}
      <fieldset>
        <legend>What it sends</legend>
        {Object.entries(ports.outputs).map(([name, p]) => (
          <div
            className="port-row"
            key={rows.outputs.keyOf(name)}
            role="group"
            aria-label={`chat-out output ${name}`}
          >
            {portName('outputs', name, `port of chat-out output ${name}`)}
            <input
              aria-label={`commands of ${name}`}
              placeholder="/look, /inventory"
              defaultValue={p.commands.join(', ')}
              onBlur={(e) =>
                set('outputs', {
                  ...outputs,
                  [name]: { ...recordOf(outputs[name]), commands: listOf(e.target.value) },
                })
              }
            />
            {remove('outputs', name, `chat-out output ${name}`)}
            <div className="spacing">
              {p.commands.map((c) => (
                <label key={c}>
                  <code>{c}</code> at most once every{' '}
                  <input
                    type="number"
                    min={0}
                    aria-label={`seconds between two ${c}`}
                    value={p.minIntervalS?.[c] ?? ''}
                    placeholder="—"
                    onChange={(e) => {
                      const spacing: Record<string, number> = { ...p.minIntervalS };
                      if (e.target.value === '') delete spacing[c];
                      else spacing[c] = Number(e.target.value);
                      const { minIntervalS: _, ...rest } = recordOf(outputs[name]);
                      set('outputs', {
                        ...outputs,
                        [name]:
                          Object.keys(spacing).length === 0
                            ? rest
                            : { ...rest, minIntervalS: spacing },
                      });
                    }}
                  />{' '}
                  s
                </label>
              ))}
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            set('outputs', {
              ...outputs,
              [freeName('chat', Object.keys(outputs))]: { type: 'chat-out', commands: [] },
            })
          }
        >
          + chat-out output
        </button>
      </fieldset>
      {errors('outputs')}
      <fieldset>
        <legend>Its own events</legend>
        {Object.entries(ports.events).map(([name, e]) => (
          <div
            className="port-row"
            key={rows.events.keyOf(name)}
            role="group"
            aria-label={`event ${name}`}
          >
            {portName('events', name, `name of event ${name}`)}
            <input
              aria-label={`help of event ${name}`}
              placeholder="what it says"
              value={e.help}
              onChange={(ev) =>
                set('events', {
                  ...events,
                  [name]: { ...recordOf(events[name]), help: ev.target.value },
                })
              }
            />
            <input
              aria-label={`fields of event ${name}`}
              placeholder="item: string, n: number"
              defaultValue={Object.entries(e.fields)
                .map(([k, t]) => `${k}: ${t}`)
                .join(', ')}
              onBlur={(ev) =>
                set('events', {
                  ...events,
                  [name]: { ...recordOf(events[name]), fields: fieldsOf(ev.target.value) },
                })
              }
            />
            {remove('events', name, `event ${name}`)}
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            set('events', {
              ...events,
              [freeName('done', Object.keys(events))]: { help: 'What it did', fields: {} },
            })
          }
        >
          + event
        </button>
      </fieldset>
      {errors('events')}
      <fieldset>
        <legend>Limits</legend>
        <label>
          A handler’s run, at most{' '}
          <input
            type="number"
            aria-label="time limit in ms"
            min={10}
            value={typeof limits['callMs'] === 'number' ? limits['callMs'] : 1000}
            onChange={(e) =>
              set('limits', { memoryMb: 64, ...limits, callMs: Number(e.target.value) })
            }
          />{' '}
          ms
        </label>
        <label>
          Its heap, at most{' '}
          <input
            type="number"
            aria-label="memory limit in MB"
            min={16}
            value={typeof limits['memoryMb'] === 'number' ? limits['memoryMb'] : 64}
            onChange={(e) =>
              set('limits', { callMs: 1000, ...limits, memoryMb: Number(e.target.value) })
            }
          />{' '}
          MB
        </label>
      </fieldset>
      {errors('limits')}
    </div>
  );
}
