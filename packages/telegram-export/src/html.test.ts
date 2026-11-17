/** html.ts, merge.ts and files.ts: Telegram Desktop HTML -> messages (ported from the wiki generator's, #60). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMacDate } from '#src/dates.ts';
import { type ExportMessage, type Page } from '#src/messages.ts';
import {
  BOT,
  Chat,
  type DayItem,
  type Instant,
  type Item,
  macDate,
  macPageHtml,
  pageHtml,
  runParse,
  tgDate,
  writeExport,
  writeMacExport,
} from '#test/helpers.ts';
import { tempDir } from '#test/temp-dir.ts';
import { iterPages } from './files.ts';
import { exportKey, ExportParser, pageKey, sortMessages } from './html.ts';
import { parsePages } from './merge.ts';

/** The test exports' dates are in New York's winter time (UTC-05:00, test/helpers.ts). */
const OPTS = { timeZone: 'America/New_York' };

function parseHtml(
  title: string,
  items: readonly (Item | DayItem)[],
  lastSender: string | null = null,
  firstJoined = false
): ExportParser {
  const p = new ExportParser(lastSender);
  p.feed(pageHtml(title, items, firstJoined));
  p.close();
  return p;
}

const day = (s: string): DayItem => ['day', s];

describe('common parsing', () => {
  it('dm_conversation_fields', () => {
    const c = new Chat();
    c.user('Alice', '/play', 0);
    c.bot('@alice, you climb the frozen stream and find a pistachio nougat among the pebbles!', 2);
    const p = parseHtml(BOT, [day('27 November 2025'), ...c.messages]);
    expect(p.messages).toHaveLength(2);
    const [cmd, reply] = p.messages;
    expect(cmd).toStrictEqual({
      chat: BOT,
      id: 1000,
      date: tgDate(0),
      sender: 'Alice',
      forwarded_from: null,
      reply_to: null,
      text: '/play',
    });
    expect(reply?.sender).toBe(BOT); // trailing space of "QuestBot " stripped
    expect(reply?.date).toBe('27.11.2025 19:00:02 UTC-05:00');
  });

  it('group_conversation_and_day_separators', () => {
    const c = new Chat('Quest Lobby');
    c.user('Bob', 'hello all', 0);
    c.user('Bob', 'who plays?', 5);
    c.user('Carol', '/inventory', 10);
    c.bot('@carol, you have:\n- a gold coin x1', 12);
    const items = [
      day('27 November 2025'),
      ...c.messages.slice(0, 2),
      day('28 November 2025'),
      ...c.messages.slice(2),
    ];
    const p = parseHtml('Quest Lobby', items);
    expect(p.messages.map((m) => m.sender)).toStrictEqual(['Bob', 'Bob', 'Carol', BOT]);
    expect(p.messages.every((m) => m.chat === 'Quest Lobby')).toBe(true);
    expect(p.messages.map((m) => m.id)).toStrictEqual([1000, 1001, 1002, 1003]); // services skipped
  });

  it('message_without_text_is_skipped_but_sets_sender', () => {
    const media: Item = { id: 7, date: tgDate(0), sender: 'Bob', text: null };
    const follow: Item = { id: 8, date: tgDate(1), sender: 'Bob', text: 'seen?', _joined: true };
    const p = parseHtml('G', [media, follow]);
    expect(p.messages.map((m) => [m.id, m.sender])).toStrictEqual([[8, 'Bob']]);
  });
});

describe('joined messages', () => {
  it('joined_message_inherits_sender', () => {
    const c = new Chat('G');
    c.user('Bob', 'one', 0);
    c.user('Bob', 'two', 1); // rendered as joined: no from_name
    c.user('Carol', 'three', 2);
    expect(pageHtml('G', c.messages)).toContain('message default clearfix joined');
    const p = parseHtml('G', c.messages);
    expect(p.messages.map((m) => m.sender)).toStrictEqual(['Bob', 'Bob', 'Carol']);
  });

  it('joined_across_pages_of_one_export', async () => {
    const dir = tempDir();
    const c = new Chat('G');
    c.user('Bob', 'end of page one', 0);
    c.user('Bob', 'start of page two', 1);
    writeExport(
      path.join(dir, 'ChatExport'),
      'G',
      [c.messages.slice(0, 1), c.messages.slice(1)],
      new Set([2])
    );
    const { msgs } = runParse([dir]);
    expect(msgs.map((m) => m.sender)).toStrictEqual(['Bob', 'Bob']);
  });

  it('parser_seeded_with_last_sender', () => {
    const c = new Chat('G');
    c.user('Bob', 'x', 0);
    const p = parseHtml('G', c.messages, 'Carol', true);
    expect(p.messages[0]?.sender).toBe('Carol');
  });

  it('joined_does_not_cross_into_another_export', async () => {
    const dir = tempDir();
    const a = new Chat('G');
    const b = new Chat('G', 5000);
    a.user('Bob', 'export one', 0);
    b.user('Carol', 'export two', 10);
    writeExport(path.join(dir, 'A'), 'G', [a.messages]);
    writeExport(path.join(dir, 'B'), 'G', [b.messages], new Set([1]));
    const { msgs } = runParse([dir]);
    expect(Object.fromEntries(msgs.map((m) => [m.id, m.sender]))).toStrictEqual({
      1000: 'Bob',
      5000: null,
    });
  });

  it('joined_across_pages_with_windows_paths', async () => {
    const c = new Chat('G');
    c.user('Bob', 'end of page one', 0);
    c.user('Bob', 'start of page two', 1);
    // The pure core takes the pages directly, without reading files.
    const pages: Page[] = [
      {
        label: 'C:\\inbox\\ChatExport\\messages.html',
        html: pageHtml('G', c.messages.slice(0, 1)),
      },
      {
        label: 'C:\\inbox\\ChatExport\\messages2.html',
        html: pageHtml('G', c.messages.slice(1), true),
      },
    ];
    const { messages } = parsePages([pages], OPTS);
    expect(messages.map((m) => m.sender)).toStrictEqual(['Bob', 'Bob']);
  });
});

