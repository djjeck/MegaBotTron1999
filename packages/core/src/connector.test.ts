import { describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import {
  type Connector,
  ConnectorBase,
  DOCUMENT_MAX_BYTES,
  handleOf,
  hears,
  type Inbound,
  isTextDocument,
  readDocument,
  type ReadFilter,
} from './connector.ts';
import { Core } from './core.ts';
import { definePlugin } from './plugin.ts';

class TestConnector extends ConnectorBase implements Connector {
  sent: string[] = [];
  send(chat: string, text: string): boolean {
    this.sent.push(`${chat} ${text}`);
    return true;
  }
  hear(text: string, chat = 'c', sender = 's', own?: boolean): void {
    this.received({
      chat,
      sender,
      text,
      time: 1,
      playback: false,
      ...(own === undefined ? {} : { own }),
    });
  }
  call(name: string): void {
    this.named(name);
  }
  up(): void {
    this.changed({ state: 'connected', phase: 'up' });
  }
}

const manifest = (id: string, account?: string) => ({
  id,
  version: '0.1.0',
  kinds: ['connector' as const],
  description: id,
  ...(account === undefined ? {} : { account }),
});

describe('connectors', () => {
  it('hear only the chats a handle reads, without case, and tell their own name', () => {
    const c = new TestConnector('test:me', 'test');
    const heard: string[] = [];
    const all: string[] = [];
    handleOf(c, { reads: ['#Lobby', '@Bot'] }).onMessage((m) => heard.push(m.chat));
    handleOf(c).onMessage((m) => all.push(m.chat));
    c.hear('a', '#lobby');
    c.hear('b', '@bot');
    c.hear('c', '-100123');
    expect(heard).toEqual(['#lobby', '@bot']);
    expect(all).toEqual(['#lobby', '@bot', '-100123']);
    expect(handleOf(c).self()).toBeUndefined();
    c.call('me');
    expect(handleOf(c).self()).toBe('me');
  });

  it('hear any chat with *, and only the senders a handle reads, me the account’s own', () => {
    const c = new TestConnector('test:me', 'test');
    const any: string[] = [];
    const some: string[] = [];
    handleOf(c, { reads: '*' }).onMessage((m) => any.push(m.text));
    handleOf(c, { reads: '*', senders: ['@QuestBot', 'me'] }).onMessage((m) => some.push(m.text));
    c.call('alice');
    c.hear('a', '#lobby', 'questbot');
    c.hear('b', '-100123', 'bob');
    c.hear('c', '@QuestBot', '', true);
    c.hear('d', '#lobby', 'Alice');
    c.hear('e', '#lobby', '');
    expect(any).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(some).toEqual(['a', 'c', 'd']);
  });

  it('match a read filter by chat and sender', () => {
    const m = (chat: string, sender: string, own?: boolean): Inbound => ({
      account: 'test:me',
      network: 'test',
      chat,
      sender,
      text: 't',
      time: 1,
      playback: false,
      ...(own === undefined ? {} : { own }),
    });
    expect(hears({ reads: ['#a'] }, m('#A', 'x'))).toBe(true);
    expect(hears({ reads: ['#a'] }, m('#b', 'x'))).toBe(false);
    expect(hears({ reads: '*', senders: ['me'] }, m('#b', 'x', true))).toBe(true);
    expect(hears({ reads: '*', senders: ['me'] }, m('#b', 'x'))).toBe(false);
    expect(hears({ reads: '*', senders: ['me'] }, m('#b', 'x'), 'X')).toBe(true);
    expect(hears({ reads: '*', senders: [] }, m('#b', 'x'))).toBe(false);
  });

  it('stop hearing when told to, and keep the status of their last change', () => {
    const c = new TestConnector('test:me', 'test');
    const heard: string[] = [];
    const states: string[] = [];
    const stop = c.onMessage((m) => heard.push(`${m.account} ${m.text}`));
    c.onStatus((s) => states.push(s.state));
    c.hear('one');
    stop();
    c.hear('two');
    c.up();
    expect(heard).toEqual(['test:me one']);
    expect(states).toEqual(['connected']);
    const h = handleOf(c);
    expect(h.status()).toEqual({ state: 'connected', phase: 'up' });
    expect('send' in h).toBe(false);
    h.onMessage((m) => heard.push(m.text));
    h.onStatus(() => states.push('again'));
    c.hear('three');
    c.up();
    expect(heard.at(-1)).toBe('three');
    expect(states.at(-1)).toBe('again');
  });

  it('fail a connector plugin that offers no connector, or one of another account', async () => {
    const core = new Core({ clock: new VirtualClock() });
    core.register(
      definePlugin({ manifest: manifest('none', 'test:me'), create: () => ({}) }),
      definePlugin({
        manifest: manifest('other', 'test:them'),
        create: () => ({ connector: new TestConnector('test:you', 'test') }),
      })
    );
    await core.start();
    expect(core.status()).toEqual([
      { id: 'none', state: 'failed', reason: 'a connector plugin offers no connector' },
      {
        id: 'other',
        state: 'failed',
        reason: "its connector's account is test:you, not test:them",
      },
    ]);
  });

  it('give no handle on a connector that is not running', async () => {
    const core = new Core({ clock: new VirtualClock() });
    let error: unknown;
    core.register(
      definePlugin({ manifest: manifest('down', 'test:me'), create: () => ({}) }),
      definePlugin({
        manifest: {
          id: 'reader',
          version: '0.1.0',
          kinds: ['stats'],
          description: 'reader',
          requires: [],
          reach: [{ connector: 'down' }],
        },
        create: (ctx) => {
          try {
            ctx.connector('down');
          } catch (e) {
            error = e;
          }
          return {};
        },
      })
    );
    await core.start();
    expect(String(error)).toContain('down is not a running connector');
  });

  it('let each reader hear only its edge’s chats and senders', async () => {
    const c = new TestConnector('test:me', 'test');
    const heard: Record<string, string[]> = { a: [], b: [] };
    let readers: (() => ReadFilter[]) | undefined;
    let readerHasNone = false;
    const reader = (id: string) =>
      definePlugin({
        manifest: {
          id,
          version: '0.1.0',
          kinds: ['parser'],
          description: id,
          inputs: { chat: { type: 'chat-in' } },
        },
        create: (ctx) => {
          readerHasNone ||= ctx.readers === undefined;
          ctx.connector('chat').onMessage((m) => heard[id]?.push(m.text));
          return {};
        },
      });
    const core = new Core({
      clock: new VirtualClock(),
      graph: {
        version: 2,
        nodes: [
          { id: 'test', plugin: 'test' },
          { id: 'a', plugin: 'a' },
          { id: 'b', plugin: 'b' },
        ],
        edges: [
          { from: 'test.chat', to: 'a.chat', reads: '*', senders: ['@QuestBot', 'me'] },
          { from: 'test.chat', to: 'b.chat', reads: ['#lobby'] },
        ],
      },
    });
    core.register(
      definePlugin({
        manifest: manifest('test', 'test:me'),
        create: (ctx) => {
          readers = ctx.readers;
          return { connector: c };
        },
      }),
      reader('a'),
      reader('b')
    );
    await core.start();
    c.hear('one', '#lobby', 'QuestBot');
    c.hear('two', '#other', 'bob');
    c.hear('three', '#other', '', true);
    c.hear('four', '#lobby', 'bob');
    expect(heard).toEqual({ a: ['one', 'three'], b: ['one', 'four'] });
    expect(core.graph()?.edges[0]).toMatchObject({ reads: '*', senders: ['@QuestBot', 'me'] });
    // The connector learns what its readers read from the graph (its catch-up's chats, D62).
    expect(readers?.()).toEqual([
      { reads: '*', senders: ['@QuestBot', 'me'] },
      { reads: ['#lobby'] },
    ]);
    expect(readerHasNone).toBe(true);
    // A reader stopped is no reader (D66): its chats are not fetched back.
    core.stopNode('b', 'enough', 'owner');
    expect(readers?.()).toEqual([{ reads: '*', senders: ['@QuestBot', 'me'] }]);
    await core.stop();
  });

  it('gives a connector the readers about to start, and none disabled', async () => {
    let readers: (() => ReadFilter[]) | undefined;
    let atCreate: ReadFilter[] | undefined;
    const reader = (id: string) =>
      definePlugin({
        manifest: {
          id,
          version: '0.1.0',
          kinds: ['parser'],
          description: id,
          inputs: { chat: { type: 'chat-in' } },
        },
        create: () => ({}),
      });
    const core = new Core({
      clock: new VirtualClock(),
      graph: {
        version: 2,
        nodes: [
          { id: 'test', plugin: 'test' },
          { id: 'a', plugin: 'a' },
          { id: 'b', plugin: 'b', disabled: true },
        ],
        edges: [
          { from: 'test.chat', to: 'a.chat', reads: ['#lobby'] },
          { from: 'test.chat', to: 'b.chat', reads: ['#other'] },
        ],
      },
    });
    core.register(
      definePlugin({
        manifest: manifest('test', 'test:me'),
        create: (ctx) => {
          readers = ctx.readers;
          atCreate = ctx.readers?.();
          return { connector: new TestConnector('test:me', 'test') };
        },
      }),
      reader('a'),
      reader('b')
    );
    await core.start();
    expect(atCreate).toEqual([{ reads: ['#lobby'] }]);
    expect(readers?.()).toEqual([{ reads: ['#lobby'] }]);
    await core.stop();
  });
});

describe('documents (D82)', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const LIST = 'Backpack\n- 3 x Rusty Spoon\n- 1 x Paper Hat\n';

  it('reads text by its type, or by its name under a generic one', () => {
    expect(isTextDocument('list.bin', 'text/plain; charset=utf-8')).toBe(true);
    expect(isTextDocument('', 'Text/CSV')).toBe(true);
    expect(isTextDocument('', 'application/json')).toBe(true);
    expect(isTextDocument('list.TXT', 'application/octet-stream')).toBe(true);
    expect(isTextDocument('list.csv', '')).toBe(true);
    expect(isTextDocument('list.exe', 'application/octet-stream')).toBe(false);
    expect(isTextDocument('list.txt', 'image/png')).toBe(false);
    expect(isTextDocument('', '')).toBe(false);
  });

  it('downloads a small text file, its byte-order mark taken off', async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(LIST)]);
    expect(
      await readDocument(
        { name: 'backpack.txt', mime: 'Text/Plain; charset=UTF-8', size: 40 },
        () => Promise.resolve(withBom)
      )
    ).toEqual({ name: 'backpack.txt', mime: 'text/plain', size: withBom.byteLength, text: LIST });
  });

  it('gives the rest as metadata only, with why', async () => {
    let downloads = 0;
    const download = () => (downloads++, Promise.resolve(bytes(LIST)));
    expect(await readDocument({ name: 'hat.png', mime: 'image/png', size: 9 }, download)).toEqual({
      name: 'hat.png',
      mime: 'image/png',
      size: 9,
      skipped: 'type',
    });
    expect(await readDocument({}, download)).toEqual({
      name: '',
      mime: '',
      size: 0,
      skipped: 'type',
    });
    expect(
      await readDocument(
        { name: 'big.txt', mime: 'text/plain', size: DOCUMENT_MAX_BYTES + 1 },
        download
      )
    ).toMatchObject({ skipped: 'size', size: DOCUMENT_MAX_BYTES + 1 });
    expect(downloads).toBe(0);
  });

  it('checks what it downloaded: its size, and that it is UTF-8 text', async () => {
    const meta = { name: 'list.txt', mime: 'text/plain', size: 10 };
    const big = new Uint8Array(DOCUMENT_MAX_BYTES + 1).fill(0x61);
    expect(await readDocument(meta, () => Promise.resolve(big))).toEqual({
      ...meta,
      size: DOCUMENT_MAX_BYTES + 1,
      skipped: 'size',
    });
    expect(
      await readDocument(meta, () => Promise.resolve(new Uint8Array([0x61, 0xff, 0x62])))
    ).toEqual({ ...meta, size: 3, skipped: 'encoding' });
    expect(
      await readDocument(meta, () => Promise.resolve(new Uint8Array([0x61, 0x00, 0x62])))
    ).toEqual({ ...meta, size: 3, skipped: 'encoding' });
  });

  it('delivers a failed download as metadata, told', async () => {
    const warned: string[] = [];
    const meta = { name: 'list.txt', mime: 'text/plain', size: 10 };
    expect(
      await readDocument(
        meta,
        () => Promise.reject(new Error('timeout')),
        (l) => warned.push(l)
      )
    ).toEqual({ ...meta, skipped: 'failed' });
    expect(await readDocument({ ...meta, name: '' }, () => Promise.reject(new Error('x')))).toEqual(
      { ...meta, name: '', skipped: 'failed' }
    );
    expect(await readDocument(meta, () => Promise.resolve(undefined))).toEqual({
      ...meta,
      skipped: 'failed',
    });
    expect(warned).toEqual(['download of list.txt failed: Error: timeout']);
  });
});
