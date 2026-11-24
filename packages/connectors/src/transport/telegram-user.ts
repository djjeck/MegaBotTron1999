/**
 * A Telegram user account, logged in as a user session with GramJS as a connector of the core
 * (docs/bot-os-api.md §4.5): the owner's own account, for parsers and players that read and
 * play in its chats.
 *
 * It monitors the chats it is given and no other (a group by its id, `-100…`; a private chat by the
 * other's `@username`, or by their id when they have none), or, given none, every chat the account
 * has. Its surfaces (bot-os.md D63) list the chats of the account active in the last week (and
 * those it is given), monitored or not, so that the owner can pick new ones, and a search finds any
 * of them. The account sees every chat of its owner, and the rest never leaves
 * this module. It sends any text to those chats, but only through the account's outbox,
 * which keeps each plugin to the chats and commands of its reach (§4.6).
 *
 * **Catch-up** (docs/bot-os.md D62, D66): GramJS 2.26.22 has no update catch-up (`client.catchUp()`
 * is an empty stub, and its sessions keep no update state), so at each connection it fetches back
 * the history of the chats its running readers read that it has not accounted for (its ledger, kept
 * in its store: `seen-ledger.ts`), at most `CATCH_UP_CAP` per chat, a page at a time, and delivers
 * it oldest first, marked `missed` and `playback`. Each message reaches the readers at most once,
 * across live delivery, catch-up and restarts; a gap whose fetch failed is fetched again, later in
 * the connection and at the next one, until it is filled. A chat no running reader reads is not
 * fetched: its gap is skipped, and what is heard there live is accounted for all the same.
 *
 * **A GramJS workaround: gaps found by id** (docs/bot-os.md D147). GramJS 2.26.22 keeps no update
 * state while connected either: an update Telegram does not push (it does not promise every one of
 * a supergroup's to a user session) is lost, silently. A supergroup's (or a channel's) message ids
 * grow by one per message, so a live message more than one past the last id known of its chat shows
 * a gap: the ids between are fetched, a second later (a **look**), and delivered as caught up
 * (`missed`, news within their grace). A send to such a chat is looked after twice
 * (`LOOK_AFTER_SEND_MS`), so that the answer to it is recovered within seconds when it is the
 * chat's last message, where no later one would show the gap. Its ledger accounts in those chats
 * only for the ids seen, never for a range assumed to have come live, so that a gap no look filled
 * is fetched at the next connection. To revisit when GramJS keeps update state (`catchUp`).
 *
 * **A message's photo** (D151): fetched on demand, by the message's id in its chat, its photo's
 * largest size downloaded (`photo`); never with the message.
 *
 * **The raw log** (D147): the last 8 hours of what it heard, fetched, sent and found missing, raw,
 * in its store (`raw-log.ts`), for debugging.
 *
 * The session string gives full access to the account: it comes from the connector's store (a login
 * from its node, `user-login.ts`, D116) or the deployment's secrets,
 * never from this repository, and is never printed by this module.
 */
import {
  type Clock,
  type CommandPhoto,
  type Connector,
  ConnectorBase,
  type ConnectorPhotoOptions,
  FloodWait,
  type Inbound,
  type InboundDocument,
  type InboundMedia,
  LIVE_GRACE_S,
  type Media,
  NEEDS_LOGIN,
  photoFilename,
  photoTooLarge,
  readDocument,
  type ReadFilter,
  sniffMime,
  type Surface,
  type SurfaceQuery,
  type TimerHandle,
} from '@megabottron1999/core';
import { markdownToTelegramHtml } from 'grammy-switchboard';
import { Api, TelegramClient } from 'telegram';
import { CustomFile } from 'telegram/client/uploads.js';
import { DeletedMessage } from 'telegram/events/DeletedMessage.js';
import { EditedMessage } from 'telegram/events/EditedMessage.js';
import { NewMessage } from 'telegram/events/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { returnBigInt } from 'telegram/Helpers.js';
import { StringSession } from 'telegram/sessions/index.js';
import { RawLog } from './raw-log.ts';
import { LAST_SEEN_DOC, type LedgerStore, SEEN_ABOVE_DOC, SeenLedger } from './seen-ledger.ts';

export { LAST_SEEN_DOC, SEEN_ABOVE_DOC };

/** The fields of a GramJS message the connector reads. */
export interface RawMessage {
  id: number;
  /** In seconds. */
  date: number;
  /** When it was last edited, in seconds; none if never. */
  editDate?: number | undefined;
  /**
   * The buttons a bot set under it (GramJS's `replyMarkup`, a union: an inline keyboard has `rows`
   * of `buttons`, each with its `text`), read defensively.
   */
  replyMarkup?: unknown;
  out?: boolean | undefined;
  message: string;
  replyTo?: { replyToMsgId?: number | undefined } | undefined;
  chatId?: { toString(): string } | undefined;
  /** A private chat (with a user or a bot), not a group. */
  isPrivate?: boolean | undefined;
  /** The file it carries (GramJS's `Message.document`): a sticker, a voice note, a text file… */
  document?:
    | {
        mimeType?: string | undefined;
        /** In bytes (a `BigInteger` in GramJS). */
        size?: number | { toString(): string } | undefined;
        /** Its file name is a `DocumentAttributeFilename`'s `fileName`. */
        attributes?: readonly unknown[] | undefined;
      }
    | undefined;
  /**
   * Its media (GramJS's `Message.media`): a photo's is a `MessageMediaPhoto`, its `photo` an
   * `Api.Photo` whose `sizes` are each a `PhotoSize`, a `PhotoSizeProgressive`, a
   * `PhotoCachedSize`…; read defensively, and only by `photo` (D151).
   */
  media?: unknown;
  getSender(): Promise<unknown>;
  getChat(): Promise<unknown>;
}

/**
 * The fields of a GramJS deletion the connector reads (`DeletedMessageEvent`): the ids, and the
 * chat, a `PeerChannel`, only for a supergroup's or a channel's (a basic group's and a private
 * chat's carry ids alone).
 */
export interface RawDeletion {
  deletedIds: number[];
  peer?: unknown;
}

/** The fields of a GramJS dialog the connector reads: one chat of the account. */
export interface RawDialog {
  /** The chat's id, marked (`-100…` for a group or a channel). */
  id?: { toString(): string } | undefined;
  title?: string | undefined;
  /** When its latest message was sent, in seconds. */
  date?: number | undefined;
  /** Its folder: 1 for the archive (GramJS's `Dialog.folderId`); custom folders are not folders. */
  folderId?: number | undefined;
  isUser?: boolean | undefined;
  isGroup?: boolean | undefined;
  isChannel?: boolean | undefined;
  /** The other user (a bot has `bot`; the account itself, `self`), the group or the channel. */
  entity?: unknown;
  inputEntity?: unknown;
  /** Its latest message. */
  message?: { id: number } | undefined;
}

