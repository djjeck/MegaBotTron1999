/**
 * The development kit (docs/bot-os-api.md §4.10, P15): what any plugin runs against outside an
 * instance, in tests and in simulators.
 *
 * - `FakeConnector`, with its plugin (`fakeConnectorPlugin`): a connector of any network whose
 *   messages are said by the test or the simulator (`hear`) and whose sends go to it (`onSend`),
 *   with the account's limits, so that the plugins read and send through it as they do live; the
 *   photos sent too (bot-os.md D150), with their caption and the message they answer; and the
 *   photos of its messages, as the test gives them, which its plugin's action `photo` fetches
 *   (D151).
 * - `fakeMedia` and `assertMedia`: a `Media` (bot-os.md D153) made up for a test, its bytes the
 *   type it says; and a value checked to be one, within limits.
 * - `DevKit`: a core on a virtual clock (packages/core/src/clock.ts), its stores in memory, their
 *   files (`ctx.store.files`) too,
 *   with the plugins given, their configuration, the owner's kept settings, and the
 *   documents and files their stores start with: the state of a run, set before it starts.
 * - `defineSimulator`: a simulator plugin, a model of a game that runs other plugins on the kit
 *   (bot-os.md D13). It is not registered in an instance: its manifest says what it is and what it
 *   plays, and its `run` plays one run.
 *
 * Nothing in here knows of any game.
 */
import { type Clock, VirtualClock } from './clock.ts';
import { type Buttons, type CommandPhoto } from './commands.ts';
import {
  type Connector,
  ConnectorBase,
  type ConnectorPhotoOptions,
  type ConnectorSendOptions,
  type Inbound,
  type Surface,
  type SurfaceQuery,
} from './connector.ts';
import { Core, type CoreOptions } from './core.ts';
import { type LogEntry, MemoryEventLog } from './event-log.ts';
import { type Manifest, ManifestError, type ManifestInput, parseManifest } from './manifest.ts';
import { type Media, type MediaLimits, mediaRefusal } from './media.ts';
import { PHOTO_ACTION, photoAction } from './message-photo.ts';
import { type Limits, type TextFormat } from './outbox.ts';
import { definePlugin, type Plugin } from './plugin.ts';

/** The first bytes of each type `fakeMedia` makes as its own (D153): what `sniffMime` reads. */
const MAGIC: Readonly<Record<string, readonly number[]>> = {
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/gif': [...'GIF89a'].map((c) => c.charCodeAt(0)),
  'image/webp': [...'RIFF\0\0\0\0WEBPVP8 '].map((c) => c.charCodeAt(0)),
  'application/pdf': [...'%PDF-1.7\n'].map((c) => c.charCodeAt(0)),
};

/**
 * A `Media` made up for a test (bot-os.md D153): `mime` (a PNG by default), its bytes starting as
 * that type's do where `sniffMime` reads it, so that `mediaMismatch` passes it, padded with zeros
 * to `size` bytes (64 by default), with the `width` and `height` given. Not a picture any decoder
 * would draw: a test of a plugin that passes media, not of an image library.
 */
export function fakeMedia(
  mime = 'image/png',
  o: { size?: number; width?: number; height?: number } = {}
): Media {
  const head = MAGIC[mime] ?? [];
  const data = new Uint8Array(Math.max(o.size ?? 64, head.length));
  data.set(head);
  return {
    data,
    mime,
    ...(o.width === undefined ? {} : { width: o.width }),
    ...(o.height === undefined ? {} : { height: o.height }),
  };
}

/**
 * `value` as a `Media` (D153), checked as `mediaRefusal` checks it (its shape, its bytes the type it
 * says, within `limits`); throws with why when it is not one.
 */
export function assertMedia(value: unknown, limits?: MediaLimits): Media {
  const why = mediaRefusal(value, limits);
  if (why !== undefined) throw new Error(`not a media: ${why}`);
  return value as Media;
}

