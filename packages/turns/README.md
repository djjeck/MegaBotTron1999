# @megabottron1999/turns

Two base plugins for a game bot that is played one turn at a time:

- `turnParserPlugin` (`src/turn-parser.ts`): a parser of one bot's answers on a Telegram user
  account, from a grammar the game provides. It knows the owner's turns (sent by hand or by the
  actor), which of the bot's messages answer one, publishes what it reads, reports to drift what it
  cannot read, and says until when the bot rests.
- `turnActorPlugin` (`src/turn-actor.ts`): an actor that sends one bot's turn command in the private
  chat with it, at a person's pace (`src/schedule.ts`: intervals drawn from a range, skipped turns,
  nights off), waiting out the rest its parser reads. One plugin, run as one instance per bot.

The tests play a made-up @QuestBot (`test/quest.ts`).