describe('page order', () => {
  it('page_key', () => {
    expect(pageKey('messages.html')).toBe(1);
    expect(pageKey('messages2.html')).toBe(2);
    expect(pageKey('messages10.html')).toBe(10);
  });

  it('pages_iterated_numerically', () => {
    const dir = tempDir();
    const c = new Chat('G');
    for (let i = 0; i < 11; i++) c.user('Bob', `m${i}`, i);
    writeExport(
      path.join(dir, 'E'),
      'G',
      c.messages.map((m) => [m])
    );
    const labels = [...iterPages(dir, () => {})].map((p) => path.basename(p.label));
    expect(labels).toStrictEqual([
      'messages.html',
      ...Array.from({ length: 10 }, (_, k) => `messages${k + 2}.html`),
    ]);
  });

  it('sender_carried_from_page9_to_page10', async () => {
    const dir = tempDir();
    const c = new Chat('G');
    for (let i = 0; i < 10; i++) c.user(i < 9 ? 'Bob' : 'Carol', `m${i}`, i);
    c.user('Carol', 'joined on page 11', 11);
    writeExport(
      path.join(dir, 'E'),
      'G',
      c.messages.map((m) => [m]),
      new Set([11])
    );
    const { msgs } = runParse([dir]);
    expect(msgs.at(-1)?.sender).toBe('Carol');
  });
});

describe('de-duplication', () => {
  it('overlapping_exports_deduplicated', async () => {
    const dir = tempDir();
    const c = new Chat(BOT);
    for (let i = 0; i < 6; i++) c.user('Alice', `/look item ${i}`, i * 10);
    writeExport(path.join(dir, 'ChatExport_2026-10-17'), BOT, [c.messages.slice(0, 4)]);
    writeExport(path.join(dir, 'ChatExport_2026-11-02'), BOT, [c.messages.slice(2)]);
    const { msgs, err } = runParse([dir]);
    expect(msgs.map((m) => m.id)).toStrictEqual([1000, 1001, 1002, 1003, 1004, 1005]);
    expect(err).toContain('exports: 2;');
  });

  it('same_id_in_different_chats_kept', async () => {
    const dir = tempDir();
    const a = new Chat(BOT);
    const b = new Chat('G');
    a.user('Alice', '/play', 0);
    b.user('Bob', 'hello', 1);
    writeExport(path.join(dir, 'A'), BOT, [a.messages]);
    writeExport(path.join(dir, 'B'), 'G', [b.messages]);
    const { msgs } = runParse([dir]);
    expect(msgs.map((m) => [m.chat, m.id]).sort()).toStrictEqual([
      ['G', 1000],
      [BOT, 1000],
    ]);
  });
});

describe('discovery', () => {
  const twoMessages = (): Chat => {
    const c = new Chat('G');
    c.user('Bob', 'hello', 0);
    c.user('Carol', '/play', 1);
    return c;
  };

  it('plain_folder', async () => {
    const dir = tempDir();
    writeExport(path.join(dir, 'ChatExport'), 'G', [twoMessages().messages]);
    expect(runParse([path.join(dir, 'ChatExport')]).msgs).toHaveLength(2);
  });

  it('deep_subfolders', async () => {
    const dir = tempDir();
    writeExport(path.join(dir, 'inbox', 'a', 'b', 'c', 'ChatExport'), 'G', [
      twoMessages().messages,
    ]);
    expect(runParse([path.join(dir, 'inbox')]).msgs).toHaveLength(2);
  });

  it('non_page_html_ignored', async () => {
    const dir = tempDir();
    const folder = writeExport(path.join(dir, 'E'), 'G', [twoMessages().messages]);
    const other = new Chat('G', 9000);
    other.user('X', 'intruder', 5);
    fs.writeFileSync(
      path.join(folder, 'messages_old.html'),
      pageHtml('G', other.messages),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(folder, 'old_messages.html'),
      pageHtml('G', other.messages),
      'utf-8'
    );
    const { msgs } = runParse([folder]);
    expect(msgs.map((m) => m.text)).not.toContain('intruder');
    expect(msgs).toHaveLength(2);
  });

  it('not_a_folder_or_zip', async () => {
    const dir = tempDir();
    const f = path.join(dir, 'notes.txt');
    fs.writeFileSync(f, 'x');
    const { msgs, err } = runParse([f]);
    expect(msgs).toStrictEqual([]);
    expect(err).toContain('not a folder, a .json file or a .zip file');
  });

  it('zip_skipped_with_warning', async () => {
    // Zips are not read: only folders are input.
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'inbox'));
    fs.writeFileSync(path.join(dir, 'inbox', 'export.zip'), 'PK');
    const { msgs, err } = runParse([path.join(dir, 'inbox')]);
    expect(msgs).toStrictEqual([]);
    expect(err).toContain('zip files are not read');
  });

  it('zip_given_as_path_skipped_with_warning', async () => {
    const dir = tempDir();
    const zip = path.join(dir, 'Export.ZIP');
    fs.writeFileSync(zip, 'PK');
    const { msgs, err } = runParse([zip]);
    expect(msgs).toStrictEqual([]);
    expect(err).toContain('zip files are not read');
  });

  it('missing_path_skipped_with_warning', async () => {
    const { msgs, err } = runParse([path.join(tempDir(), 'missing')]);
    expect(msgs).toStrictEqual([]);
    expect(err).toContain('not a folder, a .json file or a .zip file');
  });

  // Permissions do not block reading on Windows, nor for root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'unreadable_subfolder_skipped',
    async () => {
      const dir = tempDir();
      writeExport(path.join(dir, 'inbox', 'A'), 'G', [twoMessages().messages]);
      const locked = writeExport(path.join(dir, 'inbox', 'B'), 'H', [twoMessages().messages]);
      fs.chmodSync(locked, 0o000);
      try {
        expect(runParse([path.join(dir, 'inbox')]).msgs.map((m) => m.chat)).toStrictEqual([
          'G',
          'G',
        ]);
      } finally {
        fs.chmodSync(locked, 0o755); // so that the temporary folder can be deleted
      }
    }
  );
});

