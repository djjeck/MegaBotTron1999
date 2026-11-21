/**
 * A media field of a form (`SchemaForm.tsx`, docs/bot-os.md D155): a property whose JSON Schema
 * says `media` (the core's `mediaSchema`, or `mediaField(limits)` with its `kinds`, `mimes` and
 * `maxBytes`), wherever it is (an action's input, a config). A file is picked (**Choose a file**,
 * then **Replace**), its picture previewed, and **Remove** takes it away. Its value is a `Media` as
 * JSON carries it: `{ data: { $bytes: "<base64>" }, mime, width?, height? }`, its size in pixels
 * read from the picture once it loads. A file past `maxBytes`, or of a type not taken, is refused
 * here, with why, before it is sent; the plugin checks it again.
 *
 * A value kept already (a collection's record holds `{ id: "sha256:…", mime }`, its bytes the
 * node's file) is shown through `src`, which gives its picture's address.
 */
import { useState } from 'react';
import type { JsonSchema } from '#src/ui/api.ts';
import { sizeText } from './Files.tsx';

/** A media's limits, as its schema says them (`media`); undefined: no media field. */
export interface MediaLimits {
  kinds?: string[];
  mimes?: string[];
  maxBytes?: number;
}

/** The key bytes go under as JSON (the core's `BYTES_KEY`). */
export const BYTES_KEY = '$bytes';

/** The limits of a property whose schema says `media`; undefined for any other. */
export function mediaLimits(schema: JsonSchema): MediaLimits | undefined {
  const m = schema['media'];
  return typeof m === 'object' && m !== null && !Array.isArray(m) ? (m as MediaLimits) : undefined;
}

/** A picked media's bytes, as JSON carries them; undefined for a value of another shape. */
function base64Of(v: unknown): string | undefined {
  const data = (v as { data?: Record<string, unknown> } | null)?.data;
  const b64 = data?.[BYTES_KEY];
  return typeof b64 === 'string' ? b64 : undefined;
}

const mimeOf = (v: unknown): string | undefined => {
  const m = (v as { mime?: unknown } | null)?.mime;
  return typeof m === 'string' ? m : undefined;
};

/** The size in bytes of a base64 text. */
const decodedSize = (b64: string): number =>
  Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/** The types a file input accepts, from the limits: its types, or its kinds' (`image/*`). */
export function accepted(limits: MediaLimits): string | undefined {
  if (limits.mimes !== undefined) return limits.mimes.join(',');
  const kinds = (limits.kinds ?? []).filter((k) => k !== 'document');
  return kinds.length === 0 || kinds.length !== (limits.kinds ?? []).length
    ? undefined
    : kinds.map((k) => `${k}/*`).join(',');
}

/** Why a file cannot go where `limits` say, or undefined. */
export function fileRefusal(
  file: { size: number; type: string },
  limits: MediaLimits
): string | undefined {
  const type = file.type || 'application/octet-stream';
  const top = type.slice(0, type.indexOf('/'));
  const kind = top === 'image' || top === 'video' || top === 'audio' ? top : 'document';
  if (limits.kinds !== undefined && !limits.kinds.includes(kind))
    return `${type} is not ${limits.kinds.join(' or ')}`;
  if (limits.mimes !== undefined && !limits.mimes.includes(type))
    return `${type} is not a type taken here (${limits.mimes.join(', ')})`;
  if (limits.maxBytes !== undefined && file.size > limits.maxBytes)
    return `${sizeText(file.size)}, more than the ${sizeText(limits.maxBytes)} taken here`;
  return undefined;
}

/** Bytes as base64, in chunks (a large file would overflow one call's arguments). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** What the limits take, in words: `an image, up to 10.0 MB`. */
export function limitsText(limits: MediaLimits): string {
  const what =
    limits.mimes !== undefined
      ? limits.mimes.join(', ')
      : limits.kinds !== undefined
        ? limits.kinds.join(' or ')
        : 'any file';
  return limits.maxBytes === undefined ? what : `${what}, up to ${sizeText(limits.maxBytes)}`;
}

export function MediaField(props: {
  name: string;
  limits: MediaLimits;
  value: unknown;
  set: ((v: unknown) => void) | undefined;
  /** The address of a kept value's picture (a record's media); undefined: none to show. */
  src?: ((value: unknown) => string | undefined) | undefined;
}) {
  const { name, value, set, limits } = props;
  const [refused, setRefused] = useState<string>();
  const b64 = base64Of(value);
  const mime = mimeOf(value);
  const src =
    value === undefined
      ? undefined
      : b64 !== undefined
        ? mime?.startsWith('image/') === true
          ? `data:${mime};base64,${b64}`
          : undefined
        : props.src?.(value);
  const pick = async (file: File): Promise<void> => {
    const why = fileRefusal(file, limits);
    setRefused(why);
    if (why !== undefined || set === undefined) return;
    const type = file.type || 'application/octet-stream';
    const data = toBase64(new Uint8Array(await file.arrayBuffer()));
    const picked = { data: { [BYTES_KEY]: data }, mime: type };
    set(picked);
    // Its size in pixels, once the browser has read the picture.
    if (type.startsWith('image/') && typeof Image !== 'undefined') {
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0)
          set({ ...picked, width: img.naturalWidth, height: img.naturalHeight });
      };
      img.src = `data:${type};base64,${data}`;
    }
  };
  return (
    <div className="media-field" role="group" aria-label={name}>
      {value === undefined ? (
        <span className="muted small">none</span>
      ) : (
        <span className="muted small">
          {mime ?? 'a file'}
          {b64 === undefined ? '' : `, ${sizeText(decodedSize(b64))}`}
        </span>
      )}
      {src === undefined ? null : (
        <div>
          <img src={src} alt={`${name} preview`} />
        </div>
      )}
      {set === undefined ? null : (
        <div className="media-buttons">
          <label className="button">
            {value === undefined ? 'Choose a file' : 'Replace'}
            <input
              type="file"
              aria-label={`${name} file`}
              {...(accepted(limits) === undefined ? {} : { accept: accepted(limits) })}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file !== undefined) void pick(file);
              }}
            />
          </label>
          {value === undefined ? null : (
            <button
              type="button"
              className="link"
              onClick={() => {
                setRefused(undefined);
                set(undefined);
              }}
            >
              Remove
            </button>
          )}
        </div>
      )}
      <small className="muted">{limitsText(limits)}</small>
      {refused === undefined ? null : <small className="error">{refused}</small>}
    </div>
  );
}
