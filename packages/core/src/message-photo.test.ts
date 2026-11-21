import { describe, expect, it } from 'vitest';
import { DevKit, FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import {
  type FetchPhoto,
  imageMime,
  PHOTO_MAX_BYTES,
  photoAction,
  photoTooLarge,
} from './message-photo.ts';
import { definePlugin } from './plugin.ts';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
const ROOM = { data: JPEG, mime: 'image/jpeg', width: 800, height: 600 };

describe('imageMime', () => {
  it('reads JPEG, PNG, GIF and WebP from their first bytes; nothing else', () => {
    expect(imageMime(JPEG)).toBe('image/jpeg');
    expect(imageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png'
    );
    expect(imageMime(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(imageMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(imageMime(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt '))).toBeUndefined();
    expect(imageMime(new Uint8Array([]))).toBeUndefined();
  });
});

describe('photoTooLarge', () => {
  it('refuses a photo over 10 MiB, saying its size; not one unknown or within it', () => {
    expect(photoTooLarge(undefined)).toBeUndefined();
    expect(photoTooLarge(PHOTO_MAX_BYTES)).toBeUndefined();
    expect(photoTooLarge(PHOTO_MAX_BYTES + 1)).toBe(
      'the photo is 10.0 MiB, more than the 10.0 MiB a photo may be'
    );
    expect(photoTooLarge(20 * 1024 * 1024)).toBe(
      'the photo is 20.0 MiB, more than the 10.0 MiB a photo may be'
    );
  });
});

describe('photoAction', () => {
  it('answers the photo, none, or why not, logging each call without its bytes', async () => {
    const logs: string[] = [];
    const photos: Record<string, unknown> = { '1': ROOM, '2': null };
    const act = photoAction(
      {
        account: 'telegram:alice',
        photo: (_chat, message) => {
          if (message === '3') return Promise.reject(new Error('no message 3 in #lobby'));
          if (message === '4') return Promise.reject('odd');
          if (message === '5')
            return Promise.resolve({
              data: new Uint8Array(PHOTO_MAX_BYTES + 1),
              mime: 'image/jpeg',
            });
          return Promise.resolve(photos[message] as typeof ROOM | null);
        },
      },
      (l) => logs.push(l)
    );
    expect(await act({ chat: '#lobby', message: '1' }, { node: 'postcard' })).toEqual({
      ok: true,
      photo: ROOM,
    });
    expect(await act({ chat: '#lobby', message: '2' })).toEqual({ ok: true, photo: null });
    expect(await act({ chat: '#lobby', message: '3' })).toEqual({
      ok: false,
      error: 'no message 3 in #lobby',
    });
    expect(await act({ chat: '#lobby', message: '4' })).toEqual({ ok: false, error: 'odd' });
    expect(await act({ chat: '#lobby', message: '5' })).toMatchObject({
      ok: false,
      error: 'the photo is 10.0 MiB, more than the 10.0 MiB a photo may be',
    });
    expect(await act({ chat: '#lobby' } as never)).toEqual({
      ok: false,
      error: 'a photo request is { chat, message }',
    });
    expect(logs).toEqual([
      'photo of message 1 in #lobby, for postcard: 6 bytes',
      'photo of message 2 in #lobby, for (owner): none',
      'photo of message 3 in #lobby, for (owner): refused: no message 3 in #lobby',
      'photo of message 4 in #lobby, for (owner): refused: odd',
      'photo of message 5 in #lobby, for (owner): refused: the photo is 10.0 MiB, more than the 10.0 MiB a photo may be',
    ]);
  });

  it('refuses every request without a connector that fetches photos', async () => {
    expect(await photoAction(undefined)({ chat: '#lobby', message: '1' })).toEqual({
      ok: false,
      error: 'not logged in',
    });
    expect(
      await photoAction(
        { account: 'irc:alice' },
        undefined,
        'no photos on IRC'
      )({
        chat: '#lobby',
        message: '1',
      })
    ).toEqual({ ok: false, error: 'no photos on IRC' });
  });
});

describe('a fake connector’s photos (D151)', () => {
  /** A plugin that asks the fake's node for the photos of `messages`, through its interface. */
  const postcard = (asked: unknown[], messages: string[]) =>
    definePlugin({
      manifest: {
        id: 'postcard',
        version: '0.1.0',
        kinds: ['agent'],
        description: 'Keeps the pictures of the rooms',
        inputs: { tg: { type: 'interface', plugin: 'telegram-user', members: ['actions.photo'] } },
      },
      create: (ctx) => ({
        async start() {
          const { actions } = ctx.use<{ actions: { photo: FetchPhoto } }>('tg');
          for (const message of messages)
            asked.push(await actions.photo({ chat: '-100123', message }));
        },
      }),
    });

  it('answers the photos it is given, through its plugin’s interface', async () => {
    const fake = new FakeConnector({
      account: 'telegram:alice',
      photos: [
        { chat: '-100123', message: '42', photo: ROOM },
        { chat: '-100123', message: '43', photo: 'CHANNEL_PRIVATE' },
      ],
    });
    fake.givePhoto('-100123', '44', { data: JPEG, mime: 'image/jpeg' });
    const asked: unknown[] = [];
    const kit = new DevKit({
      plugins: [
        fakeConnectorPlugin('telegram-user', fake),
        postcard(asked, ['42', '43', '44', '45']),
      ],
    });
    await kit.start();
    expect(asked).toEqual([
      { ok: true, photo: ROOM },
      { ok: false, error: 'CHANNEL_PRIVATE' },
      { ok: true, photo: { data: JPEG, mime: 'image/jpeg' } },
      { ok: true, photo: null },
    ]);
    await kit.stop();
  });

  it('fetches none, and offers no interface, unless given photos', () => {
    const fake = new FakeConnector({ account: 'telegram:alice' });
    expect(fake.photo).toBeUndefined();
    expect(() => fake.givePhoto('-100123', '1', 'gone')).toThrow(
      'telegram:alice was made without photos'
    );
    expect(fakeConnectorPlugin('telegram-user', fake).manifest.interface).toBeUndefined();
    const given = new FakeConnector({ account: 'telegram:alice', photos: [] });
    const { manifest } = fakeConnectorPlugin('telegram-user', given);
    expect(Object.keys(manifest.interface?.actions ?? {})).toEqual(['photo']);
  });
});
