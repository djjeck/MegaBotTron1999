import { describe, expect, it } from 'vitest';
import { telegramEdit, telegramNotify } from './telegram-notifier.ts';

const settle = () => new Promise((r) => setTimeout(r, 10));

/** A switchboard that records what it is asked to send and edit, failing while `failing` says so. */
function fake() {
  const sent: unknown[] = [];
  const edited: unknown[] = [];
  const state = { failing: false };
  const switchboard = {
    send: async (o: unknown) => {
      if (state.failing) throw new Error('down');
      sent.push(o);
      return { messageIds: [1], fileIds: [] };
    },
    edit: async (o: unknown) => {
      if (state.failing) throw new Error('down');
      edited.push(o);
    },
  };
  return { switchboard, sent, edited, state };
}

describe('telegramNotify', () => {
  it('sends each message to the topic, in order', async () => {
    const f = fake();
    const notify = telegramNotify({ switchboard: f.switchboard, topic: 'author' });
    notify('one');
    notify('two', [[{ label: 'Pause', action: 'pause' }]]);
    await settle();
    expect(f.sent).toEqual([
      { topic: 'author', text: 'one' },
      { topic: 'author', text: 'two', buttons: [[{ label: 'Pause', action: 'pause' }]] },
    ]);
  });

  it('reports a failing bot once, and goes on', async () => {
    const f = fake();
    const warned: string[] = [];
    const notify = telegramNotify({
      switchboard: f.switchboard,
      topic: 'author',
      warn: (l) => warned.push(l),
    });
    f.state.failing = true;
    notify('a');
    notify('b');
    await settle();
    f.state.failing = false;
    notify('c');
    await settle();
    f.state.failing = true;
    notify('d');
    await settle();
    expect(warned).toEqual(['notify failed: Error: down', 'notify failed: Error: down']);
    expect(f.sent).toEqual([{ topic: 'author', text: 'c' }]);
  });
});

describe('telegramEdit', () => {
  it('edits a message, keeping its buttons when none are given, and reports a failure', async () => {
    const f = fake();
    const warned: string[] = [];
    const edit = telegramEdit({
      switchboard: f.switchboard,
      topic: 'author',
      warn: (l) => warned.push(l),
    });
    edit(7, 'card', [[{ label: '✅ Bob', action: 'target:Bob' }]]);
    edit(7, 'card');
    await settle();
    f.state.failing = true;
    edit(7, 'card');
    await settle();
    expect(f.edited).toEqual([
      {
        topic: 'author',
        messageId: 7,
        text: 'card',
        buttons: [[{ label: '✅ Bob', action: 'target:Bob' }]],
      },
      { topic: 'author', messageId: 7, text: 'card' },
    ]);
    expect(warned).toEqual(['edit failed: Error: down']);
  });
});
