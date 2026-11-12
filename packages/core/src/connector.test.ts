import { describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import {
  type Connector,
  ConnectorBase,
  handleOf,
  hears,
  type Inbound,
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
    await core.stop();
  });
});
