# @megabottron1999/connectors

The networks, each a connector plugin bound to one account, which holds its secrets and gives the
other plugins a handle:

- `irc`: an IRC channel through a ZNC bouncer, with its flood limits, and a health endpoint;
- `telegram-bot`: a Telegram bot (grammY), and the owner's chat surface: notices, buttons, and the
  plugins' commands in the menus;
- `telegram-user`: a Telegram user account (GramJS), reading and sending in the chats it monitors
  (every chat, until its `chats` config ticks some);

Each lists its surfaces, the chats it can see, for the editor to pick from (`surfaces`,
docs/bot-os.md D63): `telegram-user` its dialogs, `telegram-bot` the chats it has seen (kept in its
store) and one looked up by id, `irc` its channel. What was said while the instance was down comes
marked `missed` from `telegram-bot` (Telegram keeps a bot's updates for a day); `telegram-user` has
no catch-up yet (D62).

- `anthropic`: the Claude API (the Anthropic SDK), whose `ask` the plugins bound to it call, with
  structured output by a zod schema.

Their secrets come from Docker secrets, never from variables.