export interface FakeConnectorOptions {
  /** Its account, `<network>:<name>`: the network is the part before the colon. */
  account: string;
  /** Its own name on the network; the account's name by default. */
  self?: string;
  /** The account's limits, which its outbox keeps to; none, no rate limit. */
  limits?: Limits;
  /**
   * Where a send goes; true if it went (the default: every send goes). A photo's comes with its
   * caption (`''` without one); false refuses it, as the network would.
   */
  onSend?: (chat: string, text: string) => boolean;
  /** It cannot send photos, as IRC's (bot-os.md D150): it has no `deliverPhoto`. */
  noPhotos?: boolean;
  /** The chats the account administers (`isAdmin`). */
  admins?: readonly string[];
  /** The chats it can see (`surfaces`), in order; none: it cannot list them. */
  surfaces?: readonly Surface[];
  /** The owner's own chat (`owner()`), as a `telegram-bot`'s; none: it has no owner. */
  owner?: string;
  /**
   * The photos of its messages (bot-os.md D151): given, even none, it fetches them (`photo`), and
   * its plugin offers the action `photo`; a message not given has none (`null`). More are given
   * with `givePhoto`.
   */
  photos?: readonly FakePhoto[];
}

/**
 * A message's photo a fake connector answers `photo` with (D151): the photo, or why it cannot fetch
 * it (a string), which the action answers as its `error`.
 */
export interface FakePhoto {
  chat: string;
  message: string;
  photo: Media | string;
}

/** A message the connector hears: its account and network are the connector's. */
export type Heard = Omit<Inbound, 'account' | 'network' | 'playback'> & { playback?: boolean };

/**
 * A send the fake connector made: its text, with the buttons it carried (`SendOptions.buttons`);
 * or a photo (bot-os.md D150), `text` its caption (`''` without one), with its `format`, the
 * message it answers (`replyTo`), and the id it was given (`id`, `'photo-<n>'` for bytes, the id
 * it was sent by otherwise).
 */
export interface FakeSent {
  chat: string;
  text: string;
  buttons?: Buttons;
  photo?: CommandPhoto;
  format?: TextFormat;
  replyTo?: string;
  id?: string;
}

/** A connector of any network, driven by a test or a simulator. */
export class FakeConnector extends ConnectorBase implements Connector {
  /** Every send, in order, photos among them. */
  readonly sent: FakeSent[] = [];
  /**
   * Sends a photo (bot-os.md D150): kept in `sent`; the message's id and the photo's. Absent when
   * the test says it has none (`noPhotos`).
   */
  readonly deliverPhoto?: (
    chat: string,
    photo: CommandPhoto,
    options?: ConnectorPhotoOptions
  ) => Promise<{ id?: string; photo?: string }>;
  private photos = 0;
  private readonly onSend: ((chat: string, text: string) => boolean) | undefined;
  private readonly admins: readonly string[];
  /** Its surfaces, as a test sets them; undefined: none (it cannot list them). */
  readonly surfaces?: (query?: SurfaceQuery) => Promise<Surface[]>;
  private readonly ownerChat: string | undefined;
  /** The photos given, by `<chat> <message>`; undefined: it fetches none. */
  private readonly given: Map<string, Media | string> | undefined;
  /**
   * Fetches a message's photo (D151), as given (`photos`, `givePhoto`): null for a message not
   * given one, a rejection for a why. Absent when the test gave it no `photos`.
   */
  readonly photo?: (chat: string, message: string) => Promise<Media | null>;

  constructor(o: FakeConnectorOptions) {
    const colon = o.account.indexOf(':');
    if (colon <= 0) throw new Error(`not an account: ${o.account} (expected <network>:<name>)`);
    super(o.account, o.account.slice(0, colon));
    this.named(o.self ?? o.account.slice(colon + 1));
    if (o.limits !== undefined) this.limits = o.limits;
    this.onSend = o.onSend;
    this.admins = o.admins ?? [];
    this.ownerChat = o.owner;
    if (o.noPhotos !== true)
      this.deliverPhoto = (chat, photo, options = {}) => {
        const text = options.caption ?? '';
        if (!(this.onSend?.(chat, text) ?? true)) return Promise.reject(new Error('not sent'));
        const n = ++this.photos;
        const id = typeof photo === 'string' ? photo : `photo-${n}`;
        this.sent.push({
          chat,
          text,
          photo,
          ...(options.format === undefined ? {} : { format: options.format }),
          ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
          id,
        });
        return Promise.resolve({ id: `m${n}`, photo: id });
      };
    if (o.photos !== undefined) {
      const given = new Map(o.photos.map((p) => [`${p.chat} ${p.message}`, p.photo]));
      this.given = given;
      this.photo = (chat, message) => {
        const p = given.get(`${chat} ${message}`);
        if (typeof p === 'string') return Promise.reject(new Error(p));
        return Promise.resolve(p ?? null);
      };
    }
    const listed = o.surfaces;
    if (listed !== undefined)
      this.surfaces = (q = {}) => {
        if (this.status().state !== 'connected') return Promise.reject(new Error('not connected'));
        const search = q.search?.toLowerCase() ?? '';
        return Promise.resolve(
          listed
            .filter((x) => x.title.toLowerCase().includes(search) || x.id.includes(search))
            .slice(0, q.limit ?? listed.length)
        );
      };
  }

