# Telegram Desktop chat exports

The chat history that Telegram Desktop exports, in HTML and in JSON, as the shell's dev kit reads it
(`@megabottron1999/telegram-export`, [its README](../packages/telegram-export/README.md)) to replay
a recorded chat through real plugins. It describes the format for someone who has never seen it; how
the readers read each element is summarised in [§9](#9-how-the-html-reader-reads-each-element) and
[§13](#13-the-json-export), and how a message becomes what a connector delivers in
[§14](#14-as-the-account-delivers-it). All names, texts and ids in examples are invented.

The HTML reader is ported from the wiki generator's (#60), validated across a large inbox of groups
and private chats, exported on Windows and on macOS; so is this document (its sections 1-12), as of
2026-10-26. Where readers disagree, its choices are kept. If the export format changes, update this
document.

Two variants of the HTML markup are known, both from Telegram Desktop: the **Windows export**
(written by Telegram Desktop on Windows), described in sections 2-10, and the **macOS export**
(Telegram Desktop on macOS), which differs in the points of [§11](#11-the-macos-export). They are
named after the system that produced them; whether the differences come from the operating system or
from the app version is not known. The **JSON export** is [§13](#13-the-json-export).

## Contents

- [1. Producing an export](#1-producing-an-export)
- [2. What is on disk](#2-what-is-on-disk)
- [3. Page skeleton](#3-page-skeleton)
- [4. History entries](#4-history-entries)
  - [4.1 Joined messages](#41-joined-messages)
  - [4.2 Service entries](#42-service-entries)
- [5. Anatomy of a message](#5-anatomy-of-a-message)
  - [5.1 Date](#51-date)
  - [5.2 Sender](#52-sender)
  - [5.3 Text](#53-text)
  - [5.4 Replies](#54-replies)
  - [5.5 Forwarded messages](#55-forwarded-messages)
  - [5.6 Media placeholders](#56-media-placeholders)
  - [5.7 Other blocks](#57-other-blocks)
- [6. Identity](#6-identity)
  - [6.1 Chats](#61-chats)
  - [6.2 Messages](#62-messages)
  - [6.3 Senders](#63-senders)
- [7. Commands in text](#7-commands-in-text)
- [8. Pitfalls](#8-pitfalls)
- [9. How the HTML reader reads each element](#9-how-the-html-reader-reads-each-element)
- [10. Annotated sample page](#10-annotated-sample-page)
- [11. The macOS export](#11-the-macos-export)
  - [11.1 On disk](#111-on-disk)
  - [11.2 Page and messages](#112-page-and-messages)
  - [11.3 Dates without an offset](#113-dates-without-an-offset)
  - [11.4 Sender ids](#114-sender-ids)
- [12. Unknowns](#12-unknowns)
- [13. The JSON export](#13-the-json-export)
- [14. As the account delivers it](#14-as-the-account-delivers-it)

## 1. Producing an export

Telegram Desktop → open the chat → chat menu (⋮) → _Export chat history_. The dialog offers media
types to include (photos, videos, voice messages, stickers, files…), a size limit, a date range and
the format.

- **Format**: HTML or machine-readable JSON (or both). HTML writes `messages*.html` pages; JSON
  writes a single `result.json` ([§13](#13-the-json-export)). A folder with both is read from its
  HTML pages.
- **Media** can all be deselected. Media messages then still appear in the HTML as placeholders
  ([§5.6](#56-media-placeholders)). With _Files_ selected, attached files are copied into the export
  and linked from their messages.
- **Date range**: an export can cover part of the history, so two exports of the same chat may
  overlap or leave a gap.

## 2. What is on disk

```
ChatExport_2025-11-28/       one export = one folder
  messages.html              page 1, oldest messages
  messages2.html             page 2
  ...
  messages17.html            last page, newest messages
  css/style.css              viewer assets
  js/script.js               viewer JS (GoToMessage, ShowBotCommand, ShowSpoiler, ...)
  images/                    UI icons only
  files/                     attached files, with Files selected: file.txt, file (1).txt, ...
```

- The folder is named `ChatExport_YYYY-MM-DD` after the export date. It carries no information about
  the chat. (The macOS export's folder is named after the chat, [§11.1](#111-on-disk).)
- Pages are `messages.html` (page 1) and `messagesN.html` for N ≥ 2, without zero padding. Page
  order is numeric (`messages10.html` follows `messages9.html`).
- Pages are chronological: page 1 holds the oldest messages, and within an export timestamps never
  decrease and ids increase from page to page.
- Every page but the last holds 1000 history entries (messages and service events; day separators
  are extra).
- Pages are UTF-8 (`<meta charset="utf-8"/>`).
- With media deselected there are no media folders. With _Files_ selected, `files/` holds the
  attached files under their own names, those after the first of a name numbered before the
  extension: `file.txt`, `file (1).txt`, `file (2).txt`.

## 3. Page skeleton

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Exported Data</title>
    <!-- constant -->
    <link href="css/style.css" rel="stylesheet" />
    <script src="js/script.js" type="text/javascript"></script>
  </head>
  <body onload="CheckLocation();">
    <div class="page_wrap">
      <div class="page_header">
        <div class="content">
          <div class="text bold">Chat title</div>
        </div>
      </div>
      <div class="page_body chat_page">
        <div class="history">
          <a class="pagination block_link" href="messages.html">Previous messages</a>
          <!-- pages >= 2 -->
          ... history entries ...
          <a class="pagination block_link" href="messages3.html">Next messages</a>
          <!-- all but the last page -->
        </div>
      </div>
    </div>
  </body>
</html>
```

- The markup is pretty-printed: text nodes are wrapped in newlines and indentation, so every value
  must be stripped.
- `div.page_header div.text bold` holds the **chat title**, repeated on every page: the group name
  for a group, the other party's display name for a private chat. The private chat with a bot is
  titled with the bot's display name (`QuestBot`).
- `<title>` is always `Exported Data`.
- A single-page export has no pagination links.

## 4. History entries

Each entry in `div.history` is a `div` whose class starts with `message`:

| Class                             | Kind                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `message default clearfix`        | A message with a full sender block (avatar and name).                        |
| `message default clearfix joined` | A message by the same sender as the previous entry, without avatar and name. |
| `message service`                 | A day separator or a service event.                                          |

### 4.1 Joined messages

A joined message has no `div.pull_left.userpic_wrap` and no `div.from_name`; its sender is the
sender of the previous message entry. Telegram joins messages by the same sender sent less than 15
minutes apart, though not every such pair is joined. The first message of a page and the first
message after a day separator carry a full sender block.

```html
<div class="message default clearfix joined" id="message1002">
  <div class="body">
    <div class="pull_right date details" title="27.11.2025 19:00:03 UTC-05:00">19:00</div>
    <div class="text">...</div>
  </div>
</div>
```

### 4.2 Service entries

```html
<div class="message service" id="message-1">
  <div class="body details">27 November 2025</div>
</div>
```

- **Day separators**: body `D Month YYYY` with an English month name. Their ids are `-1, -2, …`,
  numbered through the whole export, so they differ between exports.
- **Service events** (members joining, pinned messages, title changes…) carry real message ids and
  may contain `GoToMessage` links.
- Service entries have no date div and no `from_name`.

## 5. Anatomy of a message

```html
<div class="message default clearfix" id="message1001">
  <div class="pull_left userpic_wrap">
    <!-- absent when joined -->
    <div class="userpic userpic5" style="width: 42px; height: 42px">
      <div class="initials" style="line-height: 42px">MR</div>
    </div>
  </div>
  <div class="body">
    <div class="pull_right date details" title="27.11.2025 19:00:02 UTC-05:00">19:00</div>
    <div class="from_name">Bob Stone</div>
    <!-- absent when joined -->
    <div class="reply_to details">...</div>
    <!-- optional -->
    ... div.forwarded body | div.media_wrap | div.text ...
    <table class="bot_buttons_table">
      ...
    </table>
    <!-- optional -->
    <span class="reactions">...</span>
    <!-- optional -->
  </div>
</div>
```

| Element                                     | Meaning                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id="message<N>"`                           | Message id ([§6.2](#62-messages)).                                                                             |
| `div.userpic userpicN` / `div.initials`     | Avatar placeholder: a colour class and the name's initials (possibly empty). Not an identity.                  |
| `div.pull_right date details[title]`        | Timestamp, exactly one per message ([§5.1](#51-date)).                                                         |
| `div.from_name`                             | Sender display name ([§5.2](#52-sender)).                                                                      |
| `div.reply_to details`                      | Reply link ([§5.4](#54-replies)).                                                                              |
| `div.forwarded body`                        | Forwarded content ([§5.5](#55-forwarded-messages)).                                                            |
| `div.media_wrap clearfix`                   | Media placeholder ([§5.6](#56-media-placeholders)).                                                            |
| `div.text`                                  | Text, or the caption of a media message ([§5.3](#53-text)). Absent for media without caption, polls, stickers. |
| `table.bot_buttons_table`, `span.reactions` | Inline keyboard, reactions ([§5.7](#57-other-blocks)).                                                         |

### 5.1 Date

`title="27.11.2025 19:14:19 UTC-05:00"`, i.e. `DD.MM.YYYY HH:MM:SS UTC±HH:MM`: day first, the local
wall-clock time of the exporting computer, then a UTC offset label. The element text is only
`HH:MM`.

- Compare timestamps as instants (parse with the offset, convert to UTC), never as strings:
  `27.11.2025 20:00:00 UTC-05:00` is later than `28.11.2025 00:30:00 UTC+00:00`.
- **The offset label does not follow daylight saving time.** A Windows export labels every date with
  one constant UTC offset, while the time written is the local wall-clock time including daylight
  saving time. During daylight saving time the label is therefore one hour off the true offset, and
  so is an instant computed from it: in a zone at `UTC-05:00` in winter, summer dates also read
  `UTC-05:00`. Whether the constant is the zone's standard offset written by Telegram, or comes from
  a time zone setting without daylight saving time, is not known. The readers take the dates as
  written: only a duration that spans a daylight-saving change can be one hour off.
- Resolution is one second; a command and the bot's reply often share a timestamp.
- There is no edited marker: an edited message looks like any other.

### 5.2 Sender

```html
<div class="from_name">QuestBot</div>
```

- Plain text: the sender's **display name**, with no link, user id or @username (the macOS export
  gives a user id in the avatar instead, [§11.4](#114-sender-ids)).
- An account without a last name is followed by a space (`QuestBot `).
- A deleted account is shown as `Deleted Account`, shared by every deleted account.
- A message sent through an inline bot reads `Bob Stone via @gif` in `from_name`, as plain text.

### 5.3 Text

```html
<div class="text">
  <a href="https://t.me/bob_s">@bob_s</a>, you are: <strong>at the foot of Mount Example ⛰</strong
  ><br />You can go:<br />
  - to the windy valley 🏞
</div>
```

| Construct                                                                              | Meaning                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `<br>` / `<br/>`                                                                       | Line break.                                                               |
| Entities (`&apos;`, `&quot;`, `&amp;`, numeric)                                        | Escaped characters; the bot's apostrophes are `&apos;`.                   |
| `<strong>`, `<em>`, `<code>`, `<pre>`, `<blockquote>`, `<span class="spoiler hidden">` | Formatting around visible text.                                           |
| `<a href="https://t.me/bob_s">@bob_s</a>`                                              | A mention or link; the visible text is what was written.                  |
| `<a href="" onclick="return ShowBotCommand(&quot;cmd&quot;)">/cmd</a>`                 | A bot command ([§7](#7-commands-in-text)).                                |
| `<a href="tg://bot_command?command=cmd&amp;bot=QuestBot">…</a>`                        | A bot command link (rarer form).                                          |
| `<a onclick="return ShowMentionName()">Name</a>`                                       | Mention of a user without a username; the visible text is a display name. |
| `ShowHashtag`, `ShowTextCopied`, `ShowSpoiler`, `ShowNotLoadedEmoji` anchors           | Hashtags, copyable code, spoilers, custom emoji.                          |

The visible text of a message is the concatenation of the text nodes, with `<br>` as a newline,
stripped. A `div.text` is never empty.

### 5.4 Replies

```html
<div class="reply_to details">
  In reply to
  <a href="#go_to_message355915" onclick="return GoToMessage(355915)">this message</a>
</div>
```

- Fixed text `In reply to` and a link `this message`; the quoted text is not included.
- `href` is `#go_to_messageN` when the target is on the same page, `messagesK.html#go_to_messageN`
  when it is on page K (`messages.html#…` for page 1).
- N can be negative (`#go_to_message-999732842`) in chats with negative ids.
- The target may be missing from the export (deleted, or outside the exported range).

### 5.5 Forwarded messages

```html
<div class="message default clearfix" id="message4242">
  <div class="pull_left userpic_wrap">...</div>
  <div class="body">
    <div class="pull_right date details" title="17.02.2026 15:00:10 UTC-05:00">15:00</div>
    <div class="from_name">Bob Stone</div>
    <!-- who forwarded -->
    <div class="pull_left forwarded userpic_wrap">...</div>
    <div class="forwarded body">
      <div class="from_name">
        QuestBot
        <span class="date details" title="17.02.2026 14:09:52 UTC-05:00"> 17.02.2026 14:09:52</span>
      </div>
      <div class="text">@carol_v, you have:<br />- a stone x2</div>
    </div>
  </div>
</div>
```

- The outer sender (explicit or inherited) is who forwarded; the date div is the time of forwarding.
- The inner `from_name` inside `div.forwarded body` is the **original author**, followed by a
  `span.date details` with the original timestamp (same format as [§5.1](#51-date)).
- The forwarded text or media is inside the forwarded block; there is no outer `div.text`.
- Consecutive forwards are often joined. A joined forward whose original author differs from the
  previous entry's keeps the forwarded avatar and the inner `from_name`. A **joined forward with the
  same original author as the previous forward has neither**: its original author is implied by the
  previous entry.
- Inner names can also carry `via @somebot`.

### 5.6 Media placeholders

```html
<div class="media_wrap clearfix">
  <div class="media clearfix pull_left media_photo">
    <div class="fill pull_left"></div>
    <div class="body">
      <div class="title bold">Sticker</div>
      <div class="description">...</div>
      <div class="status details">...</div>
    </div>
  </div>
</div>
```

| Class suffix                                                                    | `title bold`                               |
| ------------------------------------------------------------------------------- | ------------------------------------------ |
| `media_photo`                                                                   | `Photo`, `Sticker`                         |
| `media_video`                                                                   | `Animation`, `Video file`, `Video message` |
| `media_voice_message`                                                           | `Voice message`                            |
| `media_audio_file`, `media_file`                                                | file-specific                              |
| `block_link media_location`, `media_live_location`, `media_venue`, `media_game` |                                            |
| `media_poll` (with `question bold`, `answer`, `details`, `total details`)       |                                            |

A captioned media message has a `div.text` after the `media_wrap`. A media block contains its own
`div.body` and `div.title bold`.

An **attached file** (`media_file`) has the file's name as its `title bold` and its size as its
`status details`. Left out of the export, it is a `div` whose `description` says so; included, the
block is a link to the file, with no `description`:

```html
<div class="media_wrap clearfix">
  <div class="media clearfix pull_left media_file">
    <div class="fill pull_left"></div>
    <div class="body">
      <div class="title bold">file.txt</div>
      <div class="description">Not included, change data exporting settings to download.</div>
      <div class="status details">14.7 KB</div>
    </div>
  </div>
</div>
```

```html
<div class="media_wrap clearfix">
  <a class="media clearfix pull_left block_link media_file" href="files/file (1).txt">
    <div class="fill pull_left"></div>
    <div class="body">
      <div class="title bold">file.txt</div>
      <div class="status details">14.8 KB</div>
    </div>
  </a>
</div>
```

The `href` is the path of the file in the export, relative to the page, as written on disk (spaces
included, not percent-encoded); the title keeps the name the file was sent with, so only the link
tells two files of one name apart. A bot may send its own state as a text file with a caption; the
readers keep the text of such a file ([§9](#9-how-the-html-reader-reads-each-element)).

### 5.7 Other blocks

| Block                                                                                                               | Meaning                                                             |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `table.bot_buttons_table` → `td.bot_button_row` → `div.bot_button` → `<a>` → `<div>label</div>`                     | Inline keyboard under a bot message; labels are outside `div.text`. |
| `span.reactions` → `span.reaction [active]` → `span.emoji`, `span.userpics` → `div.userpic` → `div.initials[title]` | Reactions; `title` holds a reacting user's display name.            |

## 6. Identity

### 6.1 Chats

- In the HTML export the only chat identifier is the page-header title; there is no chat id (the
  JSON export has one, [§13](#13-the-json-export)).
- A private chat with a bot is titled with the bot's display name (`QuestBot`).

### 6.2 Messages

- `id="message<N>"`: Telegram's message id, unique within a chat but **not** across chats (different
  chats reuse the same numbers). A message is identified by **(chat title, id)**; overlapping
  exports repeat messages with the same ids.
- Ids increase with time within a chat.
- **Ids can be negative** for regular messages: some chats have an older range of ids around −999
  700 000 (increasing) followed by small positive ids.
- Day-separator ids are renumbered per export and identify nothing.

### 6.3 Senders

- In the Windows export senders are known only by display name: it contains **no user ids and no
  @usernames** for senders. The macOS export also gives each sender's numeric user id
  ([§11.4](#114-sender-ids)), but no @username either.
- @usernames appear only in text: mentions (`<a href="https://t.me/bob_s">@bob_s</a>`) and the bot's
  replies, which address the player by @username.
- Display names are not unique: `Deleted Account` covers all deleted accounts, and two people can
  share a name.
- A bot is recognisable only by its display name (`QuestBot`).

## 7. Commands in text

- A typed command is an anchor followed by its arguments as plain text:
  `<a href="" onclick="return ShowBotCommand(&quot;craft&quot;)">/craft</a> basket`. Commands
  mentioned in bot replies use the same markup.
- In groups a command can be addressed to a bot: visible text `/craft@QuestBot`
  (`ShowBotCommand(&quot;craft@QuestBot&quot;)`), or `/start@OtherBot` for another bot. The bot
  name's case may vary.

## 8. Pitfalls

- Page files sort wrongly as strings (`messages10.html` < `messages2.html`).
- Folder names are arbitrary; on Windows, paths use `\`.
- A joined message has no sender of its own; one starting a page would need the sender from the
  previous page of the same export.
- Message ids can be negative, in messages and in reply links.
- Reply targets can be missing from the export.
- A joined forwarded message can lack the inner `from_name`.
- Names can end with a space and can contain `via @somebot`.
- Textless messages (stickers, photos without caption, polls, voice messages) still define the
  sender of the joined messages after them.
- Timestamps must be compared as instants, with their offsets; the macOS export's have none
  ([§11.3](#113-dates-without-an-offset)), and the Windows export's ignore daylight saving time
  ([§5.1](#51-date)).
- Two people can share a display name; only the macOS export's user ids tell them apart
  ([§11.4](#114-sender-ids)).
- An edit between two exports is not marked; the same id may carry different text.
- The chat title is the only chat key: a group titled `QuestBot` would look like the private chat
  with the bot, and two groups with the same title would look like one chat.
- Service entries can contain links; a parser must not attribute their content to the previous
  message.

## 9. How the HTML reader reads each element

The reader is `packages/telegram-export/src/`: [`html.ts`](../packages/telegram-export/src/html.ts),
[`merge.ts`](../packages/telegram-export/src/merge.ts),
[`listing.ts`](../packages/telegram-export/src/listing.ts), and
[`files.ts`](../packages/telegram-export/src/files.ts) on disk.

| Element                                                                | Function                                                    | Gives                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages*.html` in folders (any depth)                                | `listExport`, `listInput`, `pageKey`                        | Pages (`messages.html`, `messagesN.html`, N ≥ 2 unpadded; other names ignored) in (folder, page number) order, folders and their entries sorted by name (code point order) at every level; a `result.json` in a folder without pages is a JSON export ([§13](#13-the-json-export)). |
| Page folder (label minus last component, `\` → `/`)                    | `exportKey`, `splitExports`                                 | Export key (`.` for a bare page name): one export, read into one record by `readHtmlExport`; the last sender is carried to the next page only within it.                                                                                                                            |
| First `div.text bold`; macOS: `div.name bold` inside `div.page_header` | `ExportParser.starttag`, `data`                             | `chat` (stripped). The macOS `div.subtitle details` is ignored.                                                                                                                                                                                                                     |
| `div` with class starting `message default`                            | `ExportParser.starttag`, `flush`                            | Starts a message, flushes the previous one; `id` from `message<N>`. A `message service` div also flushes it, and its content is ignored.                                                                                                                                            |
| `div.date details[title]` outside the forwarded block                  | `ExportParser.starttag`                                     | `date`, verbatim.                                                                                                                                                                                                                                                                   |
| macOS date title (`27 November 2025, 19:00:02`)                        | `parseMacDate`, `exportOffsets`, `mergeExports`             | `date` in the Windows form (`27.11.2025 19:00:02 UTC-05:00`) with the export's offset ([§11.3](#113-dates-without-an-offset)); a warning says which offset and where it comes from.                                                                                                 |
| macOS `img.userpic` in the message's own `div.pull_left userpic_wrap`  | `ExportParser.avatar`, `flush`                              | `sender_id` (`user<id>`), inherited by joined messages like the name ([§11.4](#114-sender-ids)).                                                                                                                                                                                    |
| Outer `div.from_name`                                                  | `ExportParser.endtag`, `flush`                              | `sender` (stripped, trailing `via @bot` removed); if absent, the previous message's sender.                                                                                                                                                                                         |
| `div.reply_to` → `<a href=…go_to_message(-?\d+)>`                      | `ExportParser.starttag`                                     | `reply_to`, negative ids included.                                                                                                                                                                                                                                                  |
| `div.forwarded body` → `div.from_name` (its `date` span skipped)       | `ExportParser.starttag`, `endtag`, `flush`                  | `forwarded_from` (trailing `via @bot` removed); a joined forward without it takes the previous forward's.                                                                                                                                                                           |
| `div.text` (`<br>` → `\n`, entities decoded, tags dropped)             | `ExportParser.starttag`, `startendtag`, `data`, `endtag`    | `text`; messages without it are not given but still set the sender.                                                                                                                                                                                                                 |
| `a.media_file` whose `href` is `files/<name>.txt`                      | `linkedTextFiles`, `withTextFiles`, `ExportParser.starttag` | `file_name` and `file_text`: the content of the file beside the page, read like a page (UTF-8, line ends as `\n`); nothing for a file the export does not hold or that is not UTF-8.                                                                                                |
| (chat, id)                                                             | `mergeExports`                                              | De-duplication across the exports of a run, HTML and JSON alike; the copy read last wins, but a date converted from a macOS export gives way to one written with its offset, and a known `sender_id`, `chat_id`, `chat_type`, `file_name` and `file_text` are kept.                 |
| Date title                                                             | `parseWindowsDate`, `sortMessages`                          | Output sorted by instant, then chat, then id; a date not in the exact form of [§5.1](#51-date) counts as missing, and an undated message takes its chat neighbour's instant (by id).                                                                                                |

Media (except attached text files), reactions, inline keyboards, avatars (except the macOS sender
id), pagination links and service entries are ignored. A leading `/cmd@BotName` is kept as written:
which commands are a bot's is the reading plugin's business. Output: one `ExportMessage`
([`messages.ts`](../packages/telegram-export/src/messages.ts)) per message, with keys `chat`, `id`,
`date`, `sender`, `forwarded_from`, `reply_to`, `text`, then `chat_id`, `chat_type`, `sender_id`,
`file_name` and `file_text` when known.

Each export is read once, into an `ExportRecord` (`readHtmlExport`, `readJsonExport`): plain JSON
data, its messages in export order with their dates as written, since the offset of a macOS date
depends on the other exports of the run ([§11.3](#113-dates-without-an-offset)). Merging the records
of a run (`mergeExports`) converts the dates, de-duplicates and sorts as above.

## 10. Annotated sample page

Page 2 of an invented group export.

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Exported Data</title>
    <link href="css/style.css" rel="stylesheet" />
    <script src="js/script.js" type="text/javascript"></script>
  </head>
  <body onload="CheckLocation();">
    <div class="page_wrap">
      <div class="page_header">
        <div class="content">
          <div class="text bold">
            Quest Lobby
            <!-- chat title -->
          </div>
        </div>
      </div>
      <div class="page_body chat_page">
        <div class="history">
          <a class="pagination block_link" href="messages.html">Previous messages</a>

          <div class="message service" id="message-7">
            <!-- day separator -->
            <div class="body details">27 November 2025</div>
          </div>

          <!-- 1. a command addressed to the bot -->
          <div class="message default clearfix" id="message1000">
            <div class="pull_left userpic_wrap">
              <div class="userpic userpic3" style="width: 42px; height: 42px">
                <div class="initials" style="line-height: 42px">MR</div>
              </div>
            </div>
            <div class="body">
              <div class="pull_right date details" title="27.11.2025 19:00:00 UTC-05:00">19:00</div>
              <div class="from_name">Bob Stone</div>
              <div class="text">
                <a href="" onclick='return ShowBotCommand("craft@QuestBot")'>/craft@QuestBot</a>
                basket
              </div>
            </div>
          </div>

          <!-- 2. the bot's reply to message 1000; note the trailing space in the name -->
          <div class="message default clearfix" id="message1001">
            <div class="pull_left userpic_wrap">...</div>
            <div class="body">
              <div class="pull_right date details" title="27.11.2025 19:00:02 UTC-05:00">19:00</div>
              <div class="from_name">QuestBot</div>
              <div class="reply_to details">
                In reply to
                <a href="#go_to_message1000" onclick="return GoToMessage(1000)">this message</a>
              </div>
              <div class="text">
                <a href="https://t.me/bob_s">@bob_s</a>, you climb the frozen stream and find a
                pistachio nougat!
              </div>
            </div>
          </div>

          <!-- 3. joined: sender is the previous one (QuestBot) -->
          <div class="message default clearfix joined" id="message1002">
            <div class="body">
              <div class="pull_right date details" title="27.11.2025 19:00:03 UTC-05:00">19:00</div>
              <div class="text">Level up!<br />You can craft another one&apos;s worth.</div>
            </div>
          </div>

          <!-- 4. a sticker: no text -->
          <div class="message default clearfix" id="message1003">
            <div class="pull_left userpic_wrap">...</div>
            <div class="body">
              <div class="pull_right date details" title="27.11.2025 19:05:41 UTC-05:00">19:05</div>
              <div class="from_name">Carol Vale</div>
              <div class="media_wrap clearfix">
                <div class="media clearfix pull_left media_photo">
                  <div class="fill pull_left"></div>
                  <div class="body">
                    <div class="title bold">Sticker</div>
                    <div class="status details">...</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 5. joined forward by Carol Vale of a bot message, replying to a message on page 1,
            with a reaction -->
          <div class="message default clearfix joined" id="message1004">
            <div class="body">
              <div class="pull_right date details" title="27.11.2025 19:06:10 UTC-05:00">19:06</div>
              <div class="reply_to details">
                In reply to
                <a href="messages.html#go_to_message998" onclick="return GoToMessage(998)"
                  >this message</a
                >
              </div>
              <div class="pull_left forwarded userpic_wrap">...</div>
              <div class="forwarded body">
                <div class="from_name">
                  QuestBot
                  <span class="date details" title="26.11.2025 22:14:09 UTC-05:00">
                    26.11.2025 22:14:09</span
                  >
                </div>
                <div class="text">
                  <a href="https://t.me/carol_v">@carol_v</a>, you have:<br />- a stone x2
                </div>
              </div>
              <span class="reactions"
                ><span class="reaction"
                  ><span class="emoji">😍</span>
                  <span class="userpics"
                    ><div class="userpic userpic3" style="width: 20px; height: 20px">
                      <div class="initials" style="line-height: 20px" title="Bob Stone">BS</div>
                    </div></span
                  ></span
                ></span
              >
            </div>
          </div>

          <a class="pagination block_link" href="messages3.html">Next messages</a>
        </div>
      </div>
    </div>
  </body>
</html>
```

What it contains (all with chat `Quest Lobby`):

| id   | sender     | original author | reply to | text                                                               |
| ---- | ---------- | --------------- | -------- | ------------------------------------------------------------------ |
| 1000 | Bob Stone  |                 |          | `/craft@QuestBot basket`                                           |
| 1001 | QuestBot   |                 | 1000     | `@bob_s, you climb the frozen stream and find a pistachio nougat!` |
| 1002 | QuestBot   |                 |          | `Level up!\nYou can craft another one's worth.`                    |
| 1003 | Carol Vale |                 |          | (sticker, no text)                                                 |
| 1004 | Carol Vale | QuestBot        | 998      | `@carol_v, you have:\n- a stone x2`                                |

## 11. The macOS export

The export written by Telegram Desktop on macOS has the history entries, message blocks, replies,
forwards, media placeholders and text constructs of sections 3-7, with the differences below.
Message ids are the same as in a Windows export of the same chat, and the same messages give the
same texts and senders.

### 11.1 On disk

```
ChatExport_QuestBot/     named after the chat title
  messages.html              page 1
  css/style.css
  js/script.js
  photos/                    avatar.jpg (the chat), author_<user id>.jpg (senders)
```

- The folder is named `ChatExport_<chat title>`.
- The page is `messages.html`, as in the Windows export ([§2](#2-what-is-on-disk)).
- `photos/` holds the chat's picture and one `author_<user id>.jpg` per sender.

### 11.2 Page and messages

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>QuestBot</title>
    ...
  </head>
  <body onload="CheckLocation();">
    <div class="page_wrap">
      <div class="page_header chat_header">
        <div class="content bubble">
          <img class="userpic" style="width: 44px; height: 44px" src="photos/avatar.jpg" />
          <div class="body">
            <div class="name bold">QuestBot</div>
            <div class="subtitle details">bot</div>
          </div>
        </div>
      </div>
      <div class="page_body chat_page">
        <div class="history">
          <div class="message service">
            <div class="body details">27 November 2025</div>
          </div>
          <div class="message default clearfix" id="message1001">
            <div class="pull_left userpic_wrap">
              <img
                class="userpic"
                style="width: 42px; height: 42px"
                src="photos/author_123456789.jpg"
              />
            </div>
            <div class="body">
              <div class="pull_right date details" title="27 November 2025, 19:00:02">19:00</div>
              <div class="from_name">QuestBot</div>
              <div class="text">
                <a href="https://t.me/bob_s">@bob_s</a>, see the bot's
                <a onclick="return ShowBotCommand('inventory')" href="#">/inventory</a>
              </div>
            </div>
          </div>
          ...
        </div>
      </div>
    </div>
  </body>
</html>
```

- The markup is not indented: one element per line, text right after its tag. Values are still
  stripped.
- The **chat title** is `div.name bold` inside `div.page_header`; there is no `div.text bold`. The
  `div.subtitle details` under it reads `bot` in the chat with the bot. `<title>` is the chat title,
  not `Exported Data`.
- Day separators are `div.message service` **without an id**.
- The avatar is an `<img class="userpic">` whose file name carries the sender's user id
  ([§11.4](#114-sender-ids)); joined messages have no avatar, as in [§4.1](#41-joined-messages).
- `div.from_name` has no trailing space after a name without a last name.
- In text, `'` is written as is (not `&apos;`) and `"` as `&quot;`; a command is
  `<a onclick="return ShowBotCommand('cmd')" href="#">/cmd</a>`, sometimes with a `<strong>` inside
  the anchor. The visible text is the same as in the Windows export.

### 11.3 Dates without an offset

`title="27 November 2025, 19:00:02"`: day, English month name, year, a comma, then the 24-hour time.
There is **no UTC offset**. The wall clock is the local time, as in the Windows export: a message
present in both shows the same wall clock in both.

An instant cannot be computed from such a date alone. The merge (`mergeExports`) gives every date of
a macOS export a UTC offset and converts it to the Windows form, so that every message has a date of
one format. The offset comes from:

1. the other exports of the run that share messages with it (same chat title, same id) and show the
   same wall clock for them: their offset (the most frequent, if several), for every date of the
   export, which reproduces the Windows labelling of [§5.1](#51-date); shared messages with another
   wall clock or offset are reported;
2. otherwise the time zone of the computer that made the export (`MergeOptions.timeZone`, an IANA
   zone such as `Europe/Rome`; the command line's `--time-zone`): each date takes the offset the
   zone had at that date, daylight saving time included. A wall clock that happens twice, when the
   clocks go back, is read as the first one. Without a time zone, such an export is an error.

A message present in a Windows and a macOS export is kept once, with the date the Windows export
wrote.

### 11.4 Sender ids

`src="photos/author_123456789.jpg"`: the number is the sender's numeric Telegram user id. Unlike the
display name it is unique and does not change when the user renames themselves, so it identifies
senders far better (two people named `Dana` are told apart).

The readers give it as the message's `sender_id`, `user<id>`, the form the JSON export gives it in
([§13](#13-the-json-export)), so that a replay's mapping names a sender by id
([§14](#14-as-the-account-delivers-it)). (the wiki generator's reader (#60), which publishes what it
reads, keeps only a salted hash of it; the dev kit's output stays on the machine that reads the
export.)

## 12. Unknowns

- Why the Windows export's offset label ignores daylight saving time ([§5.1](#51-date)): Telegram's
  choice, or the exporting computer's time zone setting.
- Whether the macOS differences ([§11](#11-the-macos-export)) come from the operating system or from
  the app version.
- In the macOS export: whether days below 10 are zero-padded in date titles, whether month names
  follow the app language, how forwarded messages, replies, media and pagination look, and what
  avatar a sender without a profile picture gets.
- Whether display names and chat titles are those at export time, or can change between exports of
  the same chat.
- Whether a page can start, or a day separator be followed, by a joined message.
- The exact rule Telegram uses to join messages.
- Why some chats have negative message ids, and whether those ids are stable across exports.
- Whether day-separator month names and fixed strings (`In reply to`, `Previous messages`) depend on
  the app language.
- How `userpicN` is chosen.
- The layout of media folders other than `files/` when media are included.
- Markup of features not covered here (forum topics, channel signatures, stories).

## 13. The JSON export

_Export chat history_ with **Format: Machine-readable JSON** writes one `result.json` (beside
`files/` and the other media folders, as in [§2](#2-what-is-on-disk)); a full account export
(_Settings → Advanced → Export Telegram data_) writes one for every chat. The fields below are those
of Telegram Desktop's JSON writer (its source, `export_output_json.cpp`); the readers read
([`json.ts`](../packages/telegram-export/src/json.ts)) only those marked with a reader field.

```json
{
  "name": "Quest Lobby",
  "type": "private_supergroup",
  "id": 1000000002,
  "messages": [
    {
      "id": 7001,
      "type": "message",
      "date": "2026-11-06T13:31:00",
      "date_unixtime": "1793968260",
      "from": "Alice Liddell",
      "from_id": "user1000000003",
      "reply_to_message_id": 7000,
      "text": [{ "type": "bot_command", "text": "/play@QuestBot" }, " now"],
      "text_entities": [
        { "type": "bot_command", "text": "/play@QuestBot" },
        { "type": "plain", "text": " now" }
      ]
    }
  ]
}
```

| Field                                                                                            | Meaning                                                                                                                                                                                            | Reader field                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` (chat)                                                                                    | The chat's title, as the HTML header shows it; absent for Saved Messages, `null` when empty.                                                                                                       | `chat`                                                                                                                                                      |
| `type` (chat)                                                                                    | `personal_chat`, `bot_chat`, `private_group` (a basic group), `private_supergroup`, `public_supergroup`, `private_channel`, `public_channel`, `saved_messages`, `replies`, `verification_codes`.   | `chat_type`                                                                                                                                                 |
| `id` (chat)                                                                                      | The chat's bare id: a user's or bot's id, a basic group's or a channel's (supergroups are channels) without the network's sign or `-100` prefix.                                                   | `chat_id`, marked: as is for a user or bot, `-<id>` for a basic group, `-100<id>` for a supergroup or channel, as the connector names chats (bot-os.md D90) |
| `id`                                                                                             | The message id, as the HTML's `message<N>`.                                                                                                                                                        | `id`                                                                                                                                                        |
| `type`                                                                                           | `message`, `service` (pins, joins, title changes…, with `actor`, `actor_id`, `action`), or `unsupported` (only `id` and `type`). Only `message` is read, as the HTML reader skips service entries. | (filter)                                                                                                                                                    |
| `date`                                                                                           | The local wall clock, ISO 8601 without an offset (`2026-11-06T13:31:00`).                                                                                                                          | `date`, in the Windows form, with the offset of `date_unixtime`                                                                                             |
| `date_unixtime`                                                                                  | The instant, epoch seconds, as a string. Absent in older exports: the wall clock is then read as a macOS export's ([§11.3](#113-dates-without-an-offset)).                                         | (the offset)                                                                                                                                                |
| `edited`, `edited_unixtime`                                                                      | When the message was last edited.                                                                                                                                                                  | —                                                                                                                                                           |
| `from`                                                                                           | The sender's display name; `null` for one with none (a deleted account).                                                                                                                           | `sender`                                                                                                                                                    |
| `from_id`                                                                                        | The sender: `user<id>`, `channel<id>` (a channel or an anonymous admin), `chat<id>`.                                                                                                               | `sender_id`                                                                                                                                                 |
| `author`                                                                                         | A channel post's signature.                                                                                                                                                                        | —                                                                                                                                                           |
| `forwarded_from`, `forwarded_from_id`                                                            | A forward's original author (name, or `null`), and their id when visible.                                                                                                                          | `forwarded_from`                                                                                                                                            |
| `saved_from`                                                                                     | The chat a message saved to Saved Messages came from.                                                                                                                                              | —                                                                                                                                                           |
| `reply_to_message_id`, `reply_to_peer_id`                                                        | The message replied to; the peer when it is in another chat.                                                                                                                                       | `reply_to`                                                                                                                                                  |
| `via_bot`                                                                                        | The inline bot it was sent through, `@name` (the HTML puts it in the sender's name).                                                                                                               | —                                                                                                                                                           |
| `text`                                                                                           | A string when the text is plain, else an array of strings (plain parts) and entity objects `{ type, text, … }`; `""` without text.                                                                 | `text`: the parts' texts joined, stripped                                                                                                                   |
| `text_entities`                                                                                  | The same parts, every one an object, plain ones `{ "type": "plain", "text": … }`.                                                                                                                  | —                                                                                                                                                           |
| `file`, `file_name`, `file_size`, `mime_type`                                                    | An attached file: its path relative to the export (`files/notes.txt`), or a note in parentheses when it was not exported; the name it was sent with.                                               | `file_name`, `file_text` (a `files/*.txt` the export holds)                                                                                                 |
| `photo`, `media_type`, `sticker_emoji`, `poll`, `location_information`, `contact_information`, … | Other media.                                                                                                                                                                                       | —                                                                                                                                                           |
| `inline_bot_buttons`, `reactions`                                                                | Inline keyboard, reactions.                                                                                                                                                                        | —                                                                                                                                                           |

Entity types: `plain`, `mention`, `mention_name` (with `user_id`), `hashtag`, `cashtag`,
`bot_command`, `link`, `text_link` (with `href`), `email`, `phone`, `bold`, `italic`, `underline`,
`strikethrough`, `code`, `pre` (with `language`), `blockquote` (with `collapsed`), `spoiler`,
`custom_emoji` (with `document_id`), `bank_card`, `unknown`. Every one carries the visible `text`,
so the visible text is their concatenation, as in the HTML ([§5.3](#53-text)): a command addressed
to a bot reads `/play@QuestBot`, as typed.

As the HTML reader: a message without a visible text (a sticker, a photo without caption) is left
out, and a folder holding both `messages*.html` and `result.json` is read from its HTML. A JSON and
an HTML export of the same chat merge into one copy of each message, by (chat title, id), with the
JSON's ids kept.

Checked against the writer's source (Telegram Desktop's `dev` branch, November 2026), not against a
real JSON export: that `name` is the title the HTML header shows; since which version
`date_unixtime` is written (older exports without it are read as macOS ones); and the form of `file`
for a second file of one name (presumably the HTML's `files/file (1).txt`).

## 14. As the account delivers it

A replay feeds a recorded chat to plugins as the owner's own account (`telegram-user`, bot-os-api.md
§4.5) would have delivered it live: `toInbounds(messages, mapping, { playback })`
([`inbound.ts`](../packages/telegram-export/src/inbound.ts)) turns the merged messages into
`Inbound`s of that account, in time order. What an export does not say, a mapping per replay gives:

```json
{
  "account": "telegram:alice",
  "owner": { "username": "alice", "names": ["Alice Liddell"], "ids": ["user1000000003"] },
  "chats": {
    "QuestBot": { "chat": "@QuestBot", "private": true },
    "Quest Lobby": { "chat": "-1001000000002", "private": false }
  },
  "senders": { "QuestBot": "QuestBot", "Bob Stone": "bob" }
}
```

| `Inbound`                       | From                                                                                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`, `network`            | The mapping's `account` (`telegram:owner` by default, `telegram-user`'s), `telegram`.                                                                                                                                             |
| `chat`                          | The mapping's chat, by the export's chat id, else by title: the name the connector's config lists (a group's id, a private chat's `@username`); not given, the chat id (JSON), else the title.                                    |
| `aliases`                       | The mapping's, and the export's chat id when it is not the name.                                                                                                                                                                  |
| `private`                       | The mapping's, else from the JSON chat's kind (a user's or bot's chat); unsaid for an HTML chat not mapped.                                                                                                                       |
| `sender`                        | The username, without `@`: the owner's for the owner's messages, else the mapping's by `sender_id`, else by display name; `''` when not given, as the connector delivers a user without a username. A forward is its forwarder's. |
| `own`                           | The owner's own message: `sender_id` among the owner's `ids`, or the display name among their `names`.                                                                                                                            |
| `text`, `time`, `id`, `replyTo` | The text as written; the date's instant in milliseconds (an undated message takes its neighbour's); the ids as strings.                                                                                                           |
| `playback`                      | As the replay asks: live (`false`) by default.                                                                                                                                                                                    |
| `document`                      | A text file the export holds: `{ name, mime: 'text/plain', size, text }`.                                                                                                                                                         |

`replay` ([`replay.ts`](../packages/telegram-export/src/replay.ts), bot-os.md D131) feeds them to
real plugins on the dev kit, in time order on its virtual clock, its `telegram-user` nodes faked.

Times from an HTML export made on Windows carry its offset label ([§5.1](#51-date)): during daylight
saving time they are an hour off the true instant, all alike, so the gaps between messages hold.
