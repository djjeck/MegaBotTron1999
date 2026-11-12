/**
 * Applying what is saved (D55, bot-os-api.md §2.3): `POST /restart`, then the wait, told step by
 * step. The instance stops (each plugin's state kept), its process exits, and Docker starts it again
 * on the saved graph and the modules installed (`restart: unless-stopped`). The UI is served by that
 * same process, so it loses the connection meanwhile: it asks `GET /session` until a new process
 * answers (another `boot` id than the one before), then goes back to the page, still logged in, as
 * the sessions are kept across restarts; or to the login, saying why, if the session did not
 * survive (the password changed).
 */
import { useEffect, useState } from 'react';
import { api } from './api.ts';

/** What `GET /session` says: logged in or not, and which process answers. */
interface Session {
  authenticated: boolean;
  boot?: string;
}

type Phase = 'asking' | 'stopping' | 'down' | 'gone';

const STEPS: Record<Phase, string> = {
  asking: 'Asking the instance to restart…',
  stopping: 'Stopping: each plugin saves its state…',
  down: 'Starting again: waiting for the instance to answer…',
  gone: 'The instance has not come back. Look at the container (`docker logs`), and at its restart policy, which must start it again (`unless-stopped`).',
};

export function Restart(props: {
  /** The new instance answers, the session kept: back to the page, with what happened. */
  done: (note: string) => void;
  /** The new instance answers, the session gone: the login, with why. */
  loggedOut: (note: string) => void;
  /** The restart refused: back to the page. */
  failed: (why: string) => void;
  everyMs?: number;
  /** How long it may take to come back before the UI says it has not. */
  giveUpMs?: number;
}) {
  const [phase, setPhase] = useState<Phase>('asking');
  const { done, loggedOut, failed, everyMs = 1000, giveUpMs = 120_000 } = props;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = (): void => {
      if (!live) return;
      if (Date.now() - started > giveUpMs) {
        setPhase('gone');
        return;
      }
      api<Session>('/session').then(
        (s) => {
          if (!live) return;
          if (!s.authenticated)
            loggedOut(
              'The instance restarted, but this session ended (the password changed?): log in again.'
            );
          else if (s.boot === boot) timer = setTimeout(poll, everyMs);
          else done('The instance restarted: it runs the saved graph and the modules installed.');
        },
        () => {
          if (!live) return;
          setPhase('down');
          timer = setTimeout(poll, everyMs);
        }
      );
    };
    // The process that answers now, to tell the new one from it.
    let boot: string | undefined;
    api<Session>('/session')
      .then(
        (s) => {
          boot = s.boot;
        },
        () => {}
      )
      .then(() => (live ? api('/restart', {}) : undefined))
      .then(
        () => {
          if (!live) return;
          setPhase('stopping');
          timer = setTimeout(poll, everyMs);
        },
        (e: unknown) => {
          if (live) failed(e instanceof Error ? e.message : String(e));
        }
      );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // Once, as it is shown.
  }, []);
  return (
    <div className="overlay" role="dialog" aria-label="restarting">
      <div className="card">
        <h2>Restarting</h2>
        <p role="status">{STEPS[phase]}</p>
        <p className="muted small">
          The instance stops, keeping each plugin’s state, and starts again on what is saved. This
          page loses its connection meanwhile and comes back by itself, still logged in.
        </p>
      </div>
    </div>
  );
}
