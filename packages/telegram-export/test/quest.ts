/**
 * The invented exports of the tests (test/fixtures): alice's private chat with a made-up game bot,
 * @QuestBot, and its group, Quest Lobby, exported as HTML and as JSON, and the mapping that replays
 * them as alice's account. Nothing here is from a real chat.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ReplayMapping } from '#src/inbound.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

/** The HTML export's folder, and the JSON export's. */
export const QUEST_HTML = path.join(FIXTURES, 'quest-html');
export const QUEST_JSON = path.join(FIXTURES, 'quest-json');
export const QUEST_MAPPING_FILE = path.join(FIXTURES, 'quest-mapping.json');

/** The replay's mapping: alice's own account, the chats as its connector names them. */
export const QUEST_MAPPING = JSON.parse(
  fs.readFileSync(QUEST_MAPPING_FILE, 'utf8')
) as ReplayMapping;

/** The group's id, as the connector names it. */
export const LOBBY = '-1001000000002';

/** The first message's time: 6 November 2026, 13:00 at UTC+01:00. */
export const T0 = Date.parse('2026-11-06T12:00:00Z');

/** A graph file in the live format: alice's account, monitoring both chats, and @QuestBot's parser. */
export const QUEST_GRAPH = path.join(FIXTURES, 'quest-graph.json');
