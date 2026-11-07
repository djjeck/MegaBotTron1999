/** The pages' shared ways: the current page from the URL's hash, and data loaded from the API. */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api.ts';

/** The page the hash names (`#/plugins` → `plugins`), kept in step with the address bar. */
export function useRoute(): string {
  const read = (): string => window.location.hash.replace(/^#\/?/u, '').split('/')[0] ?? '';
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

/** What `load` gives, loaded at once and every `everyMs`; a 401 is the app's (`onLoggedOut`). */
export function useLoad<T>(
  load: () => Promise<T>,
  onLoggedOut: () => void,
  everyMs = 10_000
): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    load().then(
      (data) => {
        if (live) setState({ data });
      },
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) onLoggedOut();
        else setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      }
    );
    const timer = setInterval(reload, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // `load` and `onLoggedOut` are the page's, the same for its life; `tick` asks again.
  }, [tick]);
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