/** The part of GramJS's `TelegramClient` the connector uses; tests pass a fake. */
export interface GramClient {
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  /**
   * The account's chats, latest first (and fills the entity cache, so a group's id resolves). No
   * `ignoreMigrated`: GramJS's filter keeps the chats it should drop (only basic groups have a
   * `migratedTo`), so the connector drops a migrated group itself (`migrated`).
   */
  getDialogs(params: { limit?: number }): Promise<Iterable<RawDialog>>;
  getInputEntity(id: number | string): Promise<unknown>;
  /** The logged-in user. */
  getMe(): Promise<unknown>;
  /** The message sent: its id, and its chat's marked id (GramJS's `Message.chatId`). */
  sendMessage(
    entity: never,
    params: { message: string }
  ): Promise<{ id: number; chatId?: { toString(): string } | undefined }>;
  /** A file's bytes uploaded (a photo's, D150): the handle a media message sends it by. */
  uploadFile(params: { file: CustomFile; workers: number }): Promise<Api.TypeInputFile>;
  /** A media message sent (a photo, D150): as `sendMessage` answers, with its media. */
  sendFile(
    entity: never,
    params: {
      file: Api.TypeInputMedia;
      caption: string;
      parseMode: false | 'html';
      replyTo?: number;
    }
  ): Promise<{ id: number; chatId?: { toString(): string } | undefined; media?: unknown }>;
  /**
   * A chat's messages, latest first: below `offsetId` (0: from the latest), above `minId`; or those
   * of the `ids` given, each undefined (or a `MessageEmpty`) where there is none (D151), whatever
   * GramJS's type says.
   */
  getMessages(
    entity: never,
    params: { limit: number; offsetId: number; minId: number } | { ids: number[] }
  ): Promise<Iterable<RawMessage>>;
  addEventHandler(
    handler: (event: { message: RawMessage }) => Promise<void>,
    builder: NewMessage
  ): void;
  /** Deletions (D158): the ids, and the chat for a supergroup's or a channel's alone. */
  addEventHandler(handler: (event: RawDeletion) => Promise<void>, builder: DeletedMessage): void;
  /** A message's file, downloaded whole (a `Buffer`); a photo's size `thumb` (D151). */
  downloadMedia(message: never, params: { thumb?: never }): Promise<unknown>;
  /** A raw request: the logout (`auth.logOut`). */
  invoke?(request: Api.auth.LogOut): Promise<unknown>;
}

/** A field of an entity GramJS returned, if it has one. */
function field(
  entity: unknown,
  key: 'username' | 'bot' | 'migratedTo' | 'self' | 'firstName' | 'lastName' | 'title'
): unknown {
  if (typeof entity !== 'object' || entity === null || !(key in entity)) return undefined;
  return (entity as Record<string, unknown>)[key];
}

/** The username of an entity GramJS returned (a user, a bot, a channel posting as itself). */
function username(entity: unknown): string | undefined {
  const u = field(entity, 'username');
  return typeof u === 'string' ? u : undefined;
}

/**
 * A sender's display name and whether it is a bot (D159): a user's first and last names, a
 * channel's (or a group's, posting as itself) title; nothing for a sender GramJS did not give.
 */
function senderOf(entity: unknown): { senderName?: string; senderBot?: boolean } {
  if (typeof entity !== 'object' || entity === null) return {};
  const text = (key: 'firstName' | 'lastName' | 'title'): string => {
    const v = field(entity, key);
    return typeof v === 'string' ? v : '';
  };
  const name =
    text('title') || [text('firstName'), text('lastName')].filter((n) => n !== '').join(' ');
  return { ...(name === '' ? {} : { senderName: name }), senderBot: field(entity, 'bot') === true };
}

/**
 * The labels of a message's inline buttons, row by row (D145); none when it has no inline keyboard
 * (a reply keyboard, which a bot sets for the person typing, is not a message's).
 */
function buttonsOf(m: RawMessage): { buttons: string[][] } {
  const list = (o: unknown, key: string): unknown[] => {
    const v = typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined;
    return Array.isArray(v) ? v : [];
  };
  const rows = list(m.replyMarkup, 'rows')
    .map((r) =>
      list(r, 'buttons').map((b) => {
        const text = typeof b === 'object' && b !== null ? (b as { text?: unknown }).text : '';
        return typeof text === 'string' ? text : '';
      })
    )
    .filter((r) => r.length > 0);
  return { buttons: rows };
}

/**
 * The id a `telegram-user` gives a photo it sent (bot-os.md D150), to send it again by: Telegram's
 * photo id, its access hash and its file reference (base64url), `<id>:<hash>:<reference>`; none
 * when the message carries no photo.
 */
export function photoId(media: unknown): string | undefined {
  const photo =
    typeof media === 'object' && media !== null ? (media as { photo?: unknown }).photo : undefined;
  if (typeof photo !== 'object' || photo === null) return undefined;
  const p = photo as { id?: unknown; accessHash?: unknown; fileReference?: unknown };
  if (p.id === undefined || p.accessHash === undefined || !(p.fileReference instanceof Uint8Array))
    return undefined;
  return `${String(p.id)}:${String(p.accessHash)}:${Buffer.from(p.fileReference).toString('base64url')}`;
}

/** A photo by the id `photoId` gave it; undefined when the id is not one. */
function inputPhoto(id: string): Api.InputPhoto | undefined {
  const m = /^(-?\d+):(-?\d+):([\w-]*)$/u.exec(id);
  if (m === null) return undefined;
  return new Api.InputPhoto({
    id: returnBigInt(m[1] ?? ''),
    accessHash: returnBigInt(m[2] ?? ''),
    fileReference: Buffer.from(m[3] ?? '', 'base64url'),
  });
}

/** A photo's size, as GramJS gives it, read defensively (D151). */
interface RawPhotoSize {
  className?: string;
  w?: number;
  h?: number;
  size?: number;
  sizes?: number[];
  bytes?: Uint8Array;
}

/**
 * The largest size of a message's photo (D151), with its bytes as Telegram states them: a
 * `PhotoSize`'s `size`, a `PhotoSizeProgressive`'s largest, a `PhotoCachedSize`'s bytes. A
 * stripped or a path size (a blurred preview, an outline) is no picture; none: no photo.
 */
function largestPhotoSize(photo: unknown): { size: RawPhotoSize; bytes: number } | undefined {
  const sizes = (photo as { sizes?: unknown } | null | undefined)?.sizes;
  if (!Array.isArray(sizes)) return undefined;
  let best: { size: RawPhotoSize; bytes: number } | undefined;
  for (const s of sizes as RawPhotoSize[]) {
    if (typeof s !== 'object' || s === null) continue;
    const bytes =
      s.className === 'PhotoSize'
        ? s.size
        : s.className === 'PhotoSizeProgressive'
          ? Math.max(0, ...(s.sizes ?? []))
          : s.className === 'PhotoCachedSize'
            ? s.bytes?.byteLength
            : undefined;
    if (bytes !== undefined && (best === undefined || bytes > best.bytes))
      best = { size: s, bytes };
  }
  return best;
}

/** How long a failed start waits before the next. */
export const RETRY_MS = 60_000;
/** How many of the latest chats the surfaces list without a search. */
export const SURFACES_LIMIT = 50;
/** How recent a chat's last message is for the surfaces to list it without a search. */
export const SURFACES_ACTIVE_MS = 7 * 24 * 3_600_000;
/** The archive's folder id. */
const ARCHIVE_FOLDER = 1;
/** How long the searches reuse the account's full list of chats, fetched once for a run of them. */
export const DIALOGS_TTL_MS = 30_000;

