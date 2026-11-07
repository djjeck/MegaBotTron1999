/**
 * Secrets, kept the standard way (docs/bot-os-api.md §4.9, P9, D10).
 *
 * - They come in as Docker secrets: one file each under `/run/secrets` (`dir`), named as the
 *   compose file names them (`znc_password`), read once. Never from an environment variable,
 *   which shows in `docker inspect` and in the process's environment.
 * - Every value read is remembered, so that `redact` takes it out of any text: what the core logs,
 *   records, notifies and throws, and what the wiring prints.
 * - Secrets the core stores itself (a login done later through the UI) are encrypted at rest,
 *   AES-256-GCM with Node's `crypto`, under a key derived (HKDF-SHA256) from a key that also comes
 *   in as a Docker secret (`bot_os_key`); each in a file of mode 600, readable only by the user the
 *   instance runs as (`node`, in the image).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REDACTED = '[redacted]';
/** The Docker secret the key of the secrets stored at rest is derived from. */
export const KEY_SECRET = 'bot_os_key';
/** A secret's name, as Docker names its file. */
const NAME = /^[a-z][a-z0-9_]*$/u;

export class Secrets {
  readonly dir: string;
  private readonly values = new Map<string, string>();
  /** The values read, longest first, for `redact`. */
  private known: string[] = [];

  constructor(dir = '/run/secrets') {
    this.dir = dir;
  }

  /** Whether the secret is provided (its file exists), without reading it. */
  has(name: string): boolean {
    return NAME.test(name) && fs.existsSync(path.join(this.dir, name));
  }

  /** A secret's value, its trailing newline dropped; undefined if it is not provided. */
  read(name: string): string | undefined {
    if (!NAME.test(name)) throw new Error(`not a secret's name: ${JSON.stringify(name)}`);
    const cached = this.values.get(name);
    if (cached !== undefined) return cached;
    let value: string;
    try {
      value = fs.readFileSync(path.join(this.dir, name), 'utf8').replace(/\r?\n$/u, '');
    } catch {
      return undefined;
    }
    this.remember(value);
    this.values.set(name, value);
    return value;
  }

  /** Takes every secret value read out of `text`. */
  redact(text: string): string {
    let out = text;
    for (const v of this.known) out = out.split(v).join(REDACTED);
    return out;
  }

  /** Every string in `value`, however deep, redacted: a record before it is logged. */
  redactDeep<T>(value: T): T {
    if (this.known.length === 0) return value;
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v: unknown) => this.redactDeep(v)) as T;
    if (typeof value === 'object' && value !== null)
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.redactDeep(v)])
      ) as T;
    return value;
  }

  /** A value that is a secret, though no file held it (one the core stored): redacted too. */
  remember(value: string): void {
    // Too short, or only digits (Telegram's API id), to redact without mangling ordinary text: the
    // number would vanish from every message that holds it, and is no secret worth the name.
    if (value.length < 6 || /^\d+$/u.test(value) || this.known.includes(value)) return;
    this.known = [...this.known, value].sort((a, b) => b.length - a.length);
  }
}

/** The core's own secrets, encrypted at rest, in a directory of its store. */
export class SecretStore {
  private readonly dir: string;
  private readonly secrets: Secrets;

  constructor(dir: string, secrets: Secrets) {
    this.dir = dir;
    this.secrets = secrets;
  }

  /** Whether secrets can be stored: the key is provided. */
  get available(): boolean {
    return this.secrets.has(KEY_SECRET);
  }

  /** Stores a secret, encrypted; throws without the key. */
  put(name: string, value: string): void {
    if (!NAME.test(name)) throw new Error(`not a secret's name: ${JSON.stringify(name)}`);
    const key = this.key();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(name));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const sealed = {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${name}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(sealed)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.secrets.remember(value);
  }

  /** A stored secret, decrypted; undefined if none is stored. Throws without the key, or if tampered. */
  get(name: string): string | undefined {
    if (!NAME.test(name)) throw new Error(`not a secret's name: ${JSON.stringify(name)}`);
    let sealed: { iv: string; tag: string; data: string };
    try {
      sealed = JSON.parse(
        fs.readFileSync(path.join(this.dir, `${name}.json`), 'utf8')
      ) as typeof sealed;
    } catch {
      return undefined;
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(sealed.iv, 'base64')
    );
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const value = Buffer.concat([
      decipher.update(Buffer.from(sealed.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    this.secrets.remember(value);
    return value;
  }

  /** Forgets a stored secret. */
  remove(name: string): void {
    if (!NAME.test(name)) throw new Error(`not a secret's name: ${JSON.stringify(name)}`);
    fs.rmSync(path.join(this.dir, `${name}.json`), { force: true });
  }

  private key(): Buffer {
    const material = this.secrets.read(KEY_SECRET);
    if (material === undefined)
      throw new Error(`no ${KEY_SECRET} secret: the core stores no secret without its key`);
    return Buffer.from(
      crypto.hkdfSync('sha256', material, Buffer.alloc(0), 'bot-os secret store v1', 32)
    );
  }
}
