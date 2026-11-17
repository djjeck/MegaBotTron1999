# @megabottron1999/turns

The base plugins for automation: three for a game bot played by a simulated person (its parser, the
person, the player), one reaction, a game's player state, the script node, and the node that tells
the owner what needs attention.

- `turnParserPlugin` (`src/turn-parser.ts`): a parser of one bot's answers on a Telegram user
  account (a chat-in input: it reads, never sends), from a grammar the game provides with its bot's
  turn commands (`turnCommands`: a fact of the game, not a config, docs/bot-os.md D70). It knows the
  owner's turns (sent by hand or by the player), which of the bot's messages answer one, publishes
  what it reads, reports to drift what it cannot read, says until when the bot rests and the owner's
  last turn, in private or in the group (`state.lastTurn`, docs/bot-os.md D99, D129), and declares
  its turn event an answer to its turn commands (D98). Its spec may also declare the bot's other
  commands with their mechanics as data (`commands`: a cooldown, an unlock the bot announces, an
  effect on another command's hold, such as a reset of the turn's rest; D132): it tracks each
  command's readiness and offers it (`state.ready`: ready since, or held until and why, with its
  last send and answer), publishes their answers as `<id>.answer`, and declares each an answer to
  its own command, a reset ending the outbox's cooldown too. A command marked `interactive: true`
  needs the person to answer or choose (a minigame, a shop; D137): tracked as any other, left out of
  a player's defaults. It publishes its commands, the turns first, with their mechanics, in its
  manifest (`botCommands`, for the editor's checklist) and its read `state.commands` (for a player's
  defaults at run time), from its spec alone (D137), and its bot's name (`botUsername`,
  `state.bot`). A send a player tells it of (`actions.sent`: its own player's, or another's of the
  same person, D139) counts only if it reaches its bot: bare or addressed to it, in its bot's
  private chat or a chat its edge reads; its answers hold both forms back. It resumes from what it
  parsed, kept in its store, never by re-reading the chat (docs/bot-os.md D62).
- `attentionPlugin` (`src/attention.ts`): `attention`, a simulated person, one node per person
  (docs/bot-os.md D134): when they sit down to play (`src/sittings.ts`: a gap drawn from a range,
  forgotten sittings, nights off in a time zone) and how fast they act within a sitting (a reaction
  scaled to the answer read). It starts sittings for the players its `attention` output binds (a
  port type of its own, D133), which share them, so that a person's bots are played in bursts; the
  owner's own play by hand, as the players' parsers read it, counts as a sitting and puts the next
  simulated one back. Two behaviours, each on its own (D138): `scheduled` (on by default), the
  sittings it plans from its schedule, hidden in the editor while off; and `followsMyPlay` (off by
  default), a sitting `followDelayS` (3 s) after any message of the owner's own in the chats it
  `listen`s to, through its `listen` chat-in from the owner's own account (network `telegram`: the
  check refuses a bot's; none during a sitting: its players look again instead), counted as the
  owner's own sitting. Both off, the check warns that it never plays. Its players hear each other's
  sends through it (`sent`, `heard`, D139), each telling its own parser, so that a bare command one
  sent in a group is every bot's turn there. Its card shows its next sitting (`follows your play`
  when not scheduled), its page (**Sittings**) its behaviours, its last and next.
- `playerPlugin` (`src/player.ts`): the `player`, one node per bot, in place of the turn actor
  (D134): given a sitting, it plays each of its commands that its parser says is ready
  (`state.ready`, D132) and its policy allows: its config's `commands` (each
  `{ command, whileHeld?, whenReady?, addressed? }`), or, unset, every command its parser declares
  (`state.commands`) but an interactive one, in its parser's order (D137). The policy comes from the
  mechanics (a turn, whenever ready; a reset, only while what it clears is cooling down; any other,
  whenever ready), an entry's `whileHeld` or `whenReady` overriding it (`playsOf`). The editor draws
  its `commands` as a checklist of its parser's (`configPlays`) and keeps its chat edge allowing
  them. Each goes after its person's reaction time, looking again after each answer (so an unlock
  announced, or a reset, is taken in the same sitting), until nothing is left. In a sitting that
  follows the owner's play (D138), or in which another player of its person sent a command (D139),
  it first waits for the answer to the last send its parser has not read an answer to yet, then
  plays its whole checklist. No schedule of its own: the outbox's `held` (D98) stays as the safety
  net. It only sends (docs/bot-os.md D99); its one chat is its edge's alone (D97): its bot's private
  chat or, as the owner prefers, a group its bot is in (D139), where each command goes bare
  (`/play`, which every bot there that sees it takes) or addressed to its bot (`/play@QuestBot`,
  `addressed: true`). Each command it sends live it tells its parser and its person, which tells its
  other players. Through a dry-run chat-out edge it logs each command and sends nothing; through a
  live one it waits for the account to be connected. Its card shows its next play, its page
  (**Plays**) its chat, commands, last and next play (D112). Its safety stop (the kill switch) stops
  its node (`ctx.stop`, docs/bot-os.md D64), until the owner clears the stop in the editor.