describe('attached text files', () => {
  const caption = 'Inventory of @alice, at 2025/11/28 00:00:02';
  const dm = (file: string | null): Chat => {
    const c = new Chat();
    c.user('Alice', '/export', 0);
    c.bot(caption, 2, { file });
    return c;
  };

  it('a_message_takes_the_text_of_the_file_it_links_to', () => {
    const p = new ExportParser();
    p.feed(
      pageHtml(BOT, dm('files/file (1).txt').messages),
      new Map([['files/file (1).txt', 'x']])
    );
    p.close();
    expect(p.messages.map((m) => [m.text, m.file_text])).toStrictEqual([
      ['/export', undefined],
      [caption, 'x'],
    ]);
  });

  it('a_file_left_out_or_not_given_adds_nothing', () => {
    for (const [file, files] of [
      [null, new Map([['files/file.txt', 'x']])],
      ['files/file.txt', new Map<string, string>()],
    ] as const) {
      const p = new ExportParser();
      p.feed(pageHtml(BOT, dm(file).messages), files);
      p.close();
      expect(p.messages[1]).toStrictEqual(dm(file).clean()[1]);
      expect(p.messages[1]).not.toHaveProperty('file_text');
    }
  });

  it('the_disk_adapter_reads_the_linked_text_files', async () => {
    const dir = tempDir();
    const c = dm('files/file.txt');
    c.bot(caption, 4, { file: 'files/file (1).txt' });
    c.bot(caption, 6, { file: 'files/missing.txt' });
    c.bot(caption, 8, { file: 'files/latin1.txt' });
    const folder = writeExport(path.join(dir, 'E'), BOT, [c.messages], undefined, {
      'files/file.txt': 'line 1\r\n',
      'files/file (1).txt': 'line 2\r\n',
      'files/latin1.txt': new Uint8Array([0xe8]),
    });
    const { msgs } = runParse([folder]);
    expect(msgs.map((m) => m.file_text)).toStrictEqual([
      undefined,
      'line 1\n',
      'line 2\n',
      undefined,
      undefined,
    ]);
    const [page] = [...iterPages(folder, () => {})];
    expect([...(page?.files?.keys() ?? [])]).toStrictEqual([
      'files/file.txt',
      'files/file (1).txt',
    ]);
  });
});

describe('JSON exports beside HTML', () => {
  it('a_folder_with_html_pages_is_read_from_them_alone', () => {
    const dir = tempDir();
    const c = new Chat('G');
    c.user('Bob', 'hello', 0);
    const folder = writeExport(path.join(dir, 'E'), 'G', [c.messages]);
    fs.writeFileSync(path.join(folder, 'result.json'), '{}'); // would not read
    const { msgs } = runParse([dir]);
    expect(msgs).toHaveLength(1);
  });
});

describe('chat title', () => {
  it('chat_named_by_title_not_folder', () => {
    const dir = tempDir();
    const a = new Chat(BOT);
    const b = new Chat('Quest Lobby');
    a.user('Alice', '/play', 0);
    b.user('Bob', '/play', 1);
    writeExport(path.join(dir, 'Quest Lobby'), BOT, [a.messages]); // misleading folder names
    writeExport(path.join(dir, 'QuestBot'), 'Quest Lobby', [b.messages]);
    const { msgs, err } = runParse([dir]);
    expect(msgs.map((m) => `${m.chat}|${m.sender}`)).toStrictEqual([
      `${BOT}|Alice`,
      'Quest Lobby|Bob',
    ]);
    expect(err).toContain('chats: Quest Lobby, QuestBot');
  });
});

describe('replies', () => {
  it('reply_to_same_page', () => {
    const c = new Chat('G');
    const cmd = c.user('Bob', '/play', 0, { msg_id: 355915 });
    c.bot('@bob, Found a stone.', 1, { reply_to: 355915 });
    const p = parseHtml('G', c.messages);
    expect(p.messages.map((m) => m.reply_to)).toStrictEqual([null, 355915]);
    expect(cmd.id).toBe(355915);
  });

  it('reply_to_link_into_other_page', () => {
    const c = new Chat('G');
    const m = c.bot('@bob, Found a stone.', 1, { reply_to: 123 });
    m._reply_href = 'messages2.html#go_to_message123';
    const p = parseHtml('G', c.messages);
    expect(p.messages[0]?.reply_to).toBe(123);
    expect(p.messages[0]?.text).toBe('@bob, Found a stone.');
  });
});

