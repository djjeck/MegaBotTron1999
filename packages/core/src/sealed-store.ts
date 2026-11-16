/**
 * A connector's kept credentials, sealed at rest (docs/bot-os-api.md §4.9, bot-os.md D123): a view
 * of its instance's store (`ctx.secrets.store`) whose documents are written sealed (`Sealer`) when
 * the `bot_os_key` secret is provided, and in clear (mode 600, as the rest of the store) when it is
 * not, so that a fresh install without the key still logs in, the node saying its credentials sit in
 * clear. A document kept in clear is sealed as soon as it is read with the key provided. A sealed
 * document that does not open (no key, or another key) reads as none, so the connector needs a
 * login, and why is kept for its login's state; every string opened is remembered as a secret.
 */
import { isSealed, type Sealer, SealError } from './secrets.ts';
import { type Store } from './store.ts';

/** Where a connector's kept credentials stand at rest. */
export interface SealedState {
  /** They are sealed: the key is provided. */
  sealed: boolean;
  /** Why a sealed document did not open, if one did not. */
  unreadable?: string;
}

export class SealedStore implements Store {
  private readonly base: Store;
  private readonly sealer: Sealer | undefined;
  private readonly scope: string;
  private readonly warn: (line: string) => void;
  private unreadable: string | undefined;

  constructor(o: {
    base: Store;
    sealer: Sealer | undefined;
    /** What the sealed values belong to (the instance's id): their additional data. */
    scope: string;
    warn: (line: string) => void;
  }) {
    this.base = o.base;
    this.sealer = o.sealer;
    this.scope = o.scope;
    this.warn = o.warn;
  }

  /** Whether what it writes is sealed, and why a document did not open. */
  state(): SealedState {
    return {
      sealed: this.sealer?.available === true,
      ...(this.unreadable === undefined ? {} : { unreadable: this.unreadable }),
    };
  }

  private context(name: string): string {
    return `${this.scope}/${name}`;
  }

  read<T = unknown>(name: string): T | undefined {
    const v = this.base.read(name);
    if (v === undefined) return undefined;
    if (isSealed(v)) {
      try {
        return (this.sealer as Sealer).open(v, this.context(name)) as T;
      } catch (e) {
        if (!(e instanceof SealError) && this.sealer !== undefined) throw e;
        const why = e instanceof SealError ? e.message : 'there is no key to open it';
        if (this.unreadable === undefined) this.warn(`its kept ${name} does not open: ${why}`);
        this.unreadable = why;
        return undefined;
      }
    }
    this.sealer?.rememberAll(v);
    // Kept in clear before the key was provided: sealed now.
    if (this.sealer?.available === true)
      this.base.write(name, this.sealer.seal(v, this.context(name)));
    return v as T;
  }

  write(name: string, value: unknown): void {
    this.unreadable = undefined;
    this.sealer?.rememberAll(value);
    if (this.sealer?.available === true)
      this.base.write(name, this.sealer.seal(value, this.context(name)));
    else this.base.write(name, value);
  }

  remove(name: string): void {
    this.unreadable = undefined;
    this.base.remove(name);
  }

  names(): string[] {
    return this.base.names();
  }
}
