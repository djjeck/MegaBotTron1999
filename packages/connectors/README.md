# @megabottron1999/connectors

The networks, each a connector plugin bound to one account, which holds its secrets and gives the
other plugins a handle:

- `irc`: an IRC channel through a ZNC bouncer, with its flood limits, and a health endpoint;
- `telegram-bot`: a Telegram bot (grammY), and the owner's chat surface: notices, buttons, and the
  plugins' commands in the menus;
- `telegram-user`: a Telegram user account (GramJS), reading and sending in the chats it monitors
  (every chat, until its `chats` config ticks some);

Each lists its surfaces, the chats it can see, for the editor to pick from (`surfaces`,
docs/bot-os.md D63): `telegram-user` its dialogs active in the last 7 days from every folder but the
archive (and those its `chats` config lists), monitored or not, latest first, and a search finds any
of them, archived or inactive, whatever its kind or the owner's folder, `telegram-bot` the chats it
has seen (kept in its store) and one looked up by id, `irc` its channel. What was said while the
instance was down comes marked `missed` from `telegram-bot` (Telegram keeps a bot's updates for a
day) and from `telegram-user`, which at each connection fetches back the chats its running readers
read, back to what it has accounted for in each (kept in its store, `last-seen` and `seen-above`),
at most 1000 a chat (D62). Each message reaches the readers once, across live delivery, the catch-up
and restarts, and a gap whose fetch failed is fetched again until it is filled; `telegram-bot` keeps
the last message it delivered in each chat, against Telegram's deliveries again (D66). Each manifest
says which chats its node monitors (`monitors`, D89): the Telegram ones their `chats` (unset: every
chat), `irc` its `channel`; the graph's check warns of a chat-in edge reading a chat its connector
does not monitor. A Telegram chat has an id and may have a `@username` (D90): both connectors give a
message's other names as its `aliases`, so an edge, a reaction or a config naming the chat either
way hears it, and tell the check every name of a chat they have seen (`chatNames`), so that it warns
of neither form of the same chat. The three chat connectors' configs give their account's queue its
default interval between two queued sends of a command in one chat (`commandIntervalS`, 0 by
default, D73), where a chat-out edge names none. A message's file comes as its `document` (D82):
both Telegram connectors download a text file of at most 256 KiB, in UTF-8, and give its text beside
the caption; any other file, its name, type and size only. The catch-up downloads it as live. A
message the Telegram connectors catch up on is `missed`, and played back (`playback`: history, which
nothing acts on) only once older than their config's `liveGraceS` (120 s by default, D83), so that a
quick restart costs nothing.

- `anthropic`: the Claude API (the Anthropic SDK), whose `ask` the plugins bound to it call, with
  structured output by a zod schema.

Their secrets come from Docker secrets, never from variables.