describe('forwarded messages', () => {
  it('forwarded_bot_message', () => {
    const c = new Chat('G');
    c.forward('Bob', BOT, '@carol, you have:\n- a stone x2', 0, {
      fwd_date: '17.02.2026 14:09:52',
    });
    const m = parseHtml('G', c.messages).messages[0];
    expect(m?.sender).toBe('Bob');
    expect(m?.forwarded_from).toBe(BOT); // the date inside from_name is ignored
    expect(m?.date).toBe(tgDate(0)); // the outer date, not the original one
    expect(m?.text).toBe('@carol, you have:\n- a stone x2');
  });

  it('forwarded_human_message', () => {
    const c = new Chat(BOT);
    c.forward('Alice', 'Original Author', '/play', 0);
    const m = parseHtml(BOT, c.messages).messages[0];
    expect([m?.sender, m?.forwarded_from]).toStrictEqual(['Alice', 'Original Author']);
  });

  it('plain_message_has_no_forwarded_from', () => {
    const c = new Chat(BOT);
    c.bot('@alice, you have:\n- a stone x2', 0);
    const m = parseHtml(BOT, c.messages).messages[0];
    expect(m?.forwarded_from).toBeNull();
    expect(m?.sender).toBe(BOT);
  });
});

describe('commands', () => {
  it('commands_kept_as_written', async () => {
    const dir = tempDir();
    const c = new Chat('G');
    c.user('Bob', 'x', 0).text = '/inventory@QuestBot gold'; // raw, as in the HTML
    c.user('Bob', 'x', 1).text = '/start@OtherBot';
    writeExport(path.join(dir, 'E'), 'G', [c.messages]);
    const { msgs } = runParse([dir]);
    // The readers keep `/cmd@Bot` as written: telling commands for a bot from others is the
    // reading plugin's business, not the export format's.
    expect(msgs.map((m) => m.text)).toStrictEqual(['/inventory@QuestBot gold', '/start@OtherBot']);
  });
});

describe('text', () => {
  it('br_and_entities', () => {
    const c = new Chat(BOT);
    c.bot('line one\nline two & more <b> "q" l\'or', 0);
    expect(parseHtml(BOT, c.messages).messages[0]?.text).toBe(
      'line one\nline two & more <b> "q" l\'or'
    );
  });

  it('self_closing_br_and_numeric_entities', () => {
    const raw = pageHtml(BOT, []).replace(
      '<div class="history">',
      '<div class="history"><div class="message default clearfix" id="message5"><div class="body">' +
        `<div class="pull_right date details" title="${tgDate(0)}">19:00</div>` +
        '<div class="from_name">QuestBot </div>' +
        '<div class="text">one<br/>two &#233; &egrave; &#x1F332;</div></div></div>'
    );
    const p = new ExportParser();
    p.feed(raw);
    p.close();
    expect(p.messages[0]?.text).toBe('one\ntwo é è \u{1F332}');
  });
});

describe('order', () => {
  it('chats_merged_by_timestamp', async () => {
    const dir = tempDir();
    const dm = new Chat(BOT, 900000);
    const g = new Chat('G', 10);
    dm.user('Alice', 'dm a', 0);
    g.user('Bob', 'g b', 5);
    dm.user('Alice', 'dm c', 10);
    g.user('Bob', 'g d', 15);
    writeExport(path.join(dir, 'A'), BOT, [dm.messages]);
    writeExport(path.join(dir, 'B'), 'G', [g.messages]);
    expect(runParse([dir]).msgs.map((m) => m.text)).toStrictEqual(['dm a', 'g b', 'dm c', 'g d']);
  });

  it('different_utc_offsets_compared_as_instants', () => {
    // 20:00 UTC-05:00 is 01:00 UTC the next day, later than 00:30 UTC+00:00.
    const a = { date: '27.11.2025 20:00:00 UTC-05:00', chat: 'A', id: 1 };
    const b = { date: '28.11.2025 00:30:00 UTC+00:00', chat: 'B', id: 2 };
    expect(sortMessages([a, b])).toStrictEqual([b, a]);
  });

  it('ids_break_ties_within_chat', () => {
    const a = { date: '27.11.2025 20:00:00 UTC-05:00', chat: 'A', id: 2 };
    const b = { date: '27.11.2025 20:00:00 UTC-05:00', chat: 'A', id: 1 };
    const c = { date: null, chat: 'A', id: 3 }; // undated: sorts at the instant of the nearest dated message by id
    expect(sortMessages([a, b, c])).toStrictEqual([b, a, c]);
  });
});

// ---- macOS export (docs/telegram-export.md section 11) -------------------------------

/** Invented Telegram user ids for the avatar file names. */
const IDS = { Alice: 111000111, Bob: 222000222, Carol: 333000333, [BOT]: 444000444 };

/** The sender id of a sender of IDS, as the readers give it. */
const key = (name: keyof typeof IDS): string => `user${IDS[name]}`;

function macDm(): Chat {
  const c = new Chat(BOT, 5000);
  c.user('Alice', "/look Bob's gold", 0);
  c.bot('@alice, a fine "gold" coin, isn\'t it\nYou have 2.', 1);
  c.user('Alice', '/inventory', 2);
  c.bot('@alice, you have:\n- a gold coin x2', 3);
  return c;
}

