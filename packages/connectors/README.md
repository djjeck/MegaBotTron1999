# @megabottron1999/connectors

The networks, each a connector plugin bound to one account, which holds its secrets and gives the
other plugins a handle:

- `irc`: an IRC channel through a ZNC bouncer, with its flood limits, and a health endpoint;
- `telegram-bot`: a Telegram bot (grammY), and the owner's chat surface: notices, buttons, and the
  plugins' commands in the menus;
- `telegram-user`: a Telegram user account (GramJS), reading and sending in chosen chats;
- `anthropic`: the Claude API (the Anthropic SDK), whose `ask` the plugins bound to it call, with
  structured output by a zod schema.

Their secrets come from Docker secrets, never from variables.