  /**
   * Gives message `message` of `chat` a photo, or a why for `photo` to refuse it with (D151).
   * Throws for a fake made without `photos`, which fetches none.
   */
  givePhoto(chat: string, message: string, photo: Media | string): void {
    if (this.given === undefined) throw new Error(`${this.account} was made without photos`);
    this.given.set(`${chat} ${message}`, photo);
  }

  /** The owner's own chat, as the test gave it. */
  owner(): string | undefined {
    return this.ownerChat;
  }

  /** Whether the account administers `chat`: one of `admins`. */
  isAdmin(chat: string): Promise<boolean> {
    return Promise.resolve(this.admins.includes(chat));
  }

  /** Connected, at the network's step `phase` (IRC's `joined`). */
  open(phase = 'connected'): void {
    this.changed({ state: 'connected', phase });
  }

  /** On its way to connect (again), at the network's step `phase`: a queued send waits (D108). */
  connecting(phase = 'connecting'): void {
    this.changed({ state: 'connecting', phase });
  }

  /** Closed, with why. */
  close(detail?: string): void {
    this.changed({ state: 'closed', phase: 'closed', ...(detail === undefined ? {} : { detail }) });
  }

  /** A message said on the network, live unless `playback`. */
  hear(m: Heard): void {
    this.received({ ...m, playback: m.playback ?? false });
  }

  /**
   * An edit of a message said on the network (D144): `id` the message's, `text` its text now,
   * `edited` when (now, by default, on the clock of the test).
   */
  hearEdit(m: Heard & { edited?: number }): void {
    this.reread({ ...m, playback: m.playback ?? false, edited: m.edited ?? m.time });
  }

  send(chat: string, text: string, options?: ConnectorSendOptions): boolean {
    this.sent.push({
      chat,
      text,
      ...(options?.buttons === undefined ? {} : { buttons: options.buttons }),
    });
    return this.onSend?.(chat, text) ?? true;
  }
}

/**
 * The connector plugin `id` on a fake connector, for a kit's plugins to require and reach; with
 * the action `photo` on its interface when the connector fetches photos (`photos`, D151), as a
 * Telegram connector's.
 */
export function fakeConnectorPlugin(id: string, connector: FakeConnector): Plugin {
  const photos = connector.photo !== undefined;
  return definePlugin({
    manifest: {
      id,
      version: '0.1.0',
      kinds: ['connector'],
      description: `A fake connector of ${connector.account}, driven by a test or a simulator`,
      account: connector.account,
      ...(photos ? { interface: { actions: { photo: PHOTO_ACTION } } } : {}),
    },
    create: () => ({
      connector,
      ...(photos ? { interface: { actions: { photo: photoAction(connector) } } } : {}),
    }),
  });
}