describe('macOS markup', () => {
  it('title_from_name_bold_and_same_messages_as_windows', () => {
    const c = macDm();
    const day: DayItem = ['day', '27 November 2025'];
    const mac = new ExportParser();
    mac.feed(macPageHtml(BOT, [day, ...c.messages], IDS));
    mac.close();
    const win = new ExportParser();
    win.feed(pageHtml(BOT, [day, ...c.messages]));
    win.close();
    expect(mac.chat).toBe(BOT); // not the "bot" subtitle
    const strip = (m: object): object => ({ ...m, date: null, sender_id: null });
    expect(mac.messages.map(strip)).toStrictEqual(win.messages.map(strip));
    expect(mac.messages.map((m) => m.text)).toContain("/look Bob's gold");
    expect(mac.messages[0]?.sender_id).toBe(key('Alice'));
    expect(mac.messages[0]?.date).toBe('27 November 2025, 19:00:00'); // verbatim in the page parser
  });

  it('group_title_and_command_with_strong_inside_anchor', () => {
    const html = macPageHtml('Quest Lobby', []).replace(
      '<div class="history">',
      '<div class="history">\n<div class="message default clearfix" id="message7">\n<div class="body">\n' +
        '<div class="pull_right date details" title="1 March 2026, 09:05:00">09:05</div>\n<div class="from_name">Bob</div>\n' +
        '<div class="text">\n<a onclick="return ShowBotCommand(\'craft@QuestBot\')" href="#"><strong>/craft@QuestBot</strong></a> basket</div>\n</div>\n</div>'
    );
    const p = new ExportParser();
    p.feed(html);
    p.close();
    expect(p.chat).toBe('Quest Lobby');
    expect(p.messages.map((m) => m.text)).toStrictEqual(['/craft@QuestBot basket']);
  });

  it('name_bold_outside_the_header_is_not_the_title', () => {
    const html = macPageHtml('G', [])
      .replace('<div class="name bold">G</div>', '')
      .replace(
        '<div class="history">',
        '<div class="history">\n<div class="message default clearfix" id="message1"><div class="body">' +
          '<div class="name bold">Not a title</div><div class="from_name">Bob</div><div class="text">hello</div></div></div>'
      );
    const p = new ExportParser();
    p.feed(html);
    p.close();
    expect(p.chat).toBeNull();
  });
});

describe('macOS dates', () => {
  it('mac_date_parts', () => {
    expect(parseMacDate('17 October 2026, 05:35:33')).toStrictEqual({
      year: 2026,
      month: 10,
      day: 17,
      hour: 5,
      minute: 35,
      second: 33,
    });
    expect(parseMacDate('07 March 2026, 23:00:00')?.day).toBe(7);
    expect(parseMacDate('7 March 2026, 23:00:00')?.day).toBe(7);
    for (const bad of [
      '31 February 2026, 10:00:00',
      '17 Octobre 2026, 05:35:33',
      '17 October 2026 05:35:33',
      '17.10.2026 05:35:33 UTC-05:00',
      '17 October 2026, 24:00:00',
      '',
    ]) {
      expect(parseMacDate(bad), bad).toBeNull();
    }
  });

  it('offset_from_overlapping_export_of_the_same_chat', async () => {
    const dir = tempDir();
    const c = macDm();
    writeExport(path.join(dir, 'Win'), BOT, [c.messages.slice(0, 2)]);
    writeMacExport(path.join(dir, 'Mac'), BOT, c.messages.slice(1), IDS);
    const { msgs, err } = runParse([dir]);
    expect(msgs.map((m) => m.date)).toStrictEqual(c.messages.map((m) => m.date)); // UTC-05:00, as in the Windows export
    expect(err).toContain(
      'Mac: dates without a UTC offset, read as UTC-05:00 as the other exports of the same chat (1 messages in common)'
    );
    expect(err).not.toContain('show another date');
  });

  it('inferred_offset_wins_over_the_time_zone_and_disagreement_is_reported', async () => {
    const dir = tempDir();
    const c = macDm();
    const win = c.messages.map((m) => ({ ...m }));
    (win[1] as Item).date = tgDate(3600 + 1); // another wall clock for one shared message
    writeExport(path.join(dir, 'Win'), BOT, [win.slice(0, 3)]);
    writeMacExport(path.join(dir, 'Mac'), BOT, c.messages, IDS);
    const { msgs, err } = runParse([dir], 'Europe/Athens');
    expect(err).toContain(
      'read as UTC-05:00 as the other exports of the same chat (3 messages in common); in 1 of them another export shows another date or another offset'
    );
    // The Windows copy's date is kept, so message 5001 sorts at its own instant.
    expect(msgs.map((m) => [m.id, m.date])).toStrictEqual(
      [0, 2, 3, 1].map((i) => [c.messages[i]?.id, (i === 1 ? win : c.messages)[i]?.date])
    );
  });

  it('other_chat_or_other_wall_clock_falls_back_to_the_time_zone', async () => {
    const dir = tempDir();
    const c = macDm();
    const rome: Instant = { epoch: c.base.epoch, offsetMinutes: 60 };
    const other = new Chat(BOT, 5000, rome); // same ids, shown at another wall clock
    for (const m of c.messages) other.user('Alice', m.text, 0);
    writeExport(path.join(dir, 'Win'), BOT, [other.messages]);
    const g = new Chat('G', 5000);
    g.user('Bob', 'hello', 0);
    writeExport(path.join(dir, 'Group'), 'G', [g.messages]); // same ids and wall clock, other chat
    writeMacExport(path.join(dir, 'Mac'), BOT, c.messages, IDS);
    const { err } = runParse([dir]);
    expect(err).toContain(
      'Mac: dates without a UTC offset, read in the time zone America/New_York; the 4 messages in common with other exports of the same chat show other dates there'
    );
  });

  it('unknown_time_zone_rejected', async () => {
    const pages = [{ label: 'Mac/messages.html', html: macPageHtml(BOT, macDm().messages, IDS) }];
    for (const bad of ['Mars/Base', 'Italia'])
      expect(() => parsePages([pages], { ...OPTS, timeZone: bad }), bad).toThrow(
        `unknown time zone: ${bad}`
      );
  });

  it('no_time_zone_and_no_other_export_to_take_the_offset_from_is_an_error', () => {
    const pages = [{ label: 'Mac/messages.html', html: macPageHtml(BOT, macDm().messages, IDS) }];
    expect(() => parsePages([pages])).toThrow(
      /Mac: dates without a UTC offset, and no other export/u
    );
  });

  it('each_date_takes_the_offset_of_its_season', async () => {
    const summer = new Chat(BOT, 100, {
      epoch: Date.UTC(2025, 6, 1, 10) / 1000,
      offsetMinutes: 120,
    });
    summer.user('Bob', 'summer', 0);
    const winter = new Chat(BOT, 200, {
      epoch: Date.UTC(2025, 11, 1, 10) / 1000,
      offsetMinutes: 60,
    });
    winter.user('Bob', 'winter', 0);
    const all = [...summer.messages, ...winter.messages];
    const r = parsePages([[{ label: 'Mac/messages.html', html: macPageHtml(BOT, all) }]], {
      ...OPTS,
      timeZone: 'Europe/Rome',
    });
    expect(r.messages.map((m) => m.date)).toStrictEqual([
      '01.07.2025 12:00:00 UTC+02:00',
      '01.12.2025 11:00:00 UTC+01:00',
    ]);
  });

  it('time_zone_converts_dates_and_never_the_system_zone', async () => {
    const c = macDm();
    const r = parsePages(
      [[{ label: 'Mac/messages.html', html: macPageHtml(BOT, c.messages, IDS) }]],
      { ...OPTS, timeZone: 'Asia/Kolkata' }
    );
    expect(r.messages[0]?.date).toBe(`${tgDate(0).slice(0, 19)} UTC+05:30`);
    expect(r.warnings).toStrictEqual([
      'Mac: dates without a UTC offset, read in the time zone Asia/Kolkata',
    ]);
    // Only macOS exports need it: Windows dates are untouched and no line is printed.
    const w = parsePages([[{ label: 'Win/messages.html', html: pageHtml(BOT, c.messages) }]], {
      ...OPTS,
      timeZone: 'Asia/Kolkata',
    });
    expect(w.messages.map((m) => m.date)).toStrictEqual(c.messages.map((m) => m.date));
    expect(w.warnings).toStrictEqual([]);
  });

  it('undated_or_unparsable_macos_dates_need_no_offset', async () => {
    const html = macPageHtml(BOT, []).replace(
      '<div class="history">',
      '<div class="history">\n<div class="message default clearfix" id="message1"><div class="body">' +
        '<div class="pull_right date details" title="17 Octobre 2026, 05:35:33">05:35</div><div class="from_name">Bob</div><div class="text">hello</div></div></div>'
    );
    const r = parsePages([[{ label: 'Mac/messages.html', html }]], OPTS);
    expect(r.messages[0]?.date).toBe('17 Octobre 2026, 05:35:33'); // not a date: kept verbatim, sorted like an undated message
    expect(r.warnings).toStrictEqual([]);
  });
});

