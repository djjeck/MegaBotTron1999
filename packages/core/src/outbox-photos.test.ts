/**
 * A photo through the outbox (bot-os.md D150): sent, queued and delivered as a text is, through the
 * same checks but a command's; its caption checked, its id answered, and logged without its bytes.
 */
import { describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import { CAPTION_MAX, captionRefusal, type CommandPhoto, photoRefusal } from './commands.ts';
import { type Connector, ConnectorBase, type ConnectorPhotoOptions } from './connector.ts';
import { Core } from './core.ts';
import { FakeConnector, fakeMedia } from './devkit.ts';
import { type Notice } from './notices.ts';
import {
  FloodWait,
  Outbox,
  type PhotoSend,
  type QueueRecord,
  type SenderPolicy,
  type SendRecord,
} from './outbox.ts';

/** A connector whose photos answer later, as Telegram's do; with no `deliverPhoto` if `noPhotos`. */
class PhotoConnector extends ConnectorBase implements Connector {
  calls: { chat: string; photo: CommandPhoto; options?: ConnectorPhotoOptions }[] = [];
  texts: string[] = [];
  answers: (() => Promise<{ id?: string; photo?: string }>)[] = [];
  deliverPhoto?: NonNullable<Connector['deliverPhoto']>;
  constructor(noPhotos = false) {
    super('test:me', 'test');
    this.changed({ state: 'connected', phase: 'up' });
    if (!noPhotos)
      this.deliverPhoto = (chat, photo, options) => {
        this.calls.push({ chat, photo, ...(options === undefined ? {} : { options }) });
        return (this.answers.shift() ?? (() => Promise.resolve({ id: '7', photo: 'file-7' })))();
      };
  }
  send(chat: string, text: string): boolean {
    this.texts.push(`${chat} ${text}`);
    return true;
  }
  down(): void {
    this.changed({ state: 'connecting', phase: 'retry' });
  }
}

const BYTES: PhotoSend = { photo: fakeMedia('image/png', { size: 3 * 8 }) };

function setup(
  o: { policy?: SenderPolicy; connector?: PhotoConnector | null; watch?: boolean } = {}
) {
  const clock = new VirtualClock(0);
  const connector = o.connector === undefined ? new PhotoConnector() : o.connector;
  const records: SendRecord[] = [];
  const queue: QueueRecord[] = [];
  const notices: Omit<Notice, 't'>[] = [];
  const paused: string[] = [];
  const expected: string[] = [];
  const outbox = new Outbox({
    account: 'test:me',
    connector: () => connector ?? undefined,
    limits: () => ({ minIntervalMs: 3000, maxPerHour: 10, unansweredAt: 1 }),
    clock,
    policy: () => o.policy ?? {},
    record: (r) =>
      r.type === 'core.send'
        ? void records.push(r)
        : r.type === 'core.queue'
          ? void queue.push(r)
          : undefined,
    notice: (n) => void notices.push(n),
    ...(o.watch === true
      ? {
          watch: () => true,
          pause: (p: string) => void paused.push(p),
          expects: (_chat: string, command: string) => (expected.push(command), 60_000),
        }
      : {}),
  });
  return {
    clock,
    connector,
    records,
    queue,
    notices,
    paused,
    expected,
    outbox,
    p: outbox.as('p'),
  };
}

describe('a photo through the outbox (D150)', () => {
  it('delivers it with its caption, format and reply, and answers its id; logs no bytes', async () => {
    const { p, connector, records } = setup();
    const r = await p.deliver(
      '#lobby',
      { ...BYTES, caption: 'A *card*', replyTo: '41' },
      { format: 'markdown', origin: 'painter' }
    );
    expect(r).toEqual({
      text: '[photo image/png, 24 bytes]',
      outcome: 'sent',
      id: '7',
      photo: 'file-7',
    });
    expect(connector?.calls).toEqual([
      {
        chat: '#lobby',
        photo: BYTES.photo,
        options: { caption: 'A *card*', format: 'markdown', replyTo: '41' },
      },
    ]);
    expect(records).toEqual([
      expect.objectContaining({
        text: '[photo image/png, 24 bytes]',
        outcome: 'sent',
        origin: 'painter',
        caption: 8,
        photo: 'file-7',
      }),
    ]);
    // Never its bytes.
    expect(JSON.stringify(records)).not.toContain('"data"');
  });

  it('sends one by its id with nothing more, now or queued, and never coalesces it', async () => {
    const { p, outbox, connector, records, clock } = setup();
    expect(p.send('#lobby', { photo: 'file-1' })).toEqual({ text: '[photo]', outcome: 'sent' });
    expect(connector?.calls[0]).toEqual({ chat: '#lobby', photo: 'file-1' });
    expect(records.at(-1)).not.toHaveProperty('caption');
    const a = p.enqueue('#lobby', { photo: 'file-1', caption: 'again' });
    const b = outbox.as('q').enqueue('#lobby', { photo: 'file-1', caption: 'again' });
    // A text that reads as a photo's label is no photo either.
    const c = outbox.as('r').enqueue('#lobby', '[photo]');
    expect(outbox.waiting).toBe(3);
    clock.advance(3000);
    await expect(a).resolves.toEqual({ text: '[photo]', outcome: 'sent', photo: 'file-7' });
    clock.advance(3000);
    await expect(b).resolves.toMatchObject({ outcome: 'sent', photo: 'file-7' });
    clock.advance(3000);
    await expect(c).resolves.toMatchObject({ text: '[photo]', outcome: 'sent' });
    expect(connector?.texts).toEqual(['#lobby [photo]']);
    expect(connector?.calls).toHaveLength(3);
    expect(outbox.coalesced().count).toBe(0);
  });

  it('lets one through an edge that names commands only where it, or its output, says photos', () => {
    const only = setup({ policy: { reach: { sends: ['#lobby'], commands: ['!play'] } } });
    expect(only.p.send('#lobby', BYTES).reason).toBe(
      "a photo is not among p's commands: its edge or output must say photos"
    );
    expect(only.p.send('#lobby', '!play now').outcome).toBe('sent');
    const allowed = setup({
      policy: { reach: { sends: ['#lobby'], commands: ['!play'], photos: true } },
    });
    expect(allowed.p.send('#lobby', BYTES).outcome).toBe('sent');
    // Photos say nothing of texts: a command not named stays refused.
    expect(allowed.p.send('#lobby', '!quit').reason).toBe("!quit is not among p's commands");
    const any = setup({ policy: { reach: { sends: ['#lobby'] } } });
    expect(any.p.send('#lobby', BYTES).outcome).toBe('sent');
    expect(any.p.send('#elsewhere', BYTES).reason).toBe('p does not send to #elsewhere');
  });

  it('refuses a caption over CAPTION_MAX before sending, now, queued or delivered', async () => {
    const { p, connector, records } = setup();
    const long = { ...BYTES, caption: 'x'.repeat(CAPTION_MAX + 1) };
    const why = `a caption of ${CAPTION_MAX + 1} characters, over the ${CAPTION_MAX} a photo may carry`;
    expect(p.send('#lobby', long).reason).toBe(why);
    await expect(p.enqueue('#lobby', long)).resolves.toMatchObject({ outcome: 'refused' });
    await expect(p.deliver('#lobby', long)).resolves.toMatchObject({ reason: why });
    expect(connector?.calls).toEqual([]);
    expect(records.map((r) => r.caption)).toEqual([1025, 1025, 1025]);
    const fits = await p.deliver('#lobby', { ...BYTES, caption: 'x'.repeat(CAPTION_MAX) });
    expect(fits.outcome).toBe('sent');
  });

  it('counts an HTML caption by the text it shows, as Telegram does (D164)', async () => {
    const { p, connector } = setup();
    const shown = `<blockquote><b>${'x'.repeat(CAPTION_MAX - 1)}&amp;</b></blockquote>`;
    const fits = await p.deliver('#lobby', { ...BYTES, caption: shown }, { format: 'html' });
    expect(fits.outcome).toBe('sent');
    expect(connector?.calls[0]?.options).toEqual({ caption: shown, format: 'html' });
    const over = await p.deliver(
      '#lobby',
      { ...BYTES, caption: `<b>${'x'.repeat(CAPTION_MAX + 1)}</b>` },
      { format: 'html' }
    );
    expect(over.reason).toBe(
      `a caption of ${CAPTION_MAX + 1} characters, over the ${CAPTION_MAX} a photo may carry`
    ); // As a command's answer checks it (Answer.photo), and Markdown's marks still count.
    expect(photoRefusal('file-1', shown, 'html')).toBeUndefined();
    expect(captionRefusal(`**${'x'.repeat(CAPTION_MAX - 1)}**`, 'markdown')).toBe(
      `a caption of ${CAPTION_MAX + 3} characters, over the ${CAPTION_MAX} a photo may carry`
    );
  });

  it('refuses bytes that are no photo, or not the type they say, before sending (D153)', async () => {
    const { p, connector } = setup();
    expect(p.send('#lobby', { photo: fakeMedia('application/pdf') }).reason).toBe(
      'the photo: application/pdf is not a type taken here (image/jpeg, image/png, image/gif, image/webp)'
    );
    await expect(
      p.deliver('#lobby', { photo: { data: new Uint8Array([1, 2, 3]), mime: 'image/png' } })
    ).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'the photo: its bytes are not image/png, as it says',
    });
    await expect(
      p.enqueue('#lobby', { photo: { ...fakeMedia('image/jpeg'), mime: 'image/png' } })
    ).resolves.toMatchObject({ outcome: 'refused' });
    expect(connector?.calls).toEqual([]);
  });

  it('is refused by a connector that cannot send photos, and while none runs or connects', async () => {
    const none = setup({ connector: new PhotoConnector(true) });
    expect(none.p.send('#lobby', BYTES).reason).toBe('test:me cannot send photos');
    await expect(none.p.deliver('#lobby', BYTES)).resolves.toMatchObject({
      reason: 'test:me cannot send photos',
    });
    await expect(none.p.enqueue('#lobby', BYTES)).resolves.toMatchObject({ outcome: 'refused' });
    const gone = setup({ connector: null });
    expect(gone.p.send('#lobby', BYTES).reason).toBe('not connected');
    await expect(gone.p.deliver('#lobby', BYTES)).resolves.toMatchObject({
      reason: 'not connected',
    });
    const down = setup();
    down.connector?.down();
    expect(down.p.send('#lobby', BYTES).reason).toBe('not connected');
    await expect(down.p.deliver('#lobby', BYTES)).resolves.toMatchObject({
      reason: 'not connected',
    });
  });

  it('keeps a dry run, a stop and the rate, as a text does', async () => {
    const dry = setup({ policy: { reach: { sends: ['#lobby'], dryRun: true } } });
    await expect(dry.p.deliver('#lobby', BYTES)).resolves.toMatchObject({ outcome: 'dry-run' });
    expect(dry.p.send('#lobby', BYTES).reason).toBe('too soon');
    expect(dry.connector?.calls).toEqual([]);
    expect(dry.records[0]).toMatchObject({ mode: 'dry-run', text: '[photo image/png, 24 bytes]' });
    const held = setup({ policy: { held: 'stopped: drift' } });
    expect(held.p.send('#lobby', BYTES).reason).toBe('stopped: drift');
  });

  it('holds the account on a flood wait, and fails with why on any other refusal', async () => {
    const { p, connector, clock, notices, outbox } = setup();
    connector?.answers.push(
      () => Promise.reject(new FloodWait(30_000)),
      () => Promise.reject(new Error('Bad Request: wrong file identifier')),
      () => Promise.reject(new Error('Forbidden: bot was blocked by the user'))
    );
    await expect(p.deliver('#lobby', BYTES)).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'flood wait of 30 s',
    });
    expect(p.send('#lobby', BYTES).reason).toBe('flood wait, 30 s more');
    clock.advance(30_000);
    await expect(p.deliver('#lobby', { photo: 'stale' })).resolves.toMatchObject({
      outcome: 'failed',
      reason: 'Bad Request: wrong file identifier',
    });
    clock.advance(3000);
    const queued = p.enqueue('#lobby', BYTES);
    await expect(queued).resolves.toMatchObject({
      outcome: 'failed',
      text: '[photo image/png, 24 bytes]',
    });
    expect(notices.map((n) => n.kind)).toEqual(['unreachable', 'unreachable']);
    // A queued photo the network asks to wait for holds the account too.
    connector?.answers.push(() => Promise.reject(new FloodWait(5000)));
    clock.advance(3000);
    await expect(p.enqueue('#lobby', BYTES)).resolves.toMatchObject({ outcome: 'failed' });
    expect(outbox.as('q').send('#lobby', BYTES).reason).toBe('flood wait, 5 s more');
  });

  it('is no command: no watchdog, no answer waited for', async () => {
    const { p, paused, clock, expected } = setup({ watch: true });
    for (let i = 0; i < 3; i++) {
      await expect(p.deliver('#lobby', BYTES)).resolves.toMatchObject({ outcome: 'sent' });
      clock.advance(3000);
      expect(p.send('#lobby', { photo: 'file-7' }).outcome).toBe('sent');
      clock.advance(3000);
    }
    await expect(p.enqueue('#lobby', BYTES)).resolves.toMatchObject({ outcome: 'sent' });
    expect(paused).toEqual([]);
    expect(expected).toEqual([]);
    // A text's second send unanswered pauses its node, as the threshold here says.
    clock.advance(3000);
    expect(p.send('#lobby', '!a').outcome).toBe('sent');
    clock.advance(3000);
    expect(p.send('#lobby', '!a').reason).toMatch(/^stopped: stalled/u);
    expect(paused).toEqual(['p']);
    expect(expected).toEqual(['!a']);
  });
});

