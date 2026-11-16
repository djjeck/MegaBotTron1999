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

  /**
   * The names of the secrets provided (their files), never their values: what a connector's config
   * may name (§4.9), for the editor's choice.
   */
  names(): string[] {
    try {
      return fs
        .readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => !d.isDirectory() && NAME.test(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
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

/** The mark of a sealed value (D123): `{ "$sealed": 1, iv, tag, data }`, its JSON encrypted. */
export const SEALED = '$sealed';
export interface Sealed {
  $sealed: 1;
  iv: string;
  tag: string;
  data: string;
}

/** Whether a value is a sealed one, as `Sealer.seal` writes it. */
export const isSealed = (v: unknown): v is Sealed =>
  typeof v === 'object' &&
  v !== null &&
  (v as Record<string, unknown>)[SEALED] === 1 &&
  typeof (v as Record<string, unknown>)['iv'] === 'string' &&
  typeof (v as Record<string, unknown>)['tag'] === 'string' &&
  typeof (v as Record<string, unknown>)['data'] === 'string';

/** A sealed value that cannot be opened: no key, or not the key it was sealed with. */
export class SealError extends Error {}

/**
 * Values sealed at rest (bot-os.md D123): a connector's kept credentials, a sensitive config field
 * in the graph's file. AES-256-GCM under keys derived (HKDF-SHA256) from the `bot_os_key` Docker
 * secret, with what the value is (`context`: its store and document, its node's config key) as
 * additional data, so that a sealed value moved elsewhere does not open. The IV is derived from the
 * context and the value (an HMAC, as SIV does), so one value seals the same each time: a graph
 * sealed twice is the same graph, and only equal values are seen equal.
 */
export class Sealer {
  private readonly secrets: Secrets;

  constructor(secrets: Secrets) {
    this.secrets = secrets;
  }

  /** Whether values can be sealed and opened: the key is provided. */
  get available(): boolean {
    return this.secrets.has(KEY_SECRET);
  }

  /** `value` (any JSON) sealed; throws without the key. */
  seal(value: unknown, context: string): Sealed {
    const { enc, iv: ivKey } = this.keys();
    const json = JSON.stringify(value);
    const iv = crypto
      .createHmac('sha256', ivKey)
      .update(`${context}\u0000${json}`)
      .digest()
      .subarray(0, 12);
    const cipher = crypto.createCipheriv('aes-256-gcm', enc, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    return {
      $sealed: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  }

  /** A sealed value opened, its strings remembered as secrets; a SealError if it cannot be. */
  open(sealed: Sealed, context: string): unknown {
    if (!this.available)
      throw new SealError(
        `it is sealed and there is no ${KEY_SECRET} secret to open it: provide the key it was sealed with, or set it again`
      );
    let value: unknown;
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.keys().enc,
        Buffer.from(sealed.iv, 'base64')
      );
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      const json = Buffer.concat([
        decipher.update(Buffer.from(sealed.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      value = JSON.parse(json) as unknown;
    } catch {
      throw new SealError(
        `it does not open with this ${KEY_SECRET}: the key changed since it was sealed (or it was moved); provide that key, or set it again`
      );
    }
    this.rememberAll(value);
    return value;
  }

  /** Every string in a value remembered as a secret, to be redacted. */
  rememberAll(value: unknown): void {
    if (typeof value === 'string') this.secrets.remember(value);
    else if (Array.isArray(value)) for (const v of value) this.rememberAll(v);
    else if (typeof value === 'object' && value !== null)
      for (const v of Object.values(value)) this.rememberAll(v);
  }

  private keys(): { enc: Buffer; iv: Buffer } {
    const material = this.secrets.read(KEY_SECRET);
    if (material === undefined)
      throw new Error(`no ${KEY_SECRET} secret: nothing is sealed without its key`);
    const derive = (info: string): Buffer =>
      Buffer.from(crypto.hkdfSync('sha256', material, Buffer.alloc(0), info, 32));
    return { enc: derive('bot-os sealed v1'), iv: derive('bot-os sealed v1 iv') };
  }
}
