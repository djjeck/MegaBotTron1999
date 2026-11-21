/**
 * Media (docs/bot-os.md D153, docs/bot-os-api.md §4.18): bytes and their media type, the one shape
 * every plugin that passes a picture (or, later, a video, a sound or a document) uses, so that the
 * same bytes go from a connector's `photo` (D151) to a plugin's state, to an outbox (D150) and to
 * `ask` (D152) without being declared anew at each hop.
 *
 * - `Media`, with its schema `mediaSchema` for a manifest's actions, and its `kind`, read from its
 *   type (`mediaKind`).
 * - `sniffMime`: a type guessed from the bytes; `mediaMismatch`: whether the bytes are the type they
 *   say; `mediaRefusal`: why a media cannot go where it is sent (its kind, its type, its size).
 * - `MediaResult`, with `mediaResultSchema`: what an action that answers media answers, wherever
 *   the bytes came from (a network, a plugin's files: `mediaOfFile`).
 *
 * Bytes only: a reference to media (a plugin's file, by its hash) passed in their place is for later.
 */
import { z } from 'zod';
import { type StoreFiles } from './store.ts';

/** What a media is, read from its type's first part (D153). */
export const MEDIA_KINDS = ['image', 'video', 'audio', 'document'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Bytes and their media type (D153): a picture, and later a video, a sound or a document. */
export interface Media {
  data: Uint8Array;
  /** Its media type, as `type/subtype` (`image/png`), in lower case. */
  mime: string;
  /** Its size in pixels, where whoever made it knows (a picture, a video). */
  width?: number;
  height?: number;
}

/** A media type: `type/subtype`, in lower case, no parameters. */
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

/** Bytes, in a schema: a `Uint8Array` (a `Buffer` is one). */
export const bytesSchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'bytes');

/** A `Media`'s schema, for a manifest's action that takes or answers one (D153). */
export const mediaSchema = z.object({
  data: bytesSchema,
  mime: z.string().regex(MIME, 'a media type, as type/subtype in lower case'),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

/**
 * A media's kind, from its type (D153): `image/*`, `video/*` and `audio/*` are theirs; any other
 * (`application/pdf`, `text/plain`) is a `document`.
 */
export function mediaKind(mime: string): MediaKind {
  const type = mime.slice(0, mime.indexOf('/'));
  return type === 'image' || type === 'video' || type === 'audio' ? type : 'document';
}

/**
 * The types `sniffMime` reads from the bytes (D153): JPEG, PNG, GIF and WebP (the images Telegram
 * and the Messages API take, D151, D152) and PDF. Bytes of one of them must be read as it.
 */
export const SNIFFED_MIMES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const;

/** A type guessed from the first bytes (`SNIFFED_MIMES`); undefined for any other. */
export function sniffMime(data: Uint8Array): string | undefined {
  const at = (i: number, ...b: number[]): boolean => b.every((x, j) => data[i + j] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  return undefined;
}

/**
 * Why the bytes are not the type they say (D153), or undefined when they are, or when it cannot
 * be told: bytes `sniffMime` reads must be the type said, and a type it reads must be what the
 * bytes read as; bytes and a type it reads neither of pass.
 */
export function mediaMismatch(media: Pick<Media, 'data' | 'mime'>): string | undefined {
  const read = sniffMime(media.data);
  if (read === media.mime) return undefined;
  if (read !== undefined) return `its bytes are ${read}, not the ${media.mime} it says`;
  if ((SNIFFED_MIMES as readonly string[]).includes(media.mime))
    return `its bytes are not ${media.mime}, as it says`;
  return undefined;
}

/** Where a media may go (`mediaRefusal`): each limit not given does not limit. */
export interface MediaLimits {
  /** The kinds taken. */
  kinds?: readonly MediaKind[];
  /** The types taken. */
  mimes?: readonly string[];
  /** The most bytes taken. */
  maxBytes?: number;
}

/** A size in words: `512 B`, `1.2 KiB`, `10.0 MiB`. */
export const sizeInWords = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 1048576).toFixed(1)} MiB`;

/**
 * Why `media` cannot go where `limits` say (D153), or undefined when it can: not a `Media` (its
 * schema), a kind or a type not taken, bytes of another type than the one said
 * (`mediaMismatch`), more bytes than taken.
 */
export function mediaRefusal(media: unknown, limits: MediaLimits = {}): string | undefined {
  const r = mediaSchema.safeParse(media);
  if (!r.success) {
    const mime = (media as { mime?: unknown } | null)?.mime;
    return typeof mime === 'string' && !MIME.test(mime)
      ? `${mime || 'no type'} is not a media type`
      : 'a media is { data, mime }, data its bytes';
  }
  const m = r.data;
  const kind = mediaKind(m.mime);
  if (limits.kinds !== undefined && !limits.kinds.includes(kind))
    return `${m.mime} is ${kind === 'image' ? 'an' : 'a'} ${kind}, not ${limits.kinds.join(' or ')}`;
  if (limits.mimes !== undefined && !limits.mimes.includes(m.mime))
    return `${m.mime} is not a type taken here (${limits.mimes.join(', ')})`;
  const mismatch = mediaMismatch(m);
  if (mismatch !== undefined) return mismatch;
  if (limits.maxBytes !== undefined && m.data.byteLength > limits.maxBytes)
    return `${sizeInWords(m.data.byteLength)}, more than the ${sizeInWords(limits.maxBytes)} taken here`;
  return undefined;
}

/**
 * What an action that answers media answers (D153; D151's `photo`, and any plugin's): the media,
 * `null` when there is none, or why not. A reader cannot tell where the bytes came from.
 */
export type MediaResult = { ok: true; media: Media | null } | { ok: false; error: string };

/** A `MediaResult`'s schema, for a manifest's action that answers one. */
export const mediaResultSchema = z.union([
  z.object({ ok: z.literal(true), media: mediaSchema.nullable() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/**
 * A file of a plugin's store (D149) as a `Media`: its bytes and the type kept with it; undefined
 * when there is no such file. What a plugin answers from its files, as a connector does from the
 * network.
 */
export function mediaOfFile(
  files: Pick<StoreFiles, 'read' | 'list'>,
  name: string
): Media | undefined {
  const data = files.read(name);
  if (data === undefined) return undefined;
  const type = files.list().find((f) => f.name === name)?.type;
  return { data, mime: type ?? 'application/octet-stream' };
}
