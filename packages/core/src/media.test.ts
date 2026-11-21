import { describe, expect, it } from 'vitest';
import { assertMedia, DevKit, fakeMedia } from './devkit.ts';
import {
  mediaKind,
  mediaMismatch,
  mediaOfFile,
  mediaRefusal,
  mediaResultSchema,
  mediaSchema,
  sizeInWords,
  sniffMime,
} from './media.ts';
import { definePlugin } from './plugin.ts';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('sniffMime', () => {
  it('reads JPEG, PNG, GIF, WebP and PDF from their first bytes; nothing else', () => {
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png'
    );
    expect(sniffMime(text('GIF89a'))).toBe('image/gif');
    expect(sniffMime(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(text('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffMime(text('RIFF\0\0\0\0WAVEfmt '))).toBeUndefined();
    expect(sniffMime(new Uint8Array([]))).toBeUndefined();
  });
});

describe('mediaKind', () => {
  it('reads the kind from the type: image, video, audio; anything else a document', () => {
    expect(mediaKind('image/png')).toBe('image');
    expect(mediaKind('video/mp4')).toBe('video');
    expect(mediaKind('audio/ogg')).toBe('audio');
    expect(mediaKind('application/pdf')).toBe('document');
    expect(mediaKind('text/plain')).toBe('document');
    expect(mediaKind('nonsense')).toBe('document');
  });
});

describe('mediaMismatch', () => {
  it('tells bytes of another type than the one said; passes what it cannot tell', () => {
    expect(mediaMismatch({ data: JPEG, mime: 'image/jpeg' })).toBeUndefined();
    expect(mediaMismatch({ data: JPEG, mime: 'image/png' })).toBe(
      'its bytes are image/jpeg, not the image/png it says'
    );
    expect(mediaMismatch({ data: text('hello'), mime: 'image/png' })).toBe(
      'its bytes are not image/png, as it says'
    );
    expect(mediaMismatch({ data: JPEG, mime: 'text/plain' })).toBe(
      'its bytes are image/jpeg, not the text/plain it says'
    );
    // Neither read: it cannot tell.
    expect(mediaMismatch({ data: text('hello'), mime: 'text/plain' })).toBeUndefined();
    expect(mediaMismatch({ data: new Uint8Array([0, 0]), mime: 'video/mp4' })).toBeUndefined();
  });
});

describe('mediaRefusal', () => {
  it('refuses what is no media, then a kind, a type, bytes of another, a size', () => {
    expect(mediaRefusal({ data: JPEG, mime: 'image/jpeg', width: 8, height: 6 })).toBeUndefined();
    expect(mediaRefusal(null)).toBe('a media is { data, mime }, data its bytes');
    expect(mediaRefusal({ data: [1, 2], mime: 'image/png' })).toBe(
      'a media is { data, mime }, data its bytes'
    );
    expect(mediaRefusal({ data: JPEG, mime: '' })).toBe('no type is not a media type');
    expect(mediaRefusal({ data: JPEG, mime: 'Image/JPEG' })).toBe('Image/JPEG is not a media type');
    expect(mediaRefusal({ data: JPEG, mime: 'image/jpeg', width: 0 })).toBe(
      'a media is { data, mime }, data its bytes'
    );
    expect(mediaRefusal(fakeMedia('application/pdf'), { kinds: ['image'] })).toBe(
      'application/pdf is a document, not image'
    );
    expect(mediaRefusal(fakeMedia('image/gif'), { kinds: ['video', 'audio'] })).toBe(
      'image/gif is an image, not video or audio'
    );
    expect(mediaRefusal(fakeMedia('image/gif'), { mimes: ['image/png'] })).toBe(
      'image/gif is not a type taken here (image/png)'
    );
    expect(mediaRefusal({ data: JPEG, mime: 'image/png' })).toBe(
      'its bytes are image/jpeg, not the image/png it says'
    );
    expect(mediaRefusal(fakeMedia('image/png', { size: 2048 }), { maxBytes: 1024 })).toBe(
      '2.0 KiB, more than the 1.0 KiB taken here'
    );
    expect(
      mediaRefusal(fakeMedia('image/png', { size: 1024 }), { maxBytes: 1024, kinds: ['image'] })
    ).toBeUndefined();
  });

  it('says sizes in words', () => {
    expect(sizeInWords(512)).toBe('512 B');
    expect(sizeInWords(1536)).toBe('1.5 KiB');
    expect(sizeInWords(10 * 1048576)).toBe('10.0 MiB');
  });
});

describe('the schemas', () => {
  it('take a media and a media result, refusing what is neither', () => {
    expect(mediaSchema.safeParse(fakeMedia()).success).toBe(true);
    expect(mediaSchema.safeParse({ data: 'abc', mime: 'image/png' }).success).toBe(false);
    expect(mediaResultSchema.safeParse({ ok: true, media: fakeMedia() }).success).toBe(true);
    expect(mediaResultSchema.safeParse({ ok: true, media: null }).success).toBe(true);
    expect(mediaResultSchema.safeParse({ ok: false, error: 'gone' }).success).toBe(true);
    expect(mediaResultSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

describe('the dev kit’s media', () => {
  it('makes media whose bytes are the type they say, of a size, with pixels given', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'])
      expect(sniffMime(fakeMedia(mime).data)).toBe(mime);
    expect(fakeMedia().mime).toBe('image/png');
    expect(fakeMedia('video/mp4', { size: 3 }).data.byteLength).toBe(3);
    expect(fakeMedia('image/png', { size: 2 }).data.byteLength).toBe(8);
    expect(fakeMedia('image/png', { width: 640, height: 480 })).toMatchObject({
      width: 640,
      height: 480,
    });
    expect(assertMedia(fakeMedia('video/mp4'), { kinds: ['video'] }).mime).toBe('video/mp4');
    expect(() => assertMedia({ data: JPEG, mime: 'image/png' })).toThrow(
      'not a media: its bytes are image/jpeg, not the image/png it says'
    );
  });
});

describe('mediaOfFile', () => {
  it('answers a plugin’s file as a media, with the type kept with it; none for none', async () => {
    const got: unknown[] = [];
    const room = fakeMedia('image/png', { size: 32 });
    const kit = new DevKit({
      plugins: [
        definePlugin({
          manifest: {
            id: 'quest-state',
            version: '0.1.0',
            kinds: ['agent'],
            description: 'Keeps the pictures of the rooms',
          },
          create: (ctx) => ({
            start() {
              ctx.store.files.write('room-1', room.data, { type: 'image/png' });
              got.push(mediaOfFile(ctx.store.files, 'room-1'));
              got.push(mediaOfFile(ctx.store.files, 'room-2'));
            },
          }),
        }),
      ],
    });
    await kit.start();
    expect(got).toEqual([{ data: room.data, mime: 'image/png' }, undefined]);
    await kit.stop();
    // A file listed without a type (as a store could not tell) is plain bytes.
    expect(mediaOfFile({ read: () => JPEG, list: () => [] }, 'x')).toEqual({
      data: JPEG,
      mime: 'application/octet-stream',
    });
  });
});
