import { describe, expect, it } from 'vitest';
import { type ExportMessage } from '#src/messages.ts';
import { LOBBY, QUEST_HTML, QUEST_JSON, QUEST_MAPPING, T0 } from '#test/quest.ts';
import { readExportPaths } from './files.ts';
import { toInbounds } from './inbound.ts';

const S = 1000;

const read = (dir: string): ExportMessage[] => readExportPaths([dir], () => {}).messages;

describe('toInbounds', () => {
  it('delivers_an_export_as_the_owner_s_account_would_have', () => {
    const inbounds = toInbounds(read(QUEST_HTML), QUEST_MAPPING);
    expect(inbounds.slice(0, 2)).toStrictEqual([
      {
        account: 'telegram:alice',
        network: 'telegram',
        chat: '@QuestBot',
        private: true,
        senderUsername: 'alice',
        text: '/play',
        time: T0,
        id: '100',
        playback: false,
        own: true,
      },
      {
        account: 'telegram:alice',
        network: 'telegram',
        chat: '@QuestBot',
        private: true,
        senderUsername: 'QuestBot',
        text: 'Found an apple.',
        time: T0 + 2 * S,
        id: '101',
        replyTo: '100',
        playback: false,
        own: false,
      },
    ]);
    expect(
      inbounds.map((m) => [m.chat, m.senderUsername, m.text, (m.time - T0) / S])
    ).toStrictEqual([
      ['@QuestBot', 'alice', '/play', 0],
      ['@QuestBot', 'QuestBot', 'Found an apple.', 2],
      ['@QuestBot', 'alice', '/play', 300],
      ['@QuestBot', 'QuestBot', 'Too soon: 12 minutes.', 301],
      ['@QuestBot', 'alice', '/play', 1200],
      ['@QuestBot', 'QuestBot', 'The sky is green.', 1201],
      [LOBBY, 'bob', 'hello all', 1800],
      [LOBBY, 'alice', '/play@QuestBot', 1860],
      [LOBBY, 'QuestBot', 'Defeated.', 1861],
      [LOBBY, 'bob', '/play@QuestBot', 1920],
      [LOBBY, 'QuestBot', 'Found a pear.', 1921],
    ]);
  });

  it('gives_the_json_export_the_same_inbounds_its_chat_id_an_alias', () => {
    const html = toInbounds(read(QUEST_HTML), QUEST_MAPPING, { playback: true });
    const json = toInbounds(read(QUEST_JSON), QUEST_MAPPING, { playback: true });
    expect(json.map(({ aliases, ...m }) => m)).toStrictEqual(html.map(({ aliases, ...m }) => m));
    expect(json.map((m) => m.aliases)).toStrictEqual(
      json.map((m) => (m.chat === '@QuestBot' ? ['1000000001'] : undefined))
    );
    expect(json.every((m) => m.playback)).toBe(true);
  });

  it('names_by_ids_where_the_export_has_them_and_defaults_where_nothing_is_given', () => {
    const messages = read(QUEST_JSON);
    // By ids alone: the chats by their id, the private one by its kind.
    const byIds = toInbounds(messages, {
      owner: { ids: ['user1000000003'] },
      chats: { '1000000001': { chat: '@QuestBot', aliases: ['1000000001'] } },
      senders: { user1000000001: 'QuestBot' },
    });
    expect(byIds[0]).toMatchObject({
      account: 'telegram:owner',
      chat: '@QuestBot',
      aliases: ['1000000001'],
      private: true,
      own: true,
    });
    expect(byIds[0]).not.toHaveProperty('senderUsername');
    expect(byIds.at(-1)).toMatchObject({ chat: LOBBY, private: false, senderUsername: 'QuestBot' });
    // Nothing given: by the export's chat id, no username, not the owner's.
    expect(toInbounds(messages, { owner: {} })[0]).toMatchObject({
      chat: '1000000001',
      own: false,
    });
    expect(toInbounds(messages, { owner: {} })[0]).not.toHaveProperty('senderUsername');
    // An HTML export with nothing given: by title, privacy unsaid.
    const html = toInbounds(read(QUEST_HTML), { owner: {}, chats: { QuestBot: '@QuestBot' } });
    expect(html[0]).not.toHaveProperty('private');
    expect(html.map((m) => m.chat)).toContain('Quest Lobby');
  });

  it('places_undated_messages_and_carries_a_text_file', () => {
    const m = (
      id: number,
      date: string | null,
      extra: Partial<ExportMessage> = {}
    ): ExportMessage => ({
      chat: null,
      id,
      date,
      sender: null,
      forwarded_from: null,
      reply_to: null,
      text: `m${id}`,
      ...extra,
    });
    const inbounds = toInbounds(
      [
        m(1, null),
        m(2, '06.11.2026 13:00:00 UTC+01:00', { file_name: 'state.txt', file_text: 'é' }),
        m(3, 'garbage', { file_text: 'x' }),
      ],
      { owner: {} }
    );
    expect(inbounds.map((x) => [x.chat, x.id, x.time])).toStrictEqual([
      ['?', '1', T0],
      ['?', '2', T0],
      ['?', '3', T0],
    ]);
    expect(inbounds[1]?.document).toStrictEqual({
      name: 'state.txt',
      mime: 'text/plain',
      size: 2,
      text: 'é',
    });
    expect(inbounds[2]?.document?.name).toBe('');
    expect(toInbounds([m(1, null)], { owner: {} })[0]?.time).toBe(0);
    // Out of order across chats: sorted by time, stably.
    const later = m(4, '06.11.2026 13:10:00 UTC+01:00');
    expect(
      toInbounds([later, m(5, '06.11.2026 13:00:00 UTC+01:00')], { owner: {} }).map((x) => x.id)
    ).toStrictEqual(['5', '4']);
  });
});