describe('sender user ids', () => {
  it('ids_inherited_by_joined_messages_and_across_pages', () => {
    const g = new Chat('G', 10);
    g.user('Bob', '/play', 0);
    g.user('Bob', 'more', 1); // joined
    g.bot('@bob, Found a stone.', 2);
    g.user('Carol', 'hello', 3);
    g.user('Carol', 'joined at the top of page 2', 4)._joined = true;
    g.forward('Bob', 'Carol', 'forwarded', 5);
    const pages = [
      { label: 'G/messages.html', html: macPageHtml('G', g.messages.slice(0, 4), IDS) },
      { label: 'G/messages2.html', html: macPageHtml('G', g.messages.slice(4), IDS) },
    ];
    const r = parsePages([pages], OPTS);
    expect(r.messages.map((m) => [m.sender, m.sender_id])).toStrictEqual([
      ['Bob', key('Bob')],
      ['Bob', key('Bob')],
      [BOT, key(BOT)],
      ['Carol', key('Carol')],
      ['Carol', key('Carol')],
      ['Bob', key('Bob')],
    ]);
    const out = r.messages.map((m) => JSON.stringify(m)).join('\n');
    expect(out).not.toContain('999000999'); // the forwarded author's avatar is not the sender's
    expect(Object.keys(r.messages[0] as object).at(-1)).toBe('sender_id'); // only when known
  });

  it('no_avatar_no_id_and_windows_messages_unchanged', () => {
    const g = new Chat('G', 10);
    g.user('Dana', 'no photo', 0);
    g.user('Bob', 'with photo', 1);
    g.user('Erin', 'after', 2);
    const r = parsePages(
      [[{ label: 'G/messages.html', html: macPageHtml('G', g.messages, { Bob: IDS.Bob }) }]],
      { ...OPTS, timeZone: 'UTC' }
    );
    expect(r.messages.map((m) => m.sender_id)).toStrictEqual([undefined, key('Bob'), undefined]);
    const w = parsePages([[{ label: 'W/messages.html', html: pageHtml('G', g.messages) }]], OPTS);
    expect(w.messages.every((m) => !('sender_id' in m))).toBe(true);
  });
});

