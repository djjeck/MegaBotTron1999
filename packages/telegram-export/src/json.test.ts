import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOT, Chat, jsonExport, pageHtml, runParse, writeExport } from '#test/helpers.ts';
import { tempDir } from '#test/temp-dir.ts';
import { readJsonFile } from './files.ts';
import { ExportParser } from './html.ts';
import { jsonChats, jsonText, jsonTextFiles, markedChatId, readJsonExport } from './json.ts';

const IDS = { Alice: 111000111, Bob: 222000222, [BOT]: 444000444 };

/** A private chat with the bot and a group, each message as the HTML reader reads it. */
function chats(): { dm: Chat; group: Chat } {
  const dm = new Chat(BOT, 50);
  dm.user('Alice', '/play', 0);
  dm.bot('Found an apple.', 2, { reply_to: 50 });
  const group = new Chat('Quest Lobby', 700);
  group.user('Bob', 'hello all', 5);
  group.user('Alice', '/play@QuestBot now', 6);
  group.forward('Bob', BOT, 'Found a pear.', 7);
  return { dm, group };
}

describe('markedChatId', () => {
  it('names_a_chat_as_the_network_does', () => {
    expect(markedChatId('bot_chat', 42)).toBe('42');
    expect(markedChatId('personal_chat', 42)).toBe('42');
    expect(markedChatId('private_group', 42)).toBe('-42');
    expect(markedChatId('private_supergroup', 42)).toBe('-10042');
    expect(markedChatId('public_supergroup', 42)).toBe('-10042');
    expect(markedChatId('public_channel', 42)).toBe('-10042');
    expect(markedChatId('something_new', 42)).toBeUndefined();
    expect(markedChatId(undefined, 42)).toBeUndefined();
    expect(markedChatId('bot_chat', undefined)).toBeUndefined();
  });
});

describe('jsonText', () => {
  it('is_the_visible_text_of_its_parts_stripped', () => {
    expect(jsonText(' hello ')).toBe('hello');
    expect(
      jsonText([
        { type: 'bot_command', text: '/play@QuestBot' },
        ' now, ',
        { type: 'mention', text: '@bob' },
        { type: 'text_link', text: '!', href: 'https://example.net' },
        { type: 'custom_emoji' },
        null,
      ])
    ).toBe('/play@QuestBot now, @bob!');
    expect(jsonText(undefined)).toBe('');
  });
});

