# @megabottron1999/telegram-export

The dev kit's reader of Telegram Desktop chat exports (docs/bot-os.md D130, #60): it reads the HTML
and the JSON exports into one shape of message, merged and in time order, and turns them into the
`Inbound`s the owner's account (`telegram-user`) would have delivered, so that a recorded chat can
be replayed through real plugins. The format, for someone who never saw it, is
[docs/telegram-export.md](../../docs/telegram-export.md). It knows no bot and no game.

The HTML reader is ported from the wiki generator's (#60), which is validated across a large inbox
of groups and private chats, exported on Windows and on macOS; where readers disagree, its choices
are kept. Its reading files (`html.ts`, `html-events.ts`, `json.ts`, `merge.ts`, `listing.ts`,
`browser-files.ts`, `messages.ts` and their helpers) are pure logic, no Node APIs, and import
nothing of the shell, so that the wiki could import them in place of its copy.

## API

- `src/messages.ts`: `ExportMessage` (`chat`, `id`, `date` in the form
  `27.11.2025 19:14:19 UTC-05:00`, `sender`, `forwarded_from`, `reply_to`, `text`, and where known
  `chat_id`, `chat_type`, `sender_id`, `file_name`, `file_text`) and `Page` (an HTML page: `label`,
  `html`, its linked text `files`).
- `src/html.ts`: `ExportParser` (one page's messages, the sender carried from the page before),
  `pageKey`, `exportKey`, `sortMessages`, `exportOffsets`.
- `src/json.ts`: `readJsonExport(json, label, files?)` (a chat's `result.json`, or an account's with
  every chat), `markedChatId`, `jsonText`, `jsonChats`, `jsonTextFiles`.
- `src/merge.ts`: `ExportRecord`, `readHtmlExport(pages)`, `splitExports`,
  `mergeExports(records, { timeZone? })` (macOS dates given an offset, de-duplicated by (chat, id),
  sorted; `timeZone` needed only for a macOS export no other export overlaps), `parsePages`,
  `summaryLine`.
- `src/listing.ts`: `listExport(entries)` (the pages, JSON exports and warnings of a folder's
  entries), `linkedTextFiles`, `withTextFiles`, `decodeText`; `src/browser-files.ts`, the same from
  a browser's folder picker.
- `src/files.ts` (Node): `readExportPaths(paths, log, { timeZone? })` reads folders and `.json`
  files and merges them; `listInput`, `iterPages`, `readJsonFile`.
- `src/inbound.ts`: `toInbounds(messages, mapping, { playback? })`, with a `ReplayMapping`: the
  `account`, the `owner` (`username`, and their display `names` or `ids`: their messages are the
  account's own), the `chats` (by title or chat id: the name the connector's config lists, whether
  private, aliases), the `senders` (by id or display name: the username) and their `ids` (by display
  name, for an export that gives none); each sender's id as `senderId`, in the Bot API's form
  (`senderIdOf`, docs/bot-os.md D167).
- `src/replay.ts` (Node, docs/bot-os.md D131):
  `replay({ plugins, inbounds, graph?, playback?, self?, start?, until?, config?, settings?, documents?, history? })`
  runs a module's plugins, or a graph file in the live format (its path), on a `DevKit` whose
  `telegram-user` nodes are `FakeConnector`s (the real plugin's config schema; a node's `chats`
  deliver what it monitors, named as listed), and feeds the `Inbound`s in time order on its
  `VirtualClock`, the timers due on the way run at their time, live or as history (`playback`); each
  account's outbox is made at the start, so that the answers read hold commands back as live (D98).
  It returns the running `kit`, the `connectors` by node, `delivered`, `records()` (the event log),
  `drift()`, `read(node, name)` and `act(node, name, input)` (the plugins' state and actions, as the
  owner's controls reach them), `sent()` and `stop()`. `asMonitored` is a node's filter alone.
- `src/cli.ts`, run by `tools/telegram-export.ts`: prints the messages, or with
  `--inbounds <mapping.json>` the `Inbound`s, as JSON Lines, for a module's own replay tool to build
  on:

  ```bash
  node packages/telegram-export/tools/telegram-export.ts [--time-zone Europe/Rome] \
    [--inbounds mapping.json] [--playback] <export folder or result.json>...
  ```

The tests read invented exports only (`test/fixtures/`: alice's private chat with a made-up
@QuestBot and its group, as HTML and as JSON, a mapping, and a graph file; `test/helpers.ts` builds
others). The replay's test runs them through the shell's own `turnParserPlugin` with @QuestBot's
made-up grammar (`@megabottron1999/turns/test/quest.ts`, a dev dependency), with a readiness state
on its events (`readinessPlugin`, docs/bot-os.md D141): turns by hand in private and in the group,
the bot's answers, a "too soon", an unread answer, the turn's readiness after, and drift. A real
export never enters this repository.

Its dependencies: htmlparser2, whose tokenizer the HTML reader is built on (as the wiki
generator's); the core and the connectors (the replay's kit, and `telegram-user`'s id and config
schema).
