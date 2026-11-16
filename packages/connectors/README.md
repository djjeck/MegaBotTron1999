# @megabottron1999/connectors

The networks, each a connector plugin bound to one account, which holds its secrets and gives the
other plugins a handle:

- `irc`: an IRC channel through a ZNC bouncer, with its flood limits, and a health endpoint;
- `telegram-bot`: a Telegram bot (grammY), and the owner's chat surface: the owner's commands, cards
  and buttons in the owner's chat, and the plugins' commands its `commands` output's edges serve
  (docs/bot-os.md D109), each answered and listed in the menus of the chats its edge names alone; it
  reports nothing on its own (docs/bot-os.md D94), and sends the buttons of an `owner-notice`
  message to the owner's chat through the surface, so that a tap runs the owner's command; its
  `deny` list (docs/bot-os.md D100, `telegram-deny.ts`), people and bots picked among its chats but
  never its owner, has their commands in a group and their taps there dropped before any plugin sees
  them, each recorded (`telegram-bot.denied`) and counted in its node's view, silent unless
  `denyReply` sets one line; its `home` (docs/bot-os.md D105), the command of the owner's main card,
  puts a button back to it (`homeLabel`) at the foot of the core's own cards;
- `telegram-user`: a Telegram user account (GramJS), reading and sending in the chats it monitors
  (every chat, until its `chats` config ticks some);

Each lists its surfaces, the chats it can see, for the editor to pick from (`surfaces`,
docs/bot-os.md D63): `telegram-user` its dialogs active in the last 7 days from every folder but the
archive (and those its `chats` config lists), monitored or not, latest first, and a search finds any
of them, archived or inactive, whatever its kind or the owner's folder, `telegram-bot` the chats it
has seen (kept in its store), one looked up by id, and the people it saw in its groups (in memory
only, for its deny list, D100), `irc` its channel. What was said while the instance was down comes
marked `missed` from `telegram-bot` (Telegram keeps a bot's updates for a day) and from
`telegram-user`, which at each connection fetches back the chats its running readers read, back to
what it has accounted for in each (kept in its store, `last-seen` and `seen-above`), at most 1000 a
chat (D62). Each message reaches the readers once, across live delivery, the catch-up and restarts,
and a gap whose fetch failed is fetched again until it is filled; `telegram-bot` keeps the last
message it delivered in each chat, against Telegram's deliveries again (D66). Each manifest says
which chats its node monitors (`monitors`, D89): the Telegram ones their `chats` (unset: every
chat), `irc` its `channel`; the graph's check warns of a chat-in edge reading a chat its connector
does not monitor. A Telegram chat has an id and may have a `@username` (D90): both connectors give a
message's other names as its `aliases`, so an edge, a reaction or a config naming the chat either
way hears it, and tell the check every name of a chat they have seen (`chatNames`), so that it warns
of neither form of the same chat. Since a private chat may so be delivered under its id, both say
whether a message's chat is private (`private`). The three chat connectors' configs give their
account's queue its default interval between two queued sends of a command in one chat
(`commandIntervalS`, 0 by default, D73), where a chat-out edge names none, and its send-queue
watchdog's threshold (`unansweredAt`, 10 by default, 0 for never; `unansweredAtBy` per command,
D93): how many sends of one command, by one actor, to one chat, may go with no event read from that
chat before the actor is stopped. A message's file comes as its `document` (D82): both Telegram
connectors download a text file of at most 256 KiB, in UTF-8, and give its text beside the caption;
any other file, its name, type and size only. The catch-up downloads it as live. A message the
Telegram connectors catch up on is `missed`, and played back (`playback`: history, which nothing
acts on) only once older than their config's `liveGraceS` (120 s by default, D83), so that a quick
restart costs nothing.

- `anthropic`: the Claude API (the Anthropic SDK), whose `ask` the plugins bound to it call, with
  structured output by a zod schema. A model connector (docs/bot-os.md D117): it logs each call
  itself (`anthropic.call`: the calling node, the model, the tokens, the cost in USD from its price
  table, Anthropic's published prices kept in its code so that a release updates them, a model of no
  price logged as unknown), and keeps its last 24 hours by node and model in its store (`spend.ts`,
  which another model connector can reuse), shown on its card, its panel and its page **Spend**.

Their secrets come from Docker secrets, never from variables. The two Telegram connectors also log
in from their node's panel (docs/bot-os.md D116): `bot-login.ts` takes a bot's token (checked with
`getMe`), `user-login.ts` an account's API id and hash, then a QR code or the phone, the code and
the 2FA password; each keeps what it gets in its store (`login`), read before the secrets, which
stay a fallback, and without either runs needing a login (`LoginNeeded`). `tools/telegram-login.ts`,
shipped in the image (docs/bot-os.md D115), creates a `telegram-user` session string:
`docker run -it --rm <image> node packages/connectors/tools/telegram-login.ts` asks for the API id
and hash, the phone number, the code and the 2FA password, and prints it.
