/**
 * A script node's ports, edited in its panel (docs/bot-os.md D76, D78): its events inputs (the
 * namespaces it hears, picked from those offered or typed), its interface inputs (a plugin, picked
 * the same way, and the members it uses, from what the plugin offers), its chat-out outputs (the commands each sends, and their spacing), its own
 * event types (their help and fields), and its limits. Each change is a change of the draft's
 * config, which the core checks and turns into the node's manifest (D74), so the graph draws the
 * new ports at once.
 */
import { useState } from 'react';
import type { PluginView } from '#src/ui/api.ts';
import { portsOf } from './types.ts';

type Config = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const recordOf = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** A free port name: `base`, then `base-2`, `base-3`… */
export function freeName(base: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  if (!t.has(base)) return base;
  let n = 2;
  while (t.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

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
  const [other, setOther] = useState(false);
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
  config: Config;
  change: (config: Config) => void;
  /** The plugins and nodes it may use or hear, for the choices. */
  plugins: readonly PluginView[];
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
  const portName = (kind: 'inputs' | 'outputs' | 'events', name: string, label: string) => (
    <input
      aria-label={label}
      className="script-port-name"
      value={name}
      onChange={(e) => {
        const to = e.target.value.trim();
        const r = kind === 'inputs' ? inputs : kind === 'outputs' ? outputs : events;
        if (to !== '' && !(to in r)) set(kind, renamed(r, name, to));
      }}
    />
  );
  const remove = (kind: 'inputs' | 'outputs' | 'events', name: string, label: string) => (
    <button
      type="button"
      className="link"
      aria-label={`remove ${label}`}
      onClick={() => {
        const { [name]: _, ...rest } =
          kind === 'inputs' ? inputs : kind === 'outputs' ? outputs : events;
        set(kind, rest);
      }}
    >
      ×
    </button>
  );
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
                  key={name}
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
              key={name}
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
          <div className="port-row" key={name} role="group" aria-label={`chat-out output ${name}`}>
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
          <div className="port-row" key={name} role="group" aria-label={`event ${name}`}>
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