/** How many messages the catch-up fetches back in a chat, at most. */
export const CATCH_UP_CAP = 1000;
/** How many it asks for at a time. */
export const CATCH_UP_PAGE = 100;
/** The pause between two of its requests. */
export const CATCH_UP_PAUSE_MS = 1000;
/** A chat whose catch-up failed is fetched again after `RETRY_MS`, doubled each time, up to this. */
export const CATCH_UP_RETRY_MAX_MS = 3_600_000;
/** How many of each chat's latest ids it remembers having delivered, against a second delivery. */
const RECENT = 200;
/** How long after a gap is found its look comes (D147): the missing updates may still arrive. */
export const GAP_LOOK_MS = 1000;
/** When, after a send to a supergroup, it looks for what came after (D147). */
export const LOOK_AFTER_SEND_MS: readonly number[] = [4000, 15_000];
/** The most messages one look fetches (D147); a larger gap waits for the next connection. */
export const LOOK_LIMIT = 100;

/**
 * Whether a chat's message ids grow by one per message (D147): a supergroup's or a channel's
 * (`-100…`). A private chat's and a basic group's are the account's, shared with its other chats.
 */
const sequential = (key: string): boolean => key.startsWith('-100');

/** The wait GramJS asks for (its `FloodWaitError` and kin carry `seconds`), in ms. */
function floodMs(e: unknown): number | undefined {
  if (!(e instanceof Error) || !('seconds' in e) || typeof e.seconds !== 'number') return undefined;
  return e.seconds * 1000;
}

/** A document's file name, from its attributes; undefined without one. */
function fileName(attributes: readonly unknown[] | undefined): string | undefined {
  for (const a of attributes ?? []) {
    if (typeof a !== 'object' || a === null) continue;
    const { className, fileName: name } = a as { className?: unknown; fileName?: unknown };
    if (className === 'DocumentAttributeFilename' && typeof name === 'string') return name;
  }
  return undefined;
}

/** A GramJS object's class name, read defensively. */
function classOf(o: unknown): string | undefined {
  const c =
    typeof o === 'object' && o !== null ? (o as { className?: unknown }).className : undefined;
  return typeof c === 'string' ? c : undefined;
}

/** A string field, or a `TextWithEntities`'s text (a poll's question and answers); `''` is none. */
function textOf(o: unknown): string | undefined {
  const t = typeof o === 'object' && o !== null && 'text' in o ? (o as { text?: unknown }).text : o;
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : undefined;
}

/** Names joined with a space, those missing left out; undefined when none is there. */
function joined(...names: unknown[]): string | undefined {
  const s = names.map(textOf).filter((n) => n !== undefined);
  return s.length === 0 ? undefined : s.join(' ');
}

/** A document's media, from its attributes (D161): a sticker, a GIF, a video, a voice note… */
function documentMedia(attributes: readonly unknown[] | undefined): InboundMedia {
  const all = attributes ?? [];
  const find = (name: string): Record<string, unknown> | undefined =>
    all.find((a) => classOf(a) === name) as Record<string, unknown> | undefined;
  const sticker = find('DocumentAttributeSticker');
  if (sticker !== undefined) {
    const emoji = textOf(sticker['alt']);
    return { kind: 'sticker', ...(emoji === undefined ? {} : { emoji }) };
  }
  if (find('DocumentAttributeAnimated') !== undefined) return { kind: 'animation' };
  const video = find('DocumentAttributeVideo');
  if (video !== undefined) return { kind: video['roundMessage'] === true ? 'round' : 'video' };
  const audio = find('DocumentAttributeAudio');
  if (audio !== undefined) {
    if (audio['voice'] === true) return { kind: 'voice' };
    const title = joined(audio['performer'], audio['title']);
    return { kind: 'audio', ...(title === undefined ? {} : { title }) };
  }
  return { kind: 'file' };
}

/**
 * What a message carries besides its text (D161), from GramJS's `Message.media`, read
 * defensively: none for a text alone or a link's preview (the link is in the text).
 */
export function mediaOf(m: Pick<RawMessage, 'media' | 'document'>): InboundMedia | undefined {
  const media = m.media as Record<string, unknown> | null | undefined;
  switch (classOf(media)) {
    case undefined:
      return m.document === undefined ? undefined : documentMedia(m.document.attributes);
    case 'MessageMediaEmpty':
    case 'MessageMediaWebPage':
      return undefined;
    case 'MessageMediaPhoto':
      return { kind: 'photo' };
    case 'MessageMediaDocument': {
      const d = (media?.['document'] ?? m.document) as { attributes?: unknown } | undefined;
      return documentMedia(Array.isArray(d?.attributes) ? d.attributes : undefined);
    }
    case 'MessageMediaPoll': {
      const poll = media?.['poll'] as { question?: unknown; answers?: unknown } | undefined;
      const title = textOf(poll?.question);
      const answers = Array.isArray(poll?.answers) ? poll.answers : [];
      const options = answers
        .map((a) => textOf((a as { text?: unknown } | null)?.text))
        .filter((t) => t !== undefined);
      return {
        kind: 'poll',
        ...(title === undefined ? {} : { title }),
        ...(options.length === 0 ? {} : { options }),
      };
    }
    case 'MessageMediaGeo':
    case 'MessageMediaGeoLive':
      return { kind: 'location' };
    case 'MessageMediaVenue': {
      const title = textOf(media?.['title']);
      return { kind: 'venue', ...(title === undefined ? {} : { title }) };
    }
    case 'MessageMediaContact': {
      const title = joined(media?.['firstName'], media?.['lastName']);
      return { kind: 'contact', ...(title === undefined ? {} : { title }) };
    }
    case 'MessageMediaDice': {
      const emoji = textOf(media?.['emoticon']);
      return { kind: 'dice', ...(emoji === undefined ? {} : { emoji }) };
    }
    case 'MessageMediaGame': {
      const title = textOf((media?.['game'] as { title?: unknown } | undefined)?.title);
      return { kind: 'game', ...(title === undefined ? {} : { title }) };
    }
    case 'MessageMediaStory':
      return { kind: 'story' };
    default:
      return { kind: 'other' };
  }
}

/** A message with text (perhaps empty, under a photo), not a service message (a join, a pin). */
function isText(m: object): boolean {
  return typeof (m as { message?: unknown }).message === 'string';
}

/** The kind of a dialog's chat. */
/**
 * Whether a dialog is a basic group upgraded to a supergroup (its `migratedTo` set): left behind,
 * its supergroup a dialog of its own. GramJS's `ignoreMigrated` meant to drop these, but keeps them
 * alone (it tests that the field exists, which only basic groups have), and with them every user,
 * bot, channel and supergroup was gone from the surfaces.
 */
function migrated(d: RawDialog): boolean {
  const to = field(d.entity, 'migratedTo');
  return to !== undefined && to !== null;
}

function kindOf(d: RawDialog): Surface['kind'] {
  if (d.isUser === true) return field(d.entity, 'bot') === true ? 'bot' : 'private';
  return d.isChannel === true && d.isGroup !== true ? 'channel' : 'group';
}

