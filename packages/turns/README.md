# @megabottron1999/turns

The base plugins for automation: two for a game bot that is played one turn at a time, one reaction,
a game's player state, and the script node.

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
- `statePlugin` (`src/state-plugin.ts`): a game's player state (an inventory, a profile), from a
  spec the game gives: the state's zod schema, its initial value, the event types it applies (a
  required events input per namespace, so that its parser stopped takes it down), a pure reducer,
  the freshness each event gives its sections, and named queries (docs/bot-os.md D72). The shell
  keeps it in its store with a cursor into the event log, so that each event is applied once across
  restarts, announces each change (`<id>.changed`) and, in the spec's own events (`events`,
  `announce`: an item gained), what each live event did, never what the catch-up or a played-back
  event did (D83), offers `get`, `freshness` and the queries, and its view, which the web UI draws
  from the schema alone. It never sends.

- `scriptPlugin` (`src/script-plugin.ts`): the `script` node, TypeScript the owner types in the web
  UI (docs/bot-os.md D76), on the ports its config declares (events and interface inputs, chat-out
  outputs with their commands, events of its own), its node's manifest made from them (D74); its
  inputs are under `inputs` (`configInputs`), where the editor adds one for an edge dropped on the
  node (D80). Its code, its types stripped, runs in a `vm` context holding the script API alone
  (`src/script-runtime.ts`: `on`, `use`, `outbox`/`enqueue`, `publish`, `store`, `clock`, `log`, as
  the plugin context has them), in a worker thread of its own (`src/script-worker.ts`) with a time
  limit on each handler's run and a memory limit; a script that hangs (its thread spending its limit
  on the CPU without answering the main thread's ping; one stalled with its host is waited for,
  D81), runs out of memory or crashes is killed and its node failed.
  `scriptPlugin({ isolation: 'in-process' })` runs it in the main thread instead, for the dev kit's
  deterministic runs on its virtual clock.

Their chats run left to right (docs/bot-os.md D60): a parser has a chat-in input only, the reactor a
chat-out output (and a chat-in only with `match`), and the turn-actor both, for now. Whether a send
goes for real is its chat-out edge's: a `dryRun` edge logs it as sent and sends nothing (D64).

The tests play a made-up @QuestBot (`test/quest.ts`), and a made-up game's inventory.