export interface DevKitOptions {
  /** The virtual clock's start, in milliseconds. */
  start?: number;
  /**
   * The plugins of the run, connectors included, in registration order; or registered on `core`
   * before `start`, for plugins made with the kit's core in hand.
   */
  plugins?: readonly Plugin[];
  /**
   * The run's graph (`CoreOptions.graph`, §2.1): the plugin instances and their edges; by default,
   * one instance of each plugin, bound as the manifests say; or a function of that default.
   */
  graph?: CoreOptions['graph'];
  /** Each plugin instance's configuration, by instance id (`CoreOptions.config`). */
  config?: Record<string, unknown>;
  /**
   * The owner's settings, kept before the start, by plugin instance and key, in their text form or
   * value.
   */
  settings?: Record<string, Record<string, unknown>>;
  /** The documents each plugin instance's store starts with, by instance id and name. */
  documents?: Record<string, Record<string, unknown>>;
  /**
   * The files each plugin instance's store starts with (D149), by instance id and name, each its
   * bytes and its type (a `Media`): a collection's pictures (D155, `collectionSeed` of
   * `@megabottron1999/turns`), a state's.
   */
  files?: Record<string, Record<string, Media>>;
  /**
   * How much each instance's files may take (`CoreOptions.fileLimits`); kept in memory, as the
   * documents are.
   */
  fileLimits?: CoreOptions['fileLimits'];
  /** Where the core's records and every event published go, beside the kit's own log (`log`). */
  record?: CoreOptions['record'];
  /**
   * The event log as it was before the run, for the plugins that read their history
   * (`ctx.events`): the kit's log starts with it, and keeps every record of the run after it.
   */
  history?: readonly LogEntry[];
  /** Where log lines go; nowhere by default. */
  print?: (line: string) => void;
  /** Whether events are checked against their schemas (by default, outside production). */
  validateEvents?: boolean;
  /** Whether an archived plugin may run (`CoreOptions.allowArchived`): off unless said. */
  allowArchived?: boolean;
  /** The release and commit the run says it is (`CoreOptions.build`), for a start notice. */
  build?: CoreOptions['build'];
}

/** A core on a virtual clock, with the state of a run set before it starts. */
export class DevKit {
  readonly clock: VirtualClock;
  readonly core: Core;
  /** The run's event log, in memory: its history, then every record of the run. */
  readonly log: MemoryEventLog;
  private readonly o: DevKitOptions;

  constructor(o: DevKitOptions) {
    this.o = o;
    this.clock = new VirtualClock(o.start ?? 0);
    const log = new MemoryEventLog(o.history);
    this.log = log;
    this.core = new Core({
      events: log,
      record: (r) => {
        const at = log.write(r);
        o.record?.(r);
        return at;
      },
      clock: this.clock as Clock,
      ...(o.config === undefined ? {} : { config: o.config }),
      ...(o.graph === undefined ? {} : { graph: o.graph }),
      ...(o.documents === undefined ? {} : { documents: o.documents }),
      ...(o.files === undefined ? {} : { files: o.files }),
      ...(o.fileLimits === undefined ? {} : { fileLimits: o.fileLimits }),
      ...(o.print === undefined ? {} : { print: o.print }),
      ...(o.validateEvents === undefined ? {} : { validateEvents: o.validateEvents }),
      ...(o.allowArchived === undefined ? {} : { allowArchived: o.allowArchived }),
      ...(o.build === undefined ? {} : { build: o.build }),
    });
    this.core.register(...(o.plugins ?? []));
  }

  /**
   * Keeps the settings given, as the owner's, and starts every plugin. Throws for a
   * setting refused, and for a plugin that failed: a run without one of its plugins is no run.
   */
  async start(): Promise<void> {
    this.core.load();
    for (const [plugin, values] of Object.entries(this.o.settings ?? {}))
      for (const [key, value] of Object.entries(values)) {
        const why = this.core.settings.set(`${plugin}.${key}`, value);
        if (why !== undefined) throw new Error(`dev kit: setting ${plugin}.${key}: ${why}`);
      }
    await this.core.start();
    const failed = this.core.status().filter((s) => s.state === 'failed');
    if (failed.length > 0)
      throw new Error(
        `dev kit: ${failed.map((s) => `${s.id} failed (${s.reason ?? '?'})`).join('; ')}`
      );
  }

  /** Runs the clock to `t`, every timer due on the way at its own time. */
  runUntil(t: number): void {
    this.clock.advanceTo(t);
  }

  stop(): Promise<void> {
    return this.core.stop();
  }
}

/** A simulator: its manifest (kind `simulator`), and how it plays one run. */
export interface Simulator<Run, Options, Result> {
  readonly manifest: Manifest;
  run(run: Run, options: Options): Promise<Result>;
}

/** A simulator plugin, its manifest checked: a ManifestError if bad, or not of kind `simulator`. */
export function defineSimulator<Run, Options, Result>(s: {
  manifest: ManifestInput;
  run: (run: Run, options: Options) => Promise<Result>;
}): Simulator<Run, Options, Result> {
  const manifest = parseManifest(s.manifest);
  if (!manifest.kinds.includes('simulator'))
    throw new ManifestError(`plugin ${manifest.id}: a simulator's kinds include simulator`);
  return { manifest, run: s.run };
}