export interface UserConnectorOptions {
  /** `telegram:<name>`. */
  account: string;
  client: GramClient;
  /** The chats it monitors and may send to: a group's id, a private chat by `@username` or by id; none given: every chat it has. */
  chats?: readonly string[] | undefined;
  clock: Clock;
  log: (line: string) => void;
  /** Told of the first failed start (a revoked session needs a login). */
  notify?: (text: string) => void;
  /** Warned of (the plugin's `warn`); `log` without. */
  warn?: (line: string) => void;
  /** Writes to the event log (`ctx.record`): a catch-up that hit its cap. */
  record?: (type: string, fields: Record<string, unknown>) => void;
  /** Where what it delivered of each chat is kept (`LAST_SEEN_DOC`, `SEEN_ABOVE_DOC`). */
  store?: LedgerStore;
  /**
   * What its running readers read (`ctx.readers`): the chats the catch-up fetches. None: no
   * catch-up.
   */
  readers?: () => readonly ReadFilter[];
  /**
   * How old a caught-up message may be and still count as news, in ms (D83): from its own time to
   * its delivery. Older, it is played back. `LIVE_GRACE_S` by default.
   */
  liveGraceMs?: number;
}

/** A chat to catch up on: its dialog, its name, its marked id, up to which message; its failures. */
interface Gap {
  dialog: RawDialog;
  chat: string;
  key: string;
  upTo: number;
  failures: number;
}

export class TelegramUserConnector extends ConnectorBase implements Connector {
  private readonly o: UserConnectorOptions;
  /** Each chat's peer, by the chat in lower case, once started. */
  private readonly peers = new Map<string, unknown>();
  /** The account's full list of chats, for the surfaces' searches, and when it was fetched. */
  private all: { at: number; dialogs: RawDialog[] } | undefined;
  /** The chats as given, by their lower case; undefined: every chat. */
  private readonly chats: Map<string, string> | undefined;
  /**
   * Each chat's names (its marked id, and its `@username` where it has one, D90), by each of them
   * in lower case: from the dialogs and the private chats heard.
   */
  private readonly names = new Map<string, readonly string[]>();
  private started = false;
  private listening = false;
  private connected = false;
  private told = false;
  private retry: TimerHandle | undefined;
  /** What it has delivered or skipped of each chat, by its marked id, as kept. */
  private readonly ledger: SeenLedger;
  /**
   * Each chat's first id heard live since this connection (its latest at the connection, plus
   * one): every message from it on comes live. Undefined until the dialogs say it; meanwhile,
   * the ids heard live wait in `early`.
   */
  private liveFrom: Map<string, number> | undefined;
  private early = new Map<string, number[]>();
  /** Each chat's latest ids delivered, so that none is delivered twice. */
  private readonly recent = new Map<string, Set<number>>();
  /** The chats to catch up on, in turn, and the connection whose catch-up runs. */
  private queue: Gap[] = [];
  private working: number | undefined;
  private readonly retries = new Set<TimerHandle>();
  /** Each connection's own, so that a catch-up stopped or superseded ends. */
  private generation = 0;
  /** The highest id known of each sequential chat, by its marked id (D147). */
  private readonly top = new Map<string, number>();
  /** Each sequential chat's looks planned: from which id, when, and its timer (D147). */
  private readonly looks = new Map<
    string,
    { chat: string; minId: number; at: number[]; timer: TimerHandle | undefined }
  >();
  private readonly raw: RawLog;

  constructor(options: UserConnectorOptions) {
    super(options.account, 'telegram');
    this.o = options;
    this.raw = new RawLog(options.clock, options.store);
    this.ledger = new SeenLedger(options.store, (key, after, before) =>
      this.warn(
        `catch-up of ${key}: too many gaps kept, the one after ${after} up to ${before} skipped`
      )
    );
    this.chats =
      options.chats === undefined
        ? undefined
        : new Map(options.chats.map((c) => [c.toLowerCase(), c]));
  }

  /** Connects, without waiting: a failure is retried every minute, and told the first time. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.changed({ state: 'connecting', phase: 'connecting' });
    void this.connect();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.connected = false;
    this.generation++;
    this.queue = [];
    for (const t of this.retries) this.o.clock.clearTimeout(t);
    this.retries.clear();
    this.liveFrom = undefined;
    this.early = new Map();
    this.recent.clear();
    for (const l of this.looks.values()) this.o.clock.clearTimeout(l.timer);
    this.looks.clear();
    this.top.clear();
    this.raw.flush();
    this.o.clock.clearTimeout(this.retry);
    this.peers.clear();
    this.changed({ state: 'closed', phase: 'closed' });
    await this.o.client.disconnect();
  }

  /**
   * Ends its session on Telegram's side (`auth.logOut`: gone from the account's Devices), then
   * stops, needing a login (D116).
   */
  async logOut(): Promise<void> {
    const { client } = this.o;
    if (!this.connected || client.invoke === undefined) throw new Error('not connected');
    await client.invoke(new Api.auth.LogOut());
    await this.stop();
    this.changed({ state: 'closed', phase: NEEDS_LOGIN, detail: 'logged out' });
  }

  /** Sends without waiting for the answer, which is logged if it fails; `deliver` waits. */
  send(chat: string, text: string): boolean {
    if (this.status().state !== 'connected' || !this.monitors(chat)) return false;
    this.deliver(chat, text).catch((e: unknown) =>
      this.o.log(`send to ${chat} failed: ${String(e)}`)
    );
    return true;
  }

  async deliver(chat: string, text: string): Promise<{ id?: string }> {
    if (!this.monitors(chat)) throw new Error(`${chat} is not a chat of ${this.account}`);
    try {
      const sent = await this.o.client.sendMessage((await this.peer(chat)) as never, {
        message: text,
      });
      this.own(chat, sent, text);
      return { id: String(sent.id) };
    } catch (e) {
      const ms = floodMs(e);
      throw ms === undefined ? e : new FloodWait(ms);
    }
  }

  /**
   * Its own message, never heard back live from this session: accounted for, so that the catch-up
   * does not deliver it as missed (D66).
   */
  private own(
    chat: string,
    sent: { id: number; chatId?: { toString(): string } | undefined },
    text: string
  ): void {
    const key = sent.chatId?.toString() ?? (/^-?\d+$/u.test(chat) ? chat : undefined);
    this.raw.add({ via: 'sent', chat, id: sent.id, text });
    if (key !== undefined) {
      this.accountLive(key, sent.id);
      // The answer to it may be the chat's last message: no later one would show its gap (D147).
      if (sequential(key)) this.look(key, chat, this.known(key, sent.id), LOOK_AFTER_SEND_MS);
    }
  }

