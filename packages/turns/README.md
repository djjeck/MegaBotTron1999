# @megabottron1999/turns

The base plugins for automation: two for a game bot that is played one turn at a time, and one
reaction.

- `turnParserPlugin` (`src/turn-parser.ts`): a parser of one bot's answers on a Telegram user
  account (a chat-in input: it reads, never sends), from a grammar the game provides with its bot's
  turn commands (`turnCommands`: a fact of the game, not a config, docs/bot-os.md D70). It knows the
  owner's turns (sent by hand or by the actor), which of the bot's messages answer one, publishes
  what it reads, reports to drift what it cannot read, and says until when the bot rests. It resumes
  from what it parsed, kept in its store, never by re-reading the chat (docs/bot-os.md D62).
- `turnActorPlugin` (`src/turn-actor.ts`): an actor that sends one bot's turn command in the private
  chat with it, at a person's pace (`src/schedule.ts`: intervals drawn from a range, skipped turns,
  nights off), waiting out the rest its parser reads. One plugin, run as one instance per bot.
  Through a dry-run chat-out edge it logs each turn and sends nothing; through a live one it waits
  for the account to be connected. Its safety stop (the kill switch) stops its node (`ctx.stop`,
  docs/bot-os.md D64), until the owner clears the stop in the editor.
- `reactorPlugin` (`src/reactor.ts`): the `reactor`, one reaction (`react()` of the core) from its
  node's config: when an event of its `on` type is heard, or a message on its chat-in input (there
  only with `match`) matches its `match`, and the payload's fields equal its `when`, it sends its
  `send` template to its `chat`, through its chat-out output's outbox. One plugin, run as one
  instance per reaction.

Their chats run left to right (docs/bot-os.md D60): a parser has a chat-in input only, the reactor a
chat-out output (and a chat-in only with `match`), and the turn-actor both, for now. Whether a send
goes for real is its chat-out edge's: a `dryRun` edge logs it as sent and sends nothing (D64).

The tests play a made-up @QuestBot (`test/quest.ts`).
