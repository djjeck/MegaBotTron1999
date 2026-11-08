/**
 * How the instance ends (docs/bot-os-api.md §3): at `SIGTERM`, and when the owner restarts it to
 * apply a saved graph (`POST /restart`, §2.3). The core stops first, each plugin's state kept
 * (what `serialise` returns, its timers, P8), then the listeners close, and the process exits 0,
 * so that Docker's `restart: unless-stopped` starts it again after a restart (and a `docker stop`
 * leaves it stopped). A stop that hangs past `capMs` is cut short, so the process always ends.
 */
import { type Clock } from './clock.ts';

export interface ShutdownOptions {
  /** Stops the core, keeping each plugin's state. */
  stop(): Promise<void>;
  /** Closes the listeners, once the core has stopped. */
  close?(): void;
  /** Ends the process (`process.exit`; a test's stub). */
  exit(code: number): void;
  clock: Clock;
  /** The longest the stop may take before the process exits anyway. */
  capMs?: number;
  print?(line: string): void;
}

/** The instance's end, run once however often it is asked for (two signals, a restart and one). */
export function shutdown(o: ShutdownOptions): (why: string) => Promise<void> {
  let ending: Promise<void> | undefined;
  return (why) => {
    ending ??= (async () => {
      o.print?.(`megabottron1999: stopping (${why})`);
      const capMs = o.capMs ?? 30_000;
      let timer: ReturnType<Clock['setTimeout']> | undefined;
      const cap = new Promise<'cut'>((resolve) => {
        timer = o.clock.setTimeout(() => resolve('cut'), capMs);
      });
      let outcome: unknown;
      try {
        outcome = await Promise.race([o.stop(), cap]);
      } catch (e) {
        o.print?.(
          `megabottron1999: the stop failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
      o.clock.clearTimeout(timer);
      if (outcome === 'cut') o.print?.(`megabottron1999: the stop took over ${capMs} ms`);
      try {
        o.close?.();
      } finally {
        o.exit(0);
      }
    })();
    return ending;
  };
}