describe('Windows and macOS copies of a message', () => {
  it('one_message_with_the_windows_date_and_the_macos_id', () => {
    const c = macDm();
    const ids = c.messages.map((m) => m.id);
    for (const order of [
      ['Mac', 'Win'],
      ['Win', 'Mac'],
    ]) {
      const page = (name: string): Page =>
        name === 'Mac'
          ? { label: 'Mac/messages.html', html: macPageHtml(BOT, c.messages, IDS) }
          : { label: 'Win/messages.html', html: pageHtml(BOT, c.messages.slice(0, 2)) };
      // Another offset than the Windows one: the converted date gives way where both exist.
      const r = parsePages(
        order.map((n) => [page(n)]),
        { ...OPTS, timeZone: 'Europe/Rome' }
      );
      expect(
        r.messages.map((m) => m.id),
        order.join()
      ).toStrictEqual(ids);
      expect(r.messages.map((m) => m.date)).toStrictEqual(c.messages.map((m) => m.date)); // inferred UTC-05:00
      expect(r.messages.map((m) => m.sender_id)).toStrictEqual([
        key('Alice'),
        key(BOT),
        key('Alice'),
        key(BOT),
      ]);
    }
  });

  it('native_date_kept_over_the_converted_one', async () => {
    const c = macDm();
    const win = c.messages.map((m) => ({ ...m, date: tgDate(0, c.base, 60) })); // another wall clock: no inference
    const r = parsePages(
      [
        [{ label: 'Win/messages.html', html: pageHtml(BOT, win.slice(0, 1)) }],
        [{ label: 'Mac/messages.html', html: macPageHtml(BOT, c.messages.slice(0, 2), IDS) }],
      ],
      OPTS
    );
    expect(r.messages.map((m) => m.date)).toStrictEqual([win[0]?.date, c.messages[1]?.date]);
    expect(macDate(c.messages[1]?.date as string)).toBe('27 November 2025, 19:00:01');
  });
});

const div = (cls: string, inner: string): string => `<div class="${cls}">${inner}</div>`;
const date = (s: number): string =>
  `<div class="pull_right date details" title="${tgDate(s)}">00:00</div>`;
const from = (n: string): string => div('from_name', n);
const text = (t: string): string => div('text', t);

function msg(id: number, body: string, joined = false): string {
  return `<div class="message default clearfix${joined ? ' joined' : ''}" id="message${id}">${div('body', body)}</div>`;
}

/** A page from hand-written message blocks, for markup the Chat builder cannot produce. */
function rawPage(title: string, blocks: readonly string[]): string {
  return pageHtml(title, []).replace(
    '<div class="history">',
    '<div class="history">\n' + blocks.join('\n')
  );
}

function parseRaw(title: string, blocks: readonly string[]): ExportMessage[] {
  const p = new ExportParser();
  p.feed(rawPage(title, blocks));
  p.close();
  return p.messages;
}

const fwd = (author: string | null, body: string): string =>
  '<div class="pull_left forwarded userpic_wrap"></div>' +
  div(
    'forwarded body',
    (author === null
      ? ''
      : from(`${author}<span class="date details" title="${tgDate(0)}"> x</span>`)) + text(body)
  );

