import { describe, expect, it } from 'vitest';
import { type Page } from '#src/messages.ts';
import { BOT, Chat, jsonExport, macPageHtml, pageHtml } from '#test/helpers.ts';
import { readJsonExport } from './json.ts';
import { mergeExports, parsePages, readHtmlExport, splitExports, summaryLine } from './merge.ts';

const MERGE = { timeZone: 'America/New_York' };
const IDS = { Alice: 111000111, Bob: 222000222, [BOT]: 444000444 };

const page = (label: string, html: string): Page => ({ label, html });

describe('readHtmlExport', () => {
  it('reads_every_message_of_one_export_in_page_order', () => {
    const g = new Chat('Quest Lobby', 10);
    g.user('Bob', 'hello all', 0);
    g.user('Bob', '/play@QuestBot', 1); // joined: its sender from the page before
    g.bot('@bob, Found a stone.', 2);
    const r = readHtmlExport([
      page('G/messages.html', pageHtml('Quest Lobby', g.messages.slice(0, 1))),
      page('G/messages2.html', pageHtml('Quest Lobby', g.messages.slice(1), true)),
    ]);
    expect(r).toStrictEqual({ folder: 'G', pages: 2, messages: g.clean() });
  });

  it('one_export_per_record', () => {
    const html = pageHtml('G', []);
    expect(() =>
      readHtmlExport([page('A/messages.html', html), page('B/messages.html', html)])
    ).toThrow(/two exports/u);
    expect(() => readHtmlExport([])).toThrow(/without pages/u);
  });

  it('survives_a_json_round_trip', () => {
    const g = new Chat('G', 10);
    g.user('Bob', 'hello', 0);
    const r = readHtmlExport([page('G/messages.html', macPageHtml('G', g.messages, IDS))]);
    expect(JSON.parse(JSON.stringify(r))).toStrictEqual(r);
  });
});

describe('splitExports', () => {
  it('consecutive_pages_of_one_folder', () => {
    const p = (label: string): Page => page(label, '');
    const pages = [p('x/A/messages.html'), p('x/A/messages2.html'), p('x/B/messages.html')];
    expect(splitExports(pages).map((e) => e.map((q) => q.label))).toStrictEqual([
      ['x/A/messages.html', 'x/A/messages2.html'],
      ['x/B/messages.html'],
    ]);
    expect(splitExports([])).toStrictEqual([]);
  });
});

describe('mergeExports', () => {
  it('converts_macos_dates_and_leaves_the_records_unchanged', () => {
    const g = new Chat('G', 10);
    g.user('Bob', 'hello', 0);
    g.user('Bob', '/play', 1);
    const dm = new Chat(BOT, 900);
    dm.user('Bob', 'hello bot', 2);
    const mac = readHtmlExport([page('M/messages.html', macPageHtml('G', g.messages, IDS))]);
    const win = readHtmlExport([page('W/messages.html', pageHtml(BOT, dm.messages))]);
    const before = JSON.stringify([mac, win]);
    const r = mergeExports([mac, win], MERGE);
    expect(JSON.stringify([mac, win])).toBe(before);
    expect(r.messages.map((m) => [m.chat, m.text, m.date, m.sender_id])).toStrictEqual([
      ['G', 'hello', g.messages[0]?.date, 'user222000222'],
      ['G', '/play', g.messages[1]?.date, 'user222000222'],
      [BOT, 'hello bot', dm.messages[0]?.date, undefined],
    ]);
    expect(r.exports).toBe(2);
    expect(r.chats).toStrictEqual(['G', BOT]);
    expect(r.warnings).toStrictEqual([
      'M: dates without a UTC offset, read in the time zone America/New_York',
    ]);
    expect(summaryLine(r)).toBe('exports: 2; chats: G, QuestBot');
  });

  it('a_copy_without_its_file_keeps_the_file_text_of_another', () => {
    const dm = new Chat(BOT, 10);
    dm.bot('Inventory of @alice, at 2025/11/28 00:00:00', 0, { file: 'files/file.txt' });
    const html = pageHtml(BOT, dm.messages);
    const files = new Map([['files/file.txt', 'x']]);
    const withFile = readHtmlExport([{ ...page('A/messages.html', html), files }]);
    const without = readHtmlExport([page('B/messages.html', html)]);
    for (const records of [
      [withFile, without],
      [without, withFile],
    ])
      expect(mergeExports(records).messages.map((m) => [m.file_name, m.file_text])).toStrictEqual([
        ['file.txt', 'x'],
      ]);
  });

  it('an_html_copy_keeps_the_chat_and_sender_ids_of_its_json_copy', () => {
    const g = new Chat('Quest Lobby', 10);
    g.user('Bob', 'hello', 0);
    g.user('Alice', '/play@QuestBot', 1);
    const json = readJsonExport(jsonExport(g, 'private_supergroup', 1001, IDS), 'r.json');
    const html = readHtmlExport([page('H/messages.html', pageHtml('Quest Lobby', g.messages))]);
    for (const records of [
      [json, html],
      [html, json],
    ]) {
      const r = mergeExports(records);
      expect(r.messages).toHaveLength(2);
      expect(r.messages.map((m) => [m.chat_id, m.chat_type, m.sender_id, m.date])).toStrictEqual(
        g.messages.map((m) => [
          '-1001001',
          'private_supergroup',
          `user${IDS[m.sender as 'Bob' | 'Alice']}`,
          m.date,
        ])
      );
    }
  });

  it('parse_pages_is_read_then_merge', () => {
    const g = new Chat('G', 10);
    g.user('Bob', 'hello', 0);
    const html = pageHtml('G', g.messages);
    const paths = [[page('A/messages.html', html), page('B/messages.html', html)]];
    const records = [
      readHtmlExport([page('A/messages.html', html)]),
      readHtmlExport([page('B/messages.html', html)]),
    ];
    expect(parsePages(paths)).toStrictEqual(mergeExports(records));
  });
});