  /**
   * Sends a photo with GramJS's `sendFile` (bot-os.md D150): its bytes uploaded, or by an id this
   * connector gave one before (`photoId`: Telegram's photo id, access hash and file reference); a
   * Markdown caption as Telegram HTML, a plain one as written; in reply to `replyTo`. The message's
   * id, and the photo's, to send it again by. Telegram's file reference in that id may expire: a
   * send by it then fails with Telegram's `FILE_REFERENCE_EXPIRED`, and the bytes go again.
   */
  async deliverPhoto(
    chat: string,
    photo: CommandPhoto,
    options: ConnectorPhotoOptions = {}
  ): Promise<{ id?: string; photo?: string }> {
    if (!this.monitors(chat)) throw new Error(`${chat} is not a chat of ${this.account}`);
    const byId = typeof photo === 'string' ? inputPhoto(photo) : undefined;
    if (typeof photo === 'string' && byId === undefined)
      throw new Error(`${photo} is not the id of a photo ${this.account} sent`);
    const { client } = this.o;
    try {
      const file =
        typeof photo === 'string'
          ? new Api.InputMediaPhoto({ id: byId as Api.InputPhoto })
          : new Api.InputMediaUploadedPhoto({
              file: await client.uploadFile({
                file: new CustomFile(
                  photoFilename(photo),
                  photo.data.byteLength,
                  '',
                  Buffer.from(photo.data)
                ),
                workers: 1,
              }),
            });
      const markdown = options.format === 'markdown' && options.caption !== undefined;
      const caption = options.caption ?? '';
      const sent = await client.sendFile((await this.peer(chat)) as never, {
        file,
        caption: markdown ? markdownToTelegramHtml(caption) : caption,
        parseMode: markdown ? 'html' : false,
        ...(options.replyTo === undefined ? {} : { replyTo: Number(options.replyTo) }),
      });
      this.own(chat, sent, caption);
      const id = photoId(sent.media);
      return { id: String(sent.id), ...(id === undefined ? {} : { photo: id }) };
    } catch (e) {
      const ms = floodMs(e);
      throw ms === undefined ? e : new FloodWait(ms);
    }
  }

  /**
   * The photo of message `message` in `chat` (bot-os.md D151): the message fetched by its id in
   * that chat (GramJS's `getMessages` with `ids`), its photo's largest size downloaded
   * (`downloadMedia` with that size as `thumb`), refused before the download when Telegram states
   * more than `PHOTO_MAX_BYTES`. Null for a message without a photo (a picture sent as a file is a
   * document, and a link's preview is the link's: neither is a photo); rejects for a chat it does not monitor, a message not found, a flood wait
   * (with Telegram's wait) and a failed download. Its type is read from the bytes (a Telegram photo
   * is a JPEG).
   */
  async photo(chat: string, message: string): Promise<Media | null> {
    if (!this.connected) throw new Error('not connected');
    if (!this.monitors(chat)) throw new Error(`${chat} is not a chat ${this.account} monitors`);
    const id = Number(message);
    if (!/^\d+$/u.test(message) || !Number.isSafeInteger(id) || id <= 0)
      throw new Error(`${message} is not a message id`);
    const { client } = this.o;
    try {
      const [m] = [
        ...(await client.getMessages((await this.peer(chat)) as never, { ids: [id] })),
      ] as (RawMessage | undefined | null)[];
      if (
        m === undefined ||
        m === null ||
        (m as { className?: string }).className === 'MessageEmpty'
      )
        throw new Error(`no message ${message} in ${chat}`);
      const media = m.media as { className?: string; photo?: unknown } | null | undefined;
      // A photo sent as such: not a link's preview, nor a picture sent as a file (a document).
      const largest =
        media?.className === 'MessageMediaPhoto' ? largestPhotoSize(media.photo) : undefined;
      if (largest === undefined) return null;
      const large = photoTooLarge(largest.bytes);
      if (large !== undefined) throw new Error(large);
      const got = await client.downloadMedia(m as never, { thumb: largest.size as never });
      if (!(got instanceof Uint8Array) || got.byteLength === 0)
        throw new Error(`the photo of message ${message} could not be downloaded`);
      const data = new Uint8Array(got);
      return {
        data,
        mime: sniffMime(data) ?? 'image/jpeg',
        ...(largest.size.w === undefined ? {} : { width: largest.size.w }),
        ...(largest.size.h === undefined ? {} : { height: largest.size.h }),
      };
    } catch (e) {
      const ms = floodMs(e);
      throw ms === undefined ? e : new Error(`Telegram asks to wait ${ms / 1000} s`);
    }
  }

  /**
   * Its surfaces (bot-os.md D63): the account's chats, latest first, with their kind and title,
   * whether it monitors them or not (the owner picks new ones to monitor from them). Without a
   * search, those active in the last `SURFACES_ACTIVE_MS` (their latest message), from every folder
   * but the archive, and those its config lists, whatever their activity; with a search, those whose
   * title, username or id has it, among all of them, the archived and the inactive too. Both draw
   * on the full list, fetched once for `DIALOGS_TTL_MS`: a fetch with a limit would return the
   * pinned chats first, however old, and fill the list with them. The limit is applied last. Each
   * is named as the connector names it once its config lists it. The account's own chat (Saved
   * Messages, whose peer is itself) is never among them.
   */
  async surfaces(query: SurfaceQuery = {}): Promise<Surface[]> {
    if (!this.connected) throw new Error('not connected');
    const search = query.search?.trim().toLowerCase() ?? '';
    const limit = query.limit ?? SURFACES_LIMIT;
    const since = this.o.clock.now() - SURFACES_ACTIVE_MS;
    const dialogs = await this.allDialogs();
    return dialogs
      .map((d): Surface | undefined => {
        const id = this.surfaceName(d);
        // The account's own chat (Saved Messages) is no chat to monitor or pick.
        if (id === undefined || field(d.entity, 'self') === true) return undefined;
        const lastActive = d.date === undefined ? undefined : d.date * 1000;
        const configured = this.listed(this.namesOf(id)) !== undefined;
        if (
          search === '' &&
          !configured &&
          (d.folderId === ARCHIVE_FOLDER || lastActive === undefined || lastActive < since)
        )
          return undefined;
        const title = d.title ?? id;
        const aliases = this.namesOf(id).slice(1);
        return {
          id,
          title,
          kind: kindOf(d),
          ...(aliases.length === 0 ? {} : { aliases: [...aliases] }),
          ...(lastActive === undefined ? {} : { lastActive }),
        };
      })
      .filter((x): x is Surface => x !== undefined)
      .filter(
        (x) =>
          search === '' ||
          [x.title, x.id, ...(x.aliases ?? [])].some((n) => n.toLowerCase().includes(search))
      )
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
      .slice(0, limit);
  }

  /**
   * Every chat of the account, of every kind, in the archive or not (a folder of the owner's is a
   * filter over these, not a place of its own), kept for `DIALOGS_TTL_MS`; but a basic group
   * upgraded to a supergroup, which is listed itself.
   */
  private async allDialogs(): Promise<RawDialog[]> {
    const now = this.o.clock.now();
    if (this.all !== undefined && now - this.all.at < DIALOGS_TTL_MS) return this.all.dialogs;
    const dialogs = [...(await this.o.client.getDialogs({}))].filter((d) => !migrated(d));
    this.all = { at: now, dialogs };
    for (const d of dialogs) this.learn(d.id?.toString(), username(d.entity));
    return dialogs;
  }

  /** A chat's title, by any of its names, from the dialogs last fetched; undefined if not there. */
  chatTitle(chat: string): string | undefined {
    const names = new Set(this.namesOf(chat).map((n) => n.toLowerCase()));
    return this.all?.dialogs.find((d) => names.has(d.id?.toString().toLowerCase() ?? ''))?.title;
  }

  /** Whether it monitors `chat`, by any of its names: one of its chats, or any when given none. */
  private monitors(chat: string): boolean {
    return this.chats === undefined || this.listed(this.namesOf(chat)) !== undefined;
  }

  /**
   * Every name it knows `chat` by (D90), `chat` among them: its marked id and its `@username`,
   * as the dialogs and the private chats heard told them; undefined for a chat it never saw.
   */
  chatNames(chat: string): readonly string[] | undefined {
    const names = this.names.get(chat.toLowerCase());
    return names === undefined ? undefined : [...names];
  }

