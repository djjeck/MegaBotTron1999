/** The pages' shared ways: the current page from the URL's hash, and data loaded from the API. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api.ts';

/**
 * The route the hash names (`#/plugins` → `plugins`, `#/node/turn-a` → `node/turn-a`), kept in
 * step with the address bar.
 */
export function useRoute(): string {
  const read = (): string => window.location.hash.replace(/^#\/?/u, '');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const changed = (): void => setRoute(read());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return route;
}

export interface Loaded<T> {
  data?: T;
  error?: string;
  /** Loads again, now. */
  reload: () => void;
}

/** A poll as it runs: asked again now (after the one unanswered, if any), or stopped. */
export interface Poll {
  now(): void;
  stop(): void;
}

/** Whether the page is hidden (another tab, a minimized window): no poll asks then. */
const hidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * `run` at once and every `everyMs` while the page is visible (bot-os.md D172): none while it is
 * hidden, once at once when it shows again, the cadence then resumed; and never while its last
 * run is unanswered, so that a slow core is not asked twice: a `now()` meanwhile runs it once more
 * when that answer comes.
 */
export function poll(run: () => Promise<unknown>, everyMs: number): Poll {
  let busy = false;
  let again = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const ask = (): void => {
    if (stopped) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    void run()
      .catch(() => undefined)
      .then(() => {
        busy = false;
        if (again) {
          again = false;
          ask();
        }
      });
  };
  const tick = (): void => {
    if (!busy) ask();
  };
  const arm = (): void => {
    clearInterval(timer);
    timer = hidden() ? undefined : setInterval(tick, everyMs);
  };
  const shown = (): void => {
    if (!hidden()) tick();
    arm();
  };
  document.addEventListener('visibilitychange', shown);
  ask();
  arm();
  return {
    now: ask,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    },
  };
}

/**
 * What `load` gives, loaded at once and every `everyMs` while the page is visible (`poll`); a 401
 * is the app's (`onLoggedOut`).
 */
export function useLoad<T>(
  load: () => Promise<T>,
  onLoggedOut: () => void,
  everyMs = 10_000
): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const running = useRef<Poll | undefined>(undefined);
  const reload = useCallback(() => running.current?.now(), []);
  useEffect(() => {
    let live = true;
    const p = poll(
      () =>
        load().then(
          (data) => {
            if (live) setState({ data });
          },
          (e: unknown) => {
            if (!live) return;
            if (e instanceof ApiError && e.status === 401) onLoggedOut();
            else setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
          }
        ),
      everyMs
    );
    running.current = p;
    return () => {
      live = false;
      p.stop();
    };
    // `load` and `onLoggedOut` are the page's, the same for its life.
  }, []);
  return { ...state, reload };
}

/** A duration in words: `3d 4h`, `2h 5m`, `40s`. */
export function duration(s: number): string {
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