- `reactorPlugin` (`src/reactor.ts`): the `reactor`, one reaction (`react()` of the core) from its
  node's config: when an event of its `on` type is heard (on its events input, there only with `on`
  and then required: the check refuses a reactor on events that no edge binds), or a message on its
  chat-in input (there only with `match`) matches its `match`, and the payload's fields equal its
  `when`, it sends its `send` template to its `chat`, through its chat-out output's outbox; a fixed
  `chat` picked in the editor is written on its edge too (D97); `in`, the chats a message is read
  in, is a list (one chat as a string, as 0.1.20 saved it, is refused: D110). Its `status` read
  gives its last reaction and its reactions by outcome, kept in its store across restarts and shown
  in its node panel and card. One plugin, run as one instance per reaction.
- `statePlugin` (`src/state-plugin.ts`): a game's player state (an inventory, a profile), from a
  spec the game gives: the state's zod schema, its initial value, the event types it applies (a
  required events input per namespace, so that its parser stopped takes it down), a pure reducer,
  the freshness each event gives its sections, and named queries (docs/bot-os.md D72). The shell
  keeps it in its store with a cursor into the event log, so that each event is applied once across
  restarts, announces each change (`<id>.changed`) and, in the spec's own events (`events`,
  `announce`: an item gained), what each live event did, never what the catch-up or a played-back
  event did (D83), offers `get`, `freshness` and the queries, and its view, which the web UI draws
  from the schema alone. It never sends.

- `ownerNoticePlugin` (`src/owner-notice.ts`): `owner-notice`, the one node that reports to a chat
  (docs/bot-os.md D94: the core tells none itself), which tells the owner what needs attention
  (docs/bot-os.md D91, #40): the notices the core and the plugins raise (refused events, coalesced
  sends, drift, cascades, failures, nodes the send-queue watchdog stopped (`stalled`, D93), the
  graph's warnings, and plugins' own kinds), each kind on or off, grouped and paced per kind
  (`pace`: a burst gathered for `gatherS`, at most one message every `everyMin`), in plain text
  naming nodes by id, to every chat its chat-out edges name (docs/bot-os.md D97: one edge per
  connector, a `telegram-bot` and `irc` at once; an edge naming none, its connector's owner's
  private chat), queued as any send, so a dry-run edge sends nothing. The plugins' messages
  (`ctx.notify`, a `told` notice) go at once, one each, with their buttons where the chat can run
  them (a `telegram-bot`'s owner's chat), text alone elsewhere. It also sends a summary every
  `summaryEveryMin` (60) minutes, none when nothing happened, from the lines the core and the
  plugins contribute (docs/bot-os.md D92, #46), and a notice at each start (`startNotice`). The
  state plugins, the turn parsers, `attention` and the `player` contribute their lines (events
  applied and refused, answers read, turns). Its view, in its node's panel, shows what waits to be
  told and when, its last tells, the start notice's and the summary's times, and the last message
  each chat refused (`notSent`, D95).
- `scriptPlugin` (`src/script-plugin.ts`): the `script` node, TypeScript the owner types in the web
  UI (docs/bot-os.md D76), on the ports its config declares (events and interface inputs, chat-out
  outputs with their commands, events of its own; several of a kind, each its own name, D84), its
  node's manifest made from them (D74); its inputs are under `inputs` (`configInputs`), where the
  editor adds one for an edge dropped on the node (D80). Its code, its types stripped, runs in a
  `vm` context holding the script API alone (`src/script-runtime.ts`: `on`, `use`,
  `outbox`/`enqueue`, with the game's answer (D98), `held`, `publish`, `store`, `clock`, `log`, as
  the plugin context has them, and the timers `at` and `every`, armed on the node's clock in the
  main thread and dropped when it stops, D106), in a worker thread of its own
  (`src/script-worker.ts`) with a CPU limit and a memory limit; a script that hangs (its thread
  spending its limit on the CPU without answering the main thread's ping, in a handler's run or
  after an await; one stalled with its host is waited for, even mid-run, D81, D85; pinged only while
  the script is busy, D87), runs out of memory or crashes is killed and its node failed.
  `scriptPlugin({ isolation: 'in-process' })` runs it in the main thread instead, for the dev kit's
  deterministic runs on its virtual clock: there, with no worker to kill, each synchronous run is
  cut by vm's limit in real time.

Their chats run left to right (docs/bot-os.md D60): a parser has a chat-in input only, the reactor a
chat-out output (and a chat-in only with `match`), and the player a chat-out output only (D99).
Whether a send goes for real is its chat-out edge's: a `dryRun` edge logs it as sent and sends
nothing (D64).

The tests play a made-up @QuestBot (`test/quest.ts`), a clone of it that answers on the dev kit's
clock (`test/quest-clone.ts`: a turn, a daily command, a chest a turn's answer announces, a coffee
that resets the turn's rest), a person and a player on it (`test/sittings-run.ts`), and a made-up
game's inventory.