describe('markup edge cases', () => {
  it('negative_reply_id_is_kept', () => {
    const [, reply] = parseRaw('G', [
      msg(5, date(0) + from('Bob') + text('/play')),
      msg(
        6,
        date(1) +
          from('Carol') +
          div('reply_to details', 'In reply to <a href="#go_to_message-999">this message</a>') +
          text('ok')
      ),
    ]);
    expect(reply?.reply_to).toBe(-999);
  });

  it('negative_reply_id_in_a_link_to_another_page', () => {
    const [, reply] = parseRaw('G', [
      msg(-999700001, date(0) + from('Bob') + text('/play')),
      msg(
        7,
        date(1) +
          from('Carol') +
          div(
            'reply_to details',
            'In reply to <a href="messages3.html#go_to_message-999700001">this message</a>'
          ) +
          text('ok')
      ),
    ]);
    expect(reply?.reply_to).toBe(-999700001);
  });

  it('joined_forward_keeps_original_author', () => {
    const msgs = parseRaw('G', [
      msg(5, date(0) + from('Carol') + fwd(BOT, '@carol, you have:<br>- a stone x2')),
      // Same original author as the previous forward: Telegram omits the inner from_name.
      msg(6, date(1) + fwd(null, '@carol, you have:<br>- an apple x1'), true),
    ]);
    expect(msgs.map((m) => m.forwarded_from)).toStrictEqual([BOT, BOT]);
  });

  it('joined_forward_after_a_plain_message_has_no_implied_author', () => {
    const msgs = parseRaw('G', [
      msg(5, date(0) + from('Carol') + fwd(BOT, '@carol, you have:<br>- a stone x2')),
      msg(6, date(1) + text('hello'), true), // not a forward: breaks the chain
      msg(7, date(2) + fwd(null, 'forwarded'), true),
      msg(8, date(3) + from('Dana') + fwd(null, 'no author')), // not joined: nothing implied
    ]);
    expect(msgs.map((m) => [m.sender, m.forwarded_from])).toStrictEqual([
      ['Carol', BOT],
      ['Carol', null],
      ['Carol', null],
      ['Dana', null],
    ]);
  });

  it('via_bot_is_not_part_of_the_name', () => {
    const [m] = parseRaw('G', [msg(5, date(0) + from('Bob Stone via @gif') + text('hello'))]);
    expect(m?.sender).toBe('Bob Stone');
  });

  it('via_bot_is_removed_from_forwarded_authors_only_as_a_suffix', () => {
    const msgs = parseRaw('G', [
      msg(5, date(0) + from('Carol') + fwd('Dana Brook via @gif', 'hello')),
      msg(6, date(1) + from('Frank @dana') + text('hello')), // not "via @": kept
      msg(7, date(2) + from('via @gif Erin') + text('hello')), // not at the end: kept
    ]);
    expect(msgs.map((m) => [m.sender, m.forwarded_from])).toStrictEqual([
      ['Carol', 'Dana Brook'],
      ['Frank @dana', null],
      ['via @gif Erin', null],
    ]);
  });

  it('pages_in_the_working_folder_are_one_export', async () => {
    const dir = tempDir();
    const c = new Chat('G');
    c.user('Bob', 'end of page one', 0);
    c.user('Bob', 'start of page two', 1); // joined: the sender comes from page 1
    writeExport(dir, 'G', [c.messages.slice(0, 1), c.messages.slice(1)], new Set([2]));
    const cwd = process.cwd();
    process.chdir(dir);
    let result: Awaited<ReturnType<typeof runParse>>;
    try {
      result = runParse(['.']);
    } finally {
      process.chdir(cwd);
    }
    expect(result.msgs.map((m) => m.sender)).toStrictEqual(['Bob', 'Bob']);
    expect(result.err).toContain('exports: 1;');
  });

  it('export_key_of_a_bare_page_name_is_the_current_folder', () => {
    expect(
      [
        'messages.html',
        'messages2.html',
        './messages3.html',
        'a/messages.html',
        'a\\b\\messages.html',
      ].map(exportKey)
    ).toStrictEqual(['.', '.', '.', 'a', 'a/b']);
  });

  it('message_without_a_date_does_not_sort_first', async () => {
    const dir = tempDir();
    const blocks = [
      msg(1, date(0) + from('Dana') + text('first')),
      msg(2, from('Dana') + text('no date')),
      msg(3, date(2) + from('Dana') + text('third')),
    ];
    fs.writeFileSync(path.join(dir, 'messages.html'), rawPage('G', blocks), 'utf-8');
    // Within a chat a message without a date keeps its place by id.
    expect(runParse([dir]).msgs.map((m) => m.id)).toStrictEqual([1, 2, 3]);
  });

  it('undated_messages_take_the_nearest_dated_neighbour_of_their_chat', () => {
    const m = (chat: string, id: number, date: string | null) => ({ chat, id, date });
    const t = (s: number): string => tgDate(s);
    const msgs = [
      m('A', 1, null), // no earlier dated message in A: the next one's instant
      m('A', 2, t(10)),
      m('B', 1, t(5)),
      m('A', 3, 'garbage'), // unparsable: the previous one's instant
      m('B', 2, t(20)),
      m('C', 1, null), // no dated message in C: instant 0
      m('Z', 1, '31.12.1969 19:00:00 UTC-05:00'), // a real epoch-0 message
    ];
    expect(sortMessages(msgs).map((x) => `${x.chat}${x.id}`)).toStrictEqual([
      'C1',
      'Z1',
      'B1',
      'A1',
      'A2',
      'A3',
      'B2',
    ]);
  });

  it('page_name_telegram_does_not_write_is_not_read', async () => {
    // messages01.html would otherwise be read as a second page 1 next to messages.html.
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, 'messages.html'),
      rawPage('G', [msg(1, date(0) + from('Dana') + text('page 1'))]),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(dir, 'messages01.html'),
      rawPage('G', [msg(2, date(1) + from('Dana') + text('page 01'))]),
      'utf-8'
    );
    expect(runParse([dir]).msgs.map((m) => m.id)).toStrictEqual([1]);
  });

  it('only_telegram_page_names_are_pages', () => {
    const dir = tempDir();
    const names = [
      'messages.html',
      'messages1.html',
      'messages2.html',
      'messages02.html',
      'messages10.html',
      'messages٣.html',
    ];
    names.forEach((n, i) =>
      fs.writeFileSync(
        path.join(dir, n),
        rawPage('G', [msg(i + 1, date(i) + from('Dana') + text(n))]),
        'utf-8'
      )
    );
    expect([...iterPages(dir, () => {})].map((p) => path.basename(p.label))).toStrictEqual([
      'messages.html',
      'messages2.html',
      'messages10.html',
    ]);
    expect(() => pageKey('messages01.html')).toThrow();
  });

  it('service_entry_closes_the_current_message', () => {
    const msgs = parseRaw('G', [
      msg(1, date(0) + from('Dana') + text('hello')),
      // A service entry whose markup has a text div must not leak into message 1.
      `<div class="message service" id="message-1"><div class="body details">${text('Dana joined the group')}</div></div>`,
    ]);
    expect(msgs.map((m) => m.text)).toStrictEqual(['hello']);
  });

  it('service_entry_keeps_the_sender_and_the_next_message', () => {
    const msgs = parseRaw('G', [
      msg(1, date(0) + from('Dana') + text('hello')),
      `<div class="message service" id="message-1"><div class="body details">${from('Erin')}</div></div>`,
      `<div class="message service" id="message2"><div class="body details">Dana pinned <a href="#go_to_message1" onclick="return GoToMessage(1)">this message</a></div></div>`,
      msg(3, date(2) + text('again'), true),
    ]);
    expect(msgs.map((m) => [m.id, m.sender, m.text, m.reply_to])).toStrictEqual([
      [1, 'Dana', 'hello', null],
      [3, 'Dana', 'again', null],
    ]);
  });
});
