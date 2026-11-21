/**
 * A message's photo, fetched on demand (docs/bot-os.md D151, docs/bot-os-api.md §4.5): the action
 * `photo({ chat, message })` that a connector plugin offers on its interface when its connector can
 * fetch one (`Connector.photo`, both Telegram connectors). A plugin reaches it through an interface
 * input bound to the connector's node, members `actions.photo`, so that the edge is the permission
 * (P6, P17). Nothing is downloaded with a message (D82's reasoning stands): only the photo asked
 * for, when asked.
 *
 * The action never throws: a photo (its bytes, of the largest size the network has), `null` for a
 * message without one, or why not (`ok: false`).
 */
import { z } from 'zod';
import { type Connector, type MessagePhoto } from './connector.ts';
import { type ActionCall } from './plugin.ts';

/**
 * The largest photo the action answers, in bytes (D151): 10 MiB. Telegram takes no photo larger
 * than 10 MB, so its photos fit; a larger one is refused with why, before its download where the
 * network tells its size, after it otherwise.
 */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/** What `photo` asks: the chat, as the connector names it (or any of its aliases), and the message's id. */
export interface PhotoRequest {
  chat: string;
  message: string;
}

/** What `photo` answers: the photo, `null` when the message has none; or why not. */
export type PhotoResult = { ok: true; photo: MessagePhoto | null } | { ok: false; error: string };

/** The action, as a plugin calls it through its interface input. */
export type FetchPhoto = (request: PhotoRequest, call?: ActionCall) => Promise<PhotoResult>;

const bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'bytes');

/** The action's entry in a connector plugin's manifest (`interface.actions.photo`). */
export const PHOTO_ACTION = {
  help: 'Fetches the photo of a message, in a chat it monitors: its bytes (the largest size), its type and its size; null when the message has none',
  input: z.object({ chat: z.string().min(1), message: z.string().min(1) }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      photo: z
        .object({
          data: bytes,
          mime: z.string(),
          width: z.number().optional(),
          height: z.number().optional(),
        })
        .nullable(),
    }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
};

/**
 * An image's media type, read from its first bytes: JPEG, PNG, GIF or WebP; undefined for any
 * other.
 */
export function imageMime(data: Uint8Array): string | undefined {
  const at = (i: number, ...b: number[]): boolean => b.every((x, j) => data[i + j] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return undefined;
}

/** A size in words: `512 B`, `1.2 MiB`. */
const sizeOf = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 1048576).toFixed(1)} MiB`;

/** Why a photo of `size` bytes is refused (larger than `PHOTO_MAX_BYTES`), or undefined. */
export function photoTooLarge(size: number | undefined): string | undefined {
  return size !== undefined && size > PHOTO_MAX_BYTES
    ? `the photo is ${sizeOf(size)}, more than the ${sizeOf(PHOTO_MAX_BYTES)} a photo may be`
    : undefined;
}

/**
 * The action `photo` of a connector (`connector.photo`), for its plugin's interface: the request
 * checked, its answer's size checked again, any failure answered as why not, never thrown. Without
 * a connector that can fetch one (a node needing a login), every request is refused with `none`'s
 * why. Each call is logged (`log`) with its caller, the chat, the message and the bytes, never them.
 */
export function photoAction(
  connector: Pick<Connector, 'photo' | 'account'> | undefined,
  log: (line: string) => void = () => {},
  none = 'not logged in'
): FetchPhoto {
  return async (request, call) => {
    const r = PHOTO_ACTION.input.safeParse(request);
    if (!r.success) return { ok: false, error: 'a photo request is { chat, message }' };
    const { chat, message } = r.data;
    const who = call?.node ?? '(owner)';
    const answer = (result: PhotoResult): PhotoResult => {
      const what = !result.ok
        ? `refused: ${result.error}`
        : result.photo === null
          ? 'none'
          : `${result.photo.data.byteLength} bytes`;
      log(`photo of message ${message} in ${chat}, for ${who}: ${what}`);
      return result;
    };
    if (connector?.photo === undefined) return answer({ ok: false, error: none });
    try {
      const photo = await connector.photo(chat, message);
      const large = photoTooLarge(photo?.data.byteLength);
      return answer(large === undefined ? { ok: true, photo } : { ok: false, error: large });
    } catch (e) {
      return answer({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
}