  /** A chat's names, kept: its marked id and its `@username` (a user's, a public group's). */
  private learn(id: string | undefined, user: string | undefined): void {
    if (id === undefined) return;
    const names = user === undefined ? [id] : [id, `@${user}`];
    for (const n of names) this.names.set(n.toLowerCase(), names);
  }

  /** Every name of `chat` it knows, `chat` first; `chat` alone for one it never saw. */
  private namesOf(chat: string): readonly string[] {
    const names = this.names.get(chat.toLowerCase()) ?? [];
    return [chat, ...names.filter((n) => n.toLowerCase() !== chat.toLowerCase())];
  }

  /** A chat as its config lists it, by the first of `names` it lists; undefined if none. */
  private listed(names: readonly (string | undefined)[]): string | undefined {
    for (const n of names) {
      const given = n === undefined ? undefined : this.chats?.get(n.toLowerCase());
      if (given !== undefined) return given;
    }
    return undefined;
  }

  /** A chat's peer: resolved at connection for the chats given, else now. */
  private async peer(chat: string): Promise<unknown> {
    const key = chat.toLowerCase();
    const known = this.peers.get(key);
    if (known !== undefined) return known;
    const peer = await this.o.client.getInputEntity(chat.startsWith('@') ? chat : Number(chat));
    this.peers.set(key, peer);
    return peer;
  }

  private async connect(): Promise<void> {
    const { client } = this.o;
    try {
      await client.connect();
      if (!this.started) return;
      // Once, however often the start is retried; before the dialogs, so nothing falls between:
      // what is heard before the dialogs waits in `early`.
      if (!this.listening) {
        client.addEventHandler((e) => this.heard(e.message), new NewMessage({}));
        client.addEventHandler((e) => this.reheard(e.message), new EditedMessage({}));
        client.addEventHandler((e) => this.unheard(e), new DeletedMessage({}));
      }
      this.listening = true;
      const dialogs = [...(await client.getDialogs({}))];
      for (const d of dialogs) if (!migrated(d)) this.learn(d.id?.toString(), username(d.entity));
      for (const chat of this.chats?.values() ?? []) await this.peer(chat);
      this.named(username(await client.getMe()));
      if (!this.started) return;
      this.connected = true;
      this.changed({ state: 'connected', phase: 'ready' });
      this.o.log(
        `connected as ${this.self() ?? '(no username)'}, reading ${
          this.chats === undefined ? 'every chat' : [...this.chats.values()].join(', ')
        }`
      );
      this.plan(dialogs, this.generation);
    } catch (err) {
      if (!this.started) return;
      this.o.log(`start failed, retrying in ${RETRY_MS / 1000} s: ${String(err)}`);
      if (!this.told)
        this.o.notify?.(`the owner's Telegram session failed to start: ${String(err)}`);
      this.told = true;
      this.changed({ state: 'connecting', phase: 'retrying', detail: String(err) });
      this.retry = this.o.clock.setTimeout(() => void this.connect(), RETRY_MS);
    }
  }

  /**
   * A message the account saw: passed on if it is in one of its chats, as an `Inbound`, unless it
   * was delivered already; accounted for before it is (at most once, D66).
   */
  private async heard(m: RawMessage): Promise<void> {
    if (!this.started) return;
    try {
      const chat = await this.chatOf(m);
      if (chat === undefined) return;
      const key = m.chatId?.toString();
      if (key !== undefined && !this.remember(key, m.id)) return;
      if (key !== undefined && sequential(key)) {
        // Past the last id known of its chat by more than one: the ids between were not pushed
        // (D147), and are looked for.
        const was = this.known(key, m.id);
        if (m.id > was + 1) {
          this.raw.add({ via: 'gap', chat, after: was, before: m.id });
          this.look(key, chat, was, [GAP_LOOK_MS]);
        }
      }
      let inbound: Omit<Inbound, 'account' | 'network'>;
      try {
        inbound = await this.inbound(m, chat);
      } finally {
        if (key !== undefined) this.accountLive(key, m.id);
      }
      this.raw.add({ via: 'live', ...inbound });
      this.received(inbound);
    } catch (err) {
      this.o.log(`message ${m.id} dropped: ${String(err)}`);
    }
  }

  /**
   * An edit the account saw (bot-os.md D144): passed on, live, to the plugins that hear edits, if
   * in one of its chats; each edit once (a message and its edit's time). Edits are not accounted
   * for: one missed while the instance was down is not caught up, the catch-up giving each message
   * as it now reads.
   */
  private async reheard(m: RawMessage): Promise<void> {
    if (!this.started) return;
    try {
      const chat = await this.chatOf(m);
      if (chat === undefined) return;
      const edited = (m.editDate ?? Math.floor(this.o.clock.now() / 1000)) * 1000;
      const key = `${m.chatId?.toString() ?? chat}\n${m.id}`;
      if (!this.remember(`${key}\nedit`, edited)) return;
      const inbound = { ...(await this.inbound(m, chat)), edited };
      this.raw.add({ via: 'edit', ...inbound });
      this.reread(inbound);
    } catch (err) {
      this.o.log(`edit of message ${m.id} dropped: ${String(err)}`);
    }
  }

  /**
   * A deletion the account heard of (bot-os.md D158): passed on, live, to the plugins that hear
   * deletions, if in one of its chats. Only a supergroup's or a channel's names its chat; a basic
   * group's or a private chat's, ids alone, is not passed on. Deletions are not accounted for: one
   * made while the instance was down is lost.
   */
  private unheard(e: RawDeletion): Promise<void> {
    if (!this.started) return Promise.resolve();
    const channel =
      typeof e.peer === 'object' && e.peer !== null
        ? (e.peer as { channelId?: unknown }).channelId
        : undefined;
    if (channel === undefined || channel === null || e.deletedIds.length === 0)
      return Promise.resolve();
    const chat = this.chatName(`-100${String(channel)}`, undefined);
    if (chat === undefined) return Promise.resolve();
    const aliases = this.namesOf(chat).slice(1);
    const ids = e.deletedIds.map(String);
    this.raw.add({ via: 'delete', chat, ids });
    this.deleted({
      chat,
      ...(aliases.length === 0 ? {} : { aliases }),
      ids,
      time: this.o.clock.now(),
    });
    return Promise.resolve();
  }

  /** An id delivered in a chat, remembered; false if it was already. */
  private remember(key: string, id: number): boolean {
    let ids = this.recent.get(key);
    if (ids === undefined) this.recent.set(key, (ids = new Set()));
    if (ids.has(id)) return false;
    ids.add(id);
    if (ids.size > RECENT) ids.delete(ids.values().next().value as number);
    return true;
  }

  /**
   * An id heard live (or sent) in a chat, accounted for: with every id since the connection's
   * first live one, which all come live; alone if older; waiting in `early` until the dialogs say
   * where the connection's live ids start.
   */
  private accountLive(key: string, id: number): void {
    if (this.liveFrom === undefined) {
      this.early.set(key, [...(this.early.get(key) ?? []), id]);
      return;
    }
    let from = this.liveFrom.get(key);
    if (from === undefined) {
      // A chat the dialogs did not list: its live ids start here.
      from = this.ledger.last(key) === undefined ? id + 1 : id;
      this.liveFrom.set(key, from);
    }
    if (this.ledger.last(key) === undefined) this.ledger.advance(key, id);
    // A sequential chat's: only the id seen, for an update may not come (D147); a gap below it
    // stays open for a look, or the next connection.
    else if (sequential(key) || id < from) this.ledger.mark(key, id);
    else this.ledger.mark(key, from, id);
  }

