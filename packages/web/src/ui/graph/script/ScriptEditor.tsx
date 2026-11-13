/**
 * A script node's editor (docs/bot-os.md D78): a dialog over the graph editor with its code in
 * Monaco (`ScriptCode.tsx`, loaded lazily), typed by its node's `.d.ts` (`types.ts`), and its API
 * beside it (`ApiPanel`): its ports, the members and event types each brings, with their help and
 * types, and the script API's calls. **Keep** writes the code to the draft, applied as any change
 * with Apply; it is refused while the code does not parse. Type errors are shown, and kept: the
 * owner may know better than the types.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { signature } from '#src/ui/graph/signature.ts';
import type { CodeDiagnostics } from './ScriptCode.tsx';
import type { ScriptApi } from './types.ts';
import { scriptDts, tsType } from './types.ts';

const ScriptCode = lazy(() => import('./ScriptCode.tsx'));

/** The script API's calls, as the panel lists them. */
export const API_CALLS: [string, string][] = [
  ['on(type, fn)', 'A handler of an event type or a namespace it hears, registered as it loads'],
  ['use(port).state.<read>(input)', 'A read of an interface input: a promise of its output'],
  ['use(port).actions.<action>(input)', 'An action of an interface input: a promise'],
  [
    'enqueue(port, chat, text, { cancel })',
    'A queued send through a chat-out output (outbox(port).enqueue): awaited, its outcome',
  ],
  ['publish(type, payload)', 'An event of its own'],
  ['store.read(name), store.write(name, value)', 'Its own documents, kept across restarts'],
  ['clock.now()', 'The node’s clock, in ms; Date reads it too'],
  ['log(...), log.warn(...), log.error(...)', 'Its log lines, prefixed with its id'],
];

/** What a script reaches, as its editor lists it beside the code. */
export function ApiPanel(props: { api: ScriptApi }) {
  const { api } = props;
  return (
    <aside className="script-api" aria-label="script API">
      <h3>Events it hears</h3>
      {api.events.length === 0 && api.own.length === 0 ? (
        <p className="muted small">No events input: declare one in the node’s panel.</p>
      ) : null}
      <ul>
        {api.events.map((p) => (
          <li key={p.port}>
            <code>{p.namespace}</code>{' '}
            <span className="muted small">
              through {p.port}
              {p.from.length === 0 ? ' (not bound)' : `, from ${p.from.join(', ')}`}
            </span>
            {p.types.length === 0 ? (
              <p className="muted small">No event type known in it.</p>
            ) : (
              <ul>
                {p.types.map((t) => (
                  <li key={t.type}>
                    <details>
                      <summary>
                        <code>{t.type}</code>
                        {t.help === undefined ? null : <span className="muted"> — {t.help}</span>}
                      </summary>
                      <pre className="small">{tsType(t.schema)}</pre>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {api.own.map((e) => (
          <li key={e.type}>
            <code>{e.type}</code> <span className="muted small">its own</span>
          </li>
        ))}
      </ul>
      <h3>Interfaces it uses</h3>
      {api.interfaces.length === 0 ? <p className="muted small">None.</p> : null}
      <ul>
        {api.interfaces.map((i) => (
          <li key={i.port}>
            <code>use({JSON.stringify(i.port)})</code>{' '}
            <span className="muted small">
              {i.from === undefined ? 'not bound' : `from ${i.from}`}
            </span>
            <ul>
              {i.members.map((m) => (
                <li key={m.name}>
                  <code>
                    {m.unknown === true
                      ? m.name
                      : signature(m.name, {
                          name: m.name,
                          help: m.help ?? '',
                          ...(m.input === undefined ? {} : { input: m.input }),
                          ...(m.output === undefined ? {} : { output: m.output }),
                        })}
                  </code>
                  {m.unknown === true ? (
                    <span className="error small"> — not offered there</span>
                  ) : m.help === undefined ? null : (
                    <span className="muted small"> — {m.help}</span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <h3>What it sends</h3>
      {api.outputs.length === 0 ? <p className="muted small">No chat-out output.</p> : null}
      <ul>
        {api.outputs.map((o) => (
          <li key={o.port}>
            <code>enqueue({JSON.stringify(o.port)}, chat, text)</code>{' '}
            <span className="muted small">
              {o.commands.join(', ')}
              {o.to === undefined ? ', not bound' : ` to ${o.to}`}
            </span>
          </li>
        ))}
      </ul>
      {api.own.length === 0 ? null : (
        <>
          <h3>Its own events</h3>
          <ul>
            {api.own.map((e) => (
              <li key={e.type}>
                <code>
                  publish({JSON.stringify(e.type)}, {'{ '}
                  {Object.entries(e.fields)
                    .map(([k, t]) => `${k}: ${t}`)
                    .join(', ')}
                  {' }'})
                </code>
                {e.help === '' ? null : <span className="muted small"> — {e.help}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>The API</h3>
      <ul className="small">
        {API_CALLS.map(([call, what]) => (
          <li key={call}>
            <code>{call}</code> <span className="muted">— {what}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function ScriptEditor(props: {
  id: string;
  code: string;
  api: ScriptApi;
  /** The check's problems with its code. */
  problems: readonly string[];
  keep: (code: string) => void;
  close: () => void;
}) {
  const [code, setCode] = useState(props.code);
  const [diagnostics, setDiagnostics] = useState<CodeDiagnostics>();
  const dts = useMemo(() => scriptDts(props.api, props.id), [props.api, props.id]);
  const { close } = props;
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close]);
  const syntax = diagnostics?.syntax ?? [];
  const types = diagnostics?.types ?? [];
  const changed = code !== props.code;
  return (
    <div className="overlay script-overlay">
      <div
        className="card script-editor"
        role="dialog"
        aria-modal="true"
        aria-label={`script of ${props.id}`}
      >
        <header>
          <h2>
            Script of <code>{props.id}</code>
          </h2>
          <span className="script-status" role="status">
            {diagnostics === undefined
              ? 'Checking…'
              : syntax.length > 0
                ? `${syntax.length} syntax error${syntax.length === 1 ? '' : 's'}: it cannot be kept`
                : types.length > 0
                  ? `${types.length} type error${types.length === 1 ? '' : 's'}`
                  : 'No errors'}
          </span>
          <button
            type="button"
            className="primary"
            disabled={!changed || syntax.length > 0 || diagnostics === undefined}
            title={
              syntax.length > 0 ? 'The code does not parse' : 'Into the draft, applied with Apply'
            }
            onClick={() => props.keep(code)}
          >
            Keep
          </button>
          <button type="button" onClick={close} ref={first}>
            {changed ? 'Discard' : 'Close'}
          </button>
        </header>
        {props.problems.length === 0 ? null : (
          <ul className="problems" aria-label="the check's problems">
            {props.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="script-body">
          <div className="script-left">
            <Suspense fallback={<p className="muted">Loading the editor…</p>}>
              <ScriptCode
                id={props.id}
                value={props.code}
                dts={dts}
                onChange={setCode}
                onDiagnostics={setDiagnostics}
              />
            </Suspense>
            {syntax.length + types.length === 0 ? null : (
              <ul className="script-diagnostics" aria-label="errors">
                {[...syntax, ...types].map((d, i) => (
                  <li key={i} className={i < syntax.length ? 'error' : 'warning'}>
                    {d}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <ApiPanel api={props.api} />
        </div>
      </div>
    </div>
  );
}