describe('readJsonExport', () => {
  it('gives_the_messages_the_html_reader_gives_and_the_ids_it_cannot', () => {
    for (const [chat, type, id, marked] of [
      [chats().dm, 'bot_chat', 444000444, '444000444'],
      [chats().group, 'private_supergroup', 1001, '-1001001'],
    ] as const) {
      const r = readJsonExport(jsonExport(chat, type, id, IDS), 'result.json');
      const html = new ExportParser();
      html.feed(pageHtml(chat.title, chat.messages));
      html.close();
      // The service message is left out, as the HTML reader leaves it out.
      expect(r.messages.map((m) => ({ ...m, chat_id: undefined, chat_type: undefined }))).toEqual(
        html.messages.map((m) => ({
          ...m,
          sender_id: `user${IDS[m.sender as keyof typeof IDS]}`,
        }))
      );
      expect(r.messages.every((m) => m.chat_id === marked && m.chat_type === type)).toBe(true);
      expect(r).toMatchObject({ folder: 'result.json', pages: 0 });
    }
  });

  it('reads_every_chat_of_an_account_export', () => {
    const { dm, group } = chats();
    const json = {
      about: 'x',
      chats: { about: 'x', list: [jsonExport(dm, 'bot_chat', 9, IDS), 7] },
      left_chats: { about: 'x', list: [jsonExport(group, 'private_group', 5, IDS)] },
    };
    expect(jsonChats(json)).toHaveLength(2);
    const r = readJsonExport(json, 'all.json');
    expect([...new Set(r.messages.map((m) => m.chat_id))]).toStrictEqual(['9', '-5']);
    expect(() => readJsonExport({ about: 'x' }, 'x.json')).toThrow(
      'x.json: not a Telegram JSON export'
    );
    expect(() => readJsonExport(null, 'x.json')).toThrow(/not a Telegram JSON export/u);
  });

  it('dates_from_the_instant_and_without_one_left_for_the_merge', () => {
    const base = {
      name: 'G',
      type: 'private_group',
      id: 3,
      messages: [
        // The local wall clock with its instant: the offset it shows.
        {
          id: 1,
          type: 'message',
          date: '2025-07-01T12:00:00',
          date_unixtime: '1751364000',
          text: 'a',
        },
        // No instant (an older export): the wall clock alone, which the merge gives an offset.
        { id: 2, type: 'message', date: '2025-07-01T12:00:01', text: 'b' },
        // Seconds apart from a whole offset: the instant in UTC.
        {
          id: 3,
          type: 'message',
          date: '2025-07-01T12:00:02',
          date_unixtime: 1751364003,
          text: 'c',
        },
        { id: 4, type: 'message', date: 'garbage', text: 'd' },
        { id: 5, type: 'message', date: '2025-07-01T12:00:04', date_unixtime: 'x', text: 'e' },
        { id: 6, type: 'unsupported' },
        { id: 7, type: 'message', date: '2025-07-01T12:00:05', text: '' },
        { type: 'message', text: 'no id' },
        'junk',
      ],
    };
    expect(
      readJsonExport(base, 'r.json').messages.map((m) => [m.id, m.date, m.sender])
    ).toStrictEqual([
      [1, '01.07.2025 12:00:00 UTC+02:00', null],
      [2, '1 July 2025, 12:00:01', null],
      [3, '01.07.2025 10:00:03 UTC+00:00', null],
      [4, null, null],
      [5, '1 July 2025, 12:00:04', null],
    ]);
  });

  it('takes_the_attached_text_files_given', () => {
    const dm = new Chat(BOT, 10);
    dm.bot('Inventory of @alice', 0, { file: 'files/file (1).txt' });
    dm.bot('Another', 1, { file: 'files/photo.jpg' });
    const json = jsonExport(dm, 'bot_chat', 9);
    expect(jsonTextFiles(json)).toStrictEqual(['files/file (1).txt']);
    const r = readJsonExport(json, 'r.json', new Map([['files/file (1).txt', 'x']]));
    expect(r.messages.map((m) => [m.file_name, m.file_text])).toStrictEqual([
      ['file.txt', 'x'],
      [undefined, undefined],
    ]);
  });
});

describe('JSON exports on disk', () => {
  it('a_json_only_folder_or_file_is_read_and_merged_with_html', () => {
    const dir = tempDir();
    const { dm, group } = chats();
    fs.mkdirSync(path.join(dir, 'in', 'J'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'in', 'J', 'result.json'),
      JSON.stringify(jsonExport(group, 'private_supergroup', 1001, IDS))
    );
    // The same chat as HTML: one copy of each message, with the JSON's ids.
    writeExport(path.join(dir, 'in', 'H'), 'Quest Lobby', [group.messages]);
    const single = path.join(dir, 'dm.json');
    fs.writeFileSync(single, JSON.stringify(jsonExport(dm, 'bot_chat', 444000444, IDS)));
    const { msgs, err } = runParse([path.join(dir, 'in'), single]);
    expect(msgs.map((m) => [m.chat_id, m.id])).toStrictEqual([
      ['444000444', 50],
      ['444000444', 51],
      ['-1001001', 700],
      ['-1001001', 701],
      ['-1001001', 702],
    ]);
    expect(err).toContain('exports: 3; chats: Quest Lobby, QuestBot');
  });

  it('reads_the_linked_text_files_beside_the_json', () => {
    const dir = tempDir();
    const dm = new Chat(BOT, 10);
    dm.bot('one', 0, { file: 'files/a.txt' });
    dm.bot('two', 1, { file: 'files/b.txt' });
    dm.bot('three', 2, { file: 'files/missing.txt' });
    fs.mkdirSync(path.join(dir, 'files'));
    fs.writeFileSync(path.join(dir, 'files', 'a.txt'), 'line\r\n');
    fs.writeFileSync(path.join(dir, 'files', 'b.txt'), new Uint8Array([0xe8]));
    const file = path.join(dir, 'result.json');
    fs.writeFileSync(file, JSON.stringify(jsonExport(dm, 'bot_chat', 9)));
    expect(readJsonFile(file).messages.map((m) => m.file_text)).toStrictEqual([
      'line\n',
      undefined,
      undefined,
    ]);
  });
});