describe('a photo through the core (D150)', () => {
  /** A connector plugin on the dev kit's fake, and a painter that sends through it. */
  async function start(o: { output?: boolean; edge?: boolean }) {
    const connector = new FakeConnector({ account: 'test:me' });
    connector.open();
    const seen: { handle?: ReturnType<Outbox['as']> } = {};
    const core = new Core({
      clock: new VirtualClock(),
      graph: (g) => ({
        ...g,
        edges: g.edges.map((e) =>
          e.type === 'chat-out' && o.edge === true ? { ...e, photos: true } : e
        ),
      }),
    });
    core.register(
      {
        manifest: {
          id: 'conn',
          kinds: ['connector'],
          description: 'conn',
          account: 'test:me',
        },
        create: () => ({ connector }),
      },
      {
        manifest: {
          id: 'card-painter',
          kinds: ['actor'],
          description: 'paints cards',
          outputs: {
            chat: {
              type: 'chat-out',
              ...(o.output === true ? { photos: true as const } : {}),
              bind: { node: 'conn', sends: ['#lobby'], commands: ['!card'] },
            },
          },
        },
        create: (ctx) => {
          seen.handle = ctx.outbox('chat');
          return {};
        },
      }
    );
    await core.start();
    return { core, connector, handle: seen.handle as ReturnType<Outbox['as']> };
  }

  it('lets a photo through an edge of commands where the output or the edge says photos', async () => {
    const refused = await start({});
    expect(refused.handle.send('#lobby', BYTES).outcome).toBe('refused');
    await refused.core.stop();
    for (const by of [{ output: true }, { edge: true }]) {
      const { core, connector, handle } = await start(by);
      const r = await handle.deliver(
        '#lobby',
        { photo: BYTES.photo, caption: 'A card', replyTo: '12' },
        { format: 'markdown' }
      );
      expect(r).toMatchObject({ outcome: 'sent', id: 'm1', photo: 'photo-1' });
      expect(connector.sent).toEqual([
        {
          chat: '#lobby',
          text: 'A card',
          photo: BYTES.photo,
          format: 'markdown',
          replyTo: '12',
          id: 'photo-1',
        },
      ]);
      await core.stop();
    }
  });
});
