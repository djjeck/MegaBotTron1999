/**
 * A connector's login from its node (docs/bot-os.md D116, bot-os-api.md §4.5): what its login asks
 * now (`GET /plugins/<id>/login`), drawn as it says, knowing no network: a step's title, how-to and
 * link, a QR code to scan (renewed as it expires), its fields (a secret one typed unseen and never
 * shown back) and the buttons it offers, each sent with the fields it submits
 * (`POST /plugins/<id>/login`). While a login is under way it is asked again every two seconds, for
 * a QR code renewed or a step that moved on. Once its credentials changed, a restart puts them in
 * force: its button restarts the instance as Apply does.
 */
import qrcode from 'qrcode-generator';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { LoginAction, LoginState } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';

/** How often a login under way is asked again. */
export const LOGIN_POLL_MS = 2000;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A link as a QR code, drawn in SVG, its modules as one path. */
export function QrCode(props: { text: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(props.text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const side = n + quiet * 2;
  return (
    <svg
      className="qr"
      role="img"
      aria-label="QR code to scan"
      viewBox={`0 0 ${side} ${side}`}
      width={props.size ?? 220}
      height={props.size ?? 220}
      shapeRendering="crispEdges"
    >
      <rect width={side} height={side} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

export function ConnectorLogin(props: {
  node: string;
  /** Restarts the instance, as Apply does, to put new credentials in force. */
  restart?: () => void;
  pollMs?: number;
}) {
  const { node, restart, pollMs = LOGIN_POLL_MS } = props;
  const [state, setState] = useState<LoginState>();
  const [failed, setFailed] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const read = useCallback(() => {
    api<LoginState>(`/plugins/${seg(node)}/login`).then(
      (s) => {
        setState(s);
        setFailed(undefined);
      },
      (e: unknown) => setFailed(message(e))
    );
  }, [node]);
  useEffect(read, [read]);
  const pending = state?.status === 'pending';
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(read, pollMs);
    return () => clearInterval(timer);
  }, [pending, read, pollMs]);
  const act = (a: LoginAction): void => {
    if (a.confirm !== undefined && !window.confirm(a.confirm)) return;
    const fields = state?.step?.fields ?? [];
    const sent =
      a.submit === true
        ? Object.fromEntries(fields.map((f) => [f.name, values[f.name] ?? '']))
        : {};
    setBusy(true);
    api<LoginState>(`/plugins/${seg(node)}/login`, { action: a.name, values: sent }).then(
      (s) => {
        setBusy(false);
        setState(s);
        setFailed(undefined);
        // What was typed goes once sent: a secret is never kept in the page.
        setValues({});
      },
      (e: unknown) => {
        setBusy(false);
        setFailed(message(e));
      }
    );
  };
  if (state === undefined)
    return failed === undefined ? null : (
      <section aria-label="its login">
        <h3>Login</h3>
        <p className="error">{failed}</p>
      </section>
    );
  const step = state.step;
  const submit = state.actions.find((a) => a.submit === true);
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (submit !== undefined) act(submit);
  };
  const ordered = [...state.actions].sort(
    (a, b) => Number(b.primary === true) - Number(a.primary === true)
  );
  return (
    <section className="login" aria-label="its login">
      <h3>Login</h3>
      <p>
        <span className={`badge ${state.status === 'done' ? 'connected' : 'needs-login'}`}>
          {state.status === 'done'
            ? 'logged in'
            : state.status === 'pending'
              ? 'logging in'
              : 'needs login'}
        </span>
        {state.as === undefined ? null : <> as {state.as}</>}
        {state.source === undefined ? null : (
          <span className="muted">
            {' '}
            ({state.source === 'store' ? 'kept in its store' : 'from its Docker secrets'})
          </span>
        )}
      </p>
      {state.note === undefined ? null : <p className="muted">{state.note}</p>}
      {state.error === undefined ? null : (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {failed === undefined ? null : (
        <p className="error" role="alert">
          {failed}
        </p>
      )}
      <form onSubmit={onSubmit} aria-label={step?.title ?? 'its login'}>
        {step === undefined ? null : (
          <>
            <h4>{step.title}</h4>
            {step.text === undefined ? null : <p className="small">{step.text}</p>}
            {step.link === undefined ? null : (
              <p>
                <a href={step.link.href} target="_blank" rel="noreferrer noopener">
                  {step.link.label}
                </a>
              </p>
            )}
            {step.qr === undefined ? null : <QrCode text={step.qr} />}
            {step.fields.map((f) => (
              <div className="field" key={f.name}>
                <label>
                  {f.label}
                  <input
                    aria-label={f.label}
                    name={f.name}
                    type={f.secret === true ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={f.placeholder}
                    value={values[f.name] ?? ''}
                    onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  />
                </label>
              </div>
            ))}
          </>
        )}
        <p className="actions">
          {ordered.map((a) => (
            <button
              key={a.name}
              type={a === submit ? 'submit' : 'button'}
              className={a.primary === true ? 'primary' : undefined}
              disabled={busy}
              onClick={a === submit ? undefined : () => act(a)}
            >
              {a.label}
            </button>
          ))}
          {state.restart === true && restart !== undefined ? (
            <button type="button" className="primary" onClick={restart}>
              Restart now
            </button>
          ) : null}
        </p>
      </form>
      {state.restart === true ? (
        <p className="muted small">Its credentials changed: a restart puts them in force.</p>
      ) : null}
    </section>
  );
}
