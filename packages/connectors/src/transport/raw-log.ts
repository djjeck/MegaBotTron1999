/**
 * The last hours of what a connector saw and did, raw, for debugging (bot-os.md D147): every
 * message it heard live, fetched back (a catch-up, a look) or sent, every gap it found and every
 * deletion it heard of, each with when it happened. Kept in its store (`RAW_LOG_DOC`), at most `RAW_LOG_MS` back, written at
 * most every `RAW_LOG_FLUSH_MS`; shown nowhere, read on the instance's volume
 * (`/data/instances/<connector>/raw-log.json`). It holds the chats' text: it never leaves the
 * volume.
 */
import { type Clock, type TimerHandle } from '@megabottron1999/core';
import { type LedgerStore } from './seen-ledger.ts';

/** The store's document of the raw log. */
export const RAW_LOG_DOC = 'raw-log';
/** How far back it keeps: 8 hours. */
export const RAW_LOG_MS = 8 * 3_600_000;
/** How long an entry may wait before the log is written. */
export const RAW_LOG_FLUSH_MS = 30_000;

/** One entry: when (`at`, in ms), how (`via`), and what. */
export interface RawEntry {
  at: number;
  via: 'live' | 'edit' | 'delete' | 'catch-up' | 'look' | 'sent' | 'gap';
  chat: string;
  [field: string]: unknown;
}

export class RawLog {
  private readonly clock: Clock;
  private readonly store: LedgerStore | undefined;
  private entries: RawEntry[];
  private timer: TimerHandle | undefined;

  constructor(clock: Clock, store?: LedgerStore) {
    this.clock = clock;
    this.store = store;
    this.entries = store?.read<RawEntry[]>(RAW_LOG_DOC) ?? [];
  }

  /** An entry, now; the log written within `RAW_LOG_FLUSH_MS`. */
  add(entry: Omit<RawEntry, 'at'>): void {
    if (this.store === undefined) return;
    this.entries.push({ at: this.clock.now(), ...entry } as RawEntry);
    this.timer ??= this.clock.setTimeout(() => this.flush(), RAW_LOG_FLUSH_MS);
  }

  /** Writes what is within `RAW_LOG_MS`, dropping the older. */
  flush(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.store === undefined) return;
    const since = this.clock.now() - RAW_LOG_MS;
    this.entries = this.entries.filter((e) => e.at >= since);
    this.store.write(RAW_LOG_DOC, this.entries);
  }
}