  /**
   * The highest id known of a sequential chat before `id`, which becomes known (D147): the one
   * before it the first time.
   */
  private known(key: string, id: number): number {
    const was = this.top.get(key) ?? id - 1;
    this.top.set(key, Math.max(was, id));
    return was;
  }

  /**
   * Looks for a sequential chat's messages after `minId`, after each of `delays` (D147): planned
   * with those already planned there, from the lowest id asked.
   */
  private look(key: string, chat: string, minId: number, delays: readonly number[]): void {
    const now = this.o.clock.now();
    const was = this.looks.get(key);
    const at = [...new Set([...(was?.at ?? []), ...delays.map((d) => now + d)])].sort(
      (a, b) => a - b
    );
    this.looks.set(key, {
      chat,
      minId: Math.min(was?.minId ?? minId, minId),
      at,
      timer: was?.timer,
    });
    this.armLook(key);
  }

  private armLook(key: string): void {
    const l = this.looks.get(key);
    if (l === undefined) return;
    this.o.clock.clearTimeout(l.timer);
    const next = l.at[0];
    if (next === undefined) {
      this.looks.delete(key);
      return;
    }
    const generation = this.generation;
    l.timer = this.o.clock.setTimeout(
      () => void this.lookNow(key, generation),
      Math.max(0, next - this.o.clock.now())
    );
  }

  /**
   * A look (D147): the chat's latest messages after its `minId`, one request, each not yet
   * delivered given now as caught up, oldest first; the ids between accounted for when the page
   * holds them all. A flood wait or a failure is logged, and the next look, or the next
   * connection, tries again.
   */
  private async lookNow(key: string, generation: number): Promise<void> {
    const l = this.looks.get(key);
    if (l === undefined || generation !== this.generation || !this.connected) return;
    l.timer = undefined;
    l.at.shift();
    const { chat, minId } = l;
    try {
      const page = [
        ...(await this.o.client.getMessages((await this.peer(chat)) as never, {
          limit: LOOK_LIMIT,
          offsetId: 0,
          minId,
        })),
      ]
        .filter((m) => m.id > minId)
        .sort((a, b) => a.id - b.id);
      if (generation !== this.generation) return;
      for (const m of page) {
        this.known(key, m.id);
        if (this.ledger.covered(key, m.id)) continue;
        let inbound: Omit<Inbound, 'account' | 'network'> | undefined;
        if (isText(m))
          try {
            inbound = await this.inbound(m, chat);
          } catch (err) {
            this.o.log(`message ${m.id} dropped: ${String(err)}`);
          }
        if (generation !== this.generation) return;
        this.ledger.mark(key, m.id);
        if (inbound === undefined || !this.remember(key, m.id)) continue;
        const grace = this.o.liveGraceMs ?? LIVE_GRACE_S * 1000;
        const delivered = {
          ...inbound,
          playback: this.o.clock.now() - inbound.time > grace,
          missed: true,
        };
        this.raw.add({ via: 'look', ...delivered });
        this.received(delivered);
      }
      const newest = page.at(-1)?.id;
      // The whole gap was in the page: what it does not hold is gone (deleted), accounted for.
      if (newest !== undefined && page.length < LOOK_LIMIT)
        this.ledger.mark(key, minId + 1, newest);
    } catch (err) {
      const ms = floodMs(err);
      this.o.log(
        ms === undefined
          ? `look in ${chat} failed: ${String(err)}`
          : `look in ${chat}: Telegram asks to wait ${ms / 1000} s`
      );
    }
    if (generation === this.generation) this.armLook(key);
  }

  /**
   * Whether a running reader reads `chat` (`ctx.readers`), by any of its names (D90): its gap is
   * fetched, or skipped.
   */
  private read(chat: string): boolean {
    const names = new Set(this.namesOf(chat).map((n) => n.toLowerCase()));
    return (this.o.readers?.() ?? []).some(
      (r) => r.reads === '*' || r.reads.some((c) => names.has(c.toLowerCase()))
    );
  }

  /**
   * At connection (D62, D66), from the dialogs: where each chat's live ids start (after its latest
   * message); the ids heard before, accounted for; a chat seen for the first time, accounted for
   * up to its latest message (not fetched); and each chat with a gap, fetched if a running reader
   * reads it, else skipped.
   */
  private plan(dialogs: readonly RawDialog[], generation: number): void {
    const liveFrom = new Map<string, number>();
    const chats: Gap[] = [];
    for (const dialog of dialogs) {
      const chat = this.nameOf(dialog);
      const key = dialog.id?.toString();
      const upTo = dialog.message?.id;
      if (chat === undefined || key === undefined || upTo === undefined) continue;
      liveFrom.set(key, upTo + 1);
      if (sequential(key)) this.known(key, upTo);
      if (this.ledger.last(key) === undefined) this.ledger.advance(key, upTo);
      chats.push({ dialog, chat, key, upTo, failures: 0 });
    }
    this.liveFrom = liveFrom;
    for (const [key, ids] of this.early) for (const id of ids) this.accountLive(key, id);
    this.early = new Map();
    for (const gap of chats) {
      if (this.ledger.gaps(gap.key, gap.upTo).length === 0) continue;
      if (this.read(gap.chat)) this.queue.push(gap);
      else this.ledger.advance(gap.key, gap.upTo);
    }
    void this.work(generation);
  }

  /**
   * The chats to catch up on, one at a time: a chat no running reader reads any more is skipped,
   * one whose fetch fails is logged and queued again later (`RETRY_MS`, doubled each time, up to
   * `CATCH_UP_RETRY_MAX_MS`).
   */
  private async work(generation: number): Promise<void> {
    if (this.working === generation) return;
    this.working = generation;
    try {
      for (;;) {
        const gap = this.queue.shift();
        if (gap === undefined || generation !== this.generation) return;
        if (!this.read(gap.chat)) {
          this.ledger.advance(gap.key, gap.upTo);
          continue;
        }
        try {
          await this.fill(gap, generation);
        } catch (err) {
          if (generation !== this.generation) return;
          gap.failures++;
          const ms = Math.min(RETRY_MS * 2 ** (gap.failures - 1), CATCH_UP_RETRY_MAX_MS);
          this.o.log(`catch-up of ${gap.chat} failed, again in ${ms / 1000} s: ${String(err)}`);
          const timer = this.o.clock.setTimeout(() => {
            this.retries.delete(timer);
            this.queue.push(gap);
            void this.work(generation);
          }, ms);
          this.retries.add(timer);
        }
      }
    } finally {
      if (this.working === generation) this.working = undefined;
    }
  }

