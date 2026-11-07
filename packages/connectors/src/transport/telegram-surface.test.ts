import { type ConnectorStatus } from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { stubBot } from '#test/telegram.ts';
import { loggerOf, TelegramSurface } from './telegram-surface.ts';

describe('TelegramSurface', () => {
  it('serves once, tells in order once served, and sets the menus each time it connects', async () => {
    const stub = stubBot();
    const lines: string[] = [];
    let status: (s: ConnectorStatus) => void = () => {};
    const surface = new TelegramSurface({
      bot: stub.bot,
      owner: 4242,
      log: (l) => lines.push(l),
      now: () => 0,
      onStatus: (l) => (status = l),
    });
    let listening = false;
    void surface.listening.then(() => (listening = true));
    surface.tell('before', [[{ label: 'Kill', action: 'kill' }]]);
    await new Promise((r) => setTimeout(r, 10));
    expect(stub.calls).toEqual([]);
    surface.serve([]);
    surface.serve([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(listening).toBe(true);
    expect(stub.calls.map((c) => c.method)).toEqual(['sendMessage']);
    status({ state: 'connecting', phase: 'restarting' });
    status({ state: 'connected', phase: 'polling' });
    await new Promise((r) => setTimeout(r, 10));
    // The author's menu (empty here, so deleted) and the private chats'.
    expect(stub.calls.map((c) => c.method)).toEqual([
      'sendMessage',
      'deleteMyCommands',
      'setMyCommands',
    ]);
    surface.stop();
    expect(lines).toContain('telegram: command menu of author set');
  });
});

describe('loggerOf', () => {
  it('logs the switchboard’s lines with their level and fields', () => {
    const lines: string[] = [];
    const log = loggerOf((l) => lines.push(l));
    log.info('a');
    log.warn('b', { x: 1 });
    log.error('c');
    expect(lines).toEqual(['a', 'warning: b {"x":1}', 'error: c']);
  });
});
