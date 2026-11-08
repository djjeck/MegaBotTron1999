/** The owner's login: the password of the `web_ui_password` secret (docs/bot-os.md D40). */
import type { FormEvent } from 'react';
import { useState } from 'react';
import { api } from './api.ts';

export function Login({ onLogin, note }: { onLogin: () => void; note?: string | undefined }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setBusy(true);
    api('/login', { password }).then(
      () => onLogin(),
      (err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    );
  };
  return (
    <main className="login">
      <h1>MegaBotTron1999</h1>
      {note === undefined ? null : <p role="status">{note}</p>}
      <form onSubmit={submit}>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          Log in
        </button>
        {error === undefined ? null : <p role="alert">{error}</p>}
      </form>
    </main>
  );
}