  /**
   * One chat's gaps, newest first, fetched a page at a time, at most `CATCH_UP_CAP` messages (past
   * it, the older ones are skipped, warned of and recorded); then delivered oldest first, each
   * accounted for before it goes, so that a stop in between delivers none twice.
   */
  private async fill(gap: Gap, generation: number): Promise<void> {
    const peer = gap.dialog.inputEntity ?? gap.dialog.entity;
    const ranges = this.ledger.gaps(gap.key, gap.upTo);
    const messages: RawMessage[] = [];
    /** The oldest message fetched, when older ones are missing past the cap. */
    let floor: number | undefined;
    for (const [i, [after, upTo]] of ranges.entries()) {
      let offsetId = upTo + 1;
      let complete = false;
      while (messages.length < CATCH_UP_CAP) {
        const page = await this.page(peer, offsetId, after, CATCH_UP_PAGE, generation);
        if (page === undefined) return;
        messages.push(...page);
        if (page.length < CATCH_UP_PAGE) {
          complete = true;
          break;
        }
        offsetId = Math.min(...page.map((m) => m.id));
      }
      if (messages.length < CATCH_UP_CAP) continue;
      // At the cap: is anything still missing below?
      const below: [number, number][] = [
        ...(complete ? [] : [[after, offsetId - 1] as [number, number]]),
        ...ranges.slice(i + 1),
      ];
      for (const [lo, hi] of below) {
        if (hi <= lo) continue;
        const more = await this.page(peer, hi + 1, lo, 1, generation);
        if (more === undefined) return;
        if (more.length === 0) continue;
        floor = Math.min(...messages.map((m) => m.id));
        this.warn(
          `catch-up of ${gap.chat} stopped at ${messages.length} messages, older ones missed`
        );
        this.o.record?.('telegram-user.catch-up', { chat: gap.chat, fetched: messages.length });
        break;
      }
      break;
    }
    if (floor !== undefined) this.ledger.advance(gap.key, floor - 1);
    for (const m of messages.sort((a, b) => a.id - b.id)) {
      if (generation !== this.generation) return;
      if (this.ledger.covered(gap.key, m.id)) continue;
      let inbound: Omit<Inbound, 'account' | 'network'> | undefined;
      if (isText(m))
        try {
          inbound = await this.inbound(m, gap.chat);
        } catch (err) {
          this.o.log(`message ${m.id} dropped: ${String(err)}`);
        }
      if (generation !== this.generation) return;
      this.ledger.advance(gap.key, m.id);
      if (inbound === undefined || !this.remember(gap.key, m.id)) continue;
      // News still within its grace (D83): a quick restart costs nothing.
      const grace = this.o.liveGraceMs ?? LIVE_GRACE_S * 1000;
      const old = this.o.clock.now() - inbound.time > grace;
      this.raw.add({ via: 'catch-up', ...inbound, playback: old });
      this.received({ ...inbound, playback: old, missed: true });
    }
    this.ledger.advance(gap.key, gap.upTo);
  }

  /**
   * One page of a chat's history, after the pause between requests: Telegram's `FLOOD_WAIT` is
   * waited out, then asked again. Undefined once the connection it belongs to is over.
   */
  private async page(
    peer: unknown,
    offsetId: number,
    minId: number,
    limit: number,
    generation: number
  ): Promise<RawMessage[] | undefined> {
    let wait = CATCH_UP_PAUSE_MS;
    for (;;) {
      await this.sleep(wait);
      if (generation !== this.generation) return undefined;
      try {
        return [
          ...(await this.o.client.getMessages(peer as never, { limit, offsetId, minId })),
        ].filter((m) => m.id > minId && m.id < offsetId);
      } catch (err) {
        const ms = floodMs(err);
        if (ms === undefined) throw err;
        this.o.log(`catch-up: Telegram asks to wait ${ms / 1000} s`);
        wait = ms;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.o.clock.setTimeout(resolve, ms));
  }

  private warn(line: string): void {
    (this.o.warn ?? this.o.log)(line);
  }

  private async inbound(
    m: RawMessage,
    chat: string
  ): Promise<Omit<Inbound, 'account' | 'network'>> {
    const entity = await m.getSender();
    const sender = username(entity);
    const replyTo = m.replyTo?.replyToMsgId;
    const document = await this.document(m);
    const media = mediaOf(m);
    const aliases = this.namesOf(chat).slice(1);
    return {
      chat,
      ...(aliases.length === 0 ? {} : { aliases }),
      ...(m.isPrivate === undefined ? {} : { private: m.isPrivate }),
      sender: sender ?? '',
      ...senderOf(entity),
      text: m.message,
      time: m.date * 1000,
      id: String(m.id),
      ...(replyTo === undefined ? {} : { replyTo: String(replyTo) }),
      playback: false,
      own: m.out === true,
      ...(document === undefined ? {} : { document }),
      ...(media === undefined ? {} : { media }),
      ...buttonsOf(m),
    };
  }

  /**
   * A message's file (D82): a text file under the limit downloaded, with its text; any other
   * described. Live and in the catch-up alike, so that one missed while down comes with its text.
   */
  private async document(m: RawMessage): Promise<InboundDocument | undefined> {
    const d = m.document;
    if (d === undefined) return undefined;
    const size = d.size === undefined ? undefined : Number(d.size.toString());
    return readDocument(
      { name: fileName(d.attributes), mime: d.mimeType, size },
      async () => {
        const got = await this.o.client.downloadMedia(m as never, {});
        return got instanceof Uint8Array ? got : undefined;
      },
      (line) => this.warn(`message ${m.id}: ${line}`)
    );
  }

  /**
   * The name a chat is delivered by: as given, by any of its names (D90), else a group's id, a
   * private chat's @username.
   */
  private chatName(id: string | undefined, other: string | undefined): string | undefined {
    const at = other === undefined ? undefined : `@${other}`;
    if (this.chats === undefined) return at ?? id;
    return this.listed([id, at, ...(id === undefined ? [] : this.namesOf(id))]);
  }

  private nameOf(d: RawDialog): string | undefined {
    return this.chatName(d.id?.toString(), d.isUser === true ? username(d.entity) : undefined);
  }

  /**
   * A dialog's name as a surface, monitored or not: as its config gives it, else as it would be
   * named once given (a private chat's `@username`, else its id).
   */
  private surfaceName(d: RawDialog): string | undefined {
    const id = d.id?.toString();
    const other = d.isUser === true ? username(d.entity) : undefined;
    return this.chatName(id, other) ?? (other === undefined ? id : `@${other}`);
  }

  /** The chat of a message, as given, or undefined for a chat it does not monitor. */
  private async chatOf(m: RawMessage): Promise<string | undefined> {
    const id = m.chatId?.toString();
    if (m.isPrivate !== true) return this.chatName(id, undefined);
    const byId = this.chats?.get(id?.toLowerCase() ?? '');
    if (byId !== undefined) return byId;
    const other = username(await m.getChat());
    this.learn(id, other);
    return this.chatName(id, other);
  }
}

export interface UserCredentials {
  apiId: number;
  apiHash: string;
  /** The session string from the login command; empty to log in afresh. */
  session: string;
}

/** The device a session shows as in the account's Settings → Devices (D116). */
export const DEVICE_MODEL = 'MegaBotTron1999';

/** A GramJS client for `credentials`, quiet but for errors. */
export function createTelegramClient(
  credentials: UserCredentials,
  session = new StringSession(credentials.session)
): TelegramClient {
  // The logger is given at construction: the constructor already logs (its version banner).
  return new TelegramClient(session, credentials.apiId, credentials.apiHash, {
    connectionRetries: 5,
    baseLogger: new Logger(LogLevel.ERROR),
    deviceModel: DEVICE_MODEL,
  });
}
