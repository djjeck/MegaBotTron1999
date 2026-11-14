# MegaBotTron1999

A plugin-based bot shell for chat networks, with a node-graph web UI.

MegaBotTron1999 runs plugins in one process and gives each its own store, durable timers, settings
and state. It routes messages between connectors (IRC, Telegram as a bot, Telegram as a user) and
parsers on a typed bus, and sends through an outbox that keeps every network's limits. The way the
plugins are wired is a typed graph of ports, which the web UI draws: each plugin instance is a node,
each binding an edge, and the edges are the permissions. Data flows left to right: a connector's
chats are read on the left of the graph (chat-in edges, to the parsers) and written to on its right
(chat-out edges, from the plugins that send), so a connector is drawn as two cards, in and out
([docs/bot-os.md](docs/bot-os.md) D60). A chat-in edge reads some chats, or any its connector
monitors, from some senders, or anyone (D62); the chats are picked from the lists the connectors
give (D63). A node is enabled, disabled by the owner, stopped by exception (a safety stop, drift,
the owner's kill), or inactive while a node it needs is down; a chat-out edge sends for real or as a
dry run, logged as sent (D64).

It knows no game. Games, and what plays them, are plugins on top of it.

**Status: 0.1.x, before the launch.** The core, the connectors, the turn plugins, the reactor,
script nodes, the owner's notices, the module loader, the graph read from the data volume
(`/data/graph.json`) with each node's state in an instance apart from it, and the web UI's graph
editor, where the graph is built node by node, work. The plugin API changes freely until the launch
([docs/bot-os.md](docs/bot-os.md) P13).

> **Plugins run with the shell's full rights.** There is no sandbox. A plugin can read every secret
> the process holds and send as every account it is connected to. Run only plugins you have read.

> **The web UI's login is meant for a trusted network.** Behind it, the owner installs modules and
> edits script nodes: they run code with the bot's accounts. Anyone who exposes the UI to the
> internet should put an extra layer of authentication in front of it, such as a reverse proxy with
> two-factor authentication.

## Running it

The image is `ghcr.io/djjeck/megabottron1999`, for `linux/amd64` and `linux/arm64`. `edge` follows
`main`; each release `v<version>` (`v0.1.0`, then a patch at a time: `v0.1.1`, `v0.1.2`, …) is
tagged `<version>` and `latest`. The pre-releases before `v0.1.0` (`v0.1.0-alpha.1` to
`v0.1.0-alpha.17`) are tagged `<version>` alone.

```sh
mkdir -p secrets
printf '%s' 'a password of 12 characters or more' > secrets/web_ui_password
docker run -d --name megabottron1999 \
  -v megabottron1999-data:/data \
  -v "$PWD/secrets:/run/secrets:ro" \
  -p 127.0.0.1:8082:8082 \
  --restart unless-stopped \
  ghcr.io/djjeck/megabottron1999:edge
```

Then open `http://127.0.0.1:8082/` and log in with that password. The home page is the graph editor:
a new instance starts empty, and offers to add its first node, a connector. Add each node from the
plugins the image and the modules offer, wire its ports, set its config, then review the changes and
click **Apply**, which saves them and restarts the instance (the page waits for it and comes back by
itself; the login lasts 30 days, across restarts), or **Revert** to drop them. A module (a game, an
automation) is a folder holding a `module.json`. On the Modules page, paste a public repository's
GitHub link (`https://github.com/<owner>/<repo>`, or a folder's `…/tree/<ref>/<path>`), or click
**Choose folder** (or drop a folder on the page) and pick a clone or an unzipped download: a
module's own folder, or a repository's root that holds several. The page lists every module found
(but those under `vendor/`), each with its version and whether it is new, an update, the same
version or older; check those to install, install them, then click **Apply (restart)** to load them.
A module's tests are left out. One installed from GitHub shows its commit, and the page says when
its branch has a newer one (checked every 6 hours, or with **Check for updates**); **Update**
installs it. Nothing is installed or restarted but by you. The Modules page also installs a
`.tar.gz` and rolls a module back to its previous version; the Admin page shows the instance (with
its off and kill switches), the graph's history (each version applied in the last 7 days, what
changed, whether the instance started on it, and a rollback to it) and the graph as text, its
accounts and their connections, and its plugins with their states (D59, D61, D64). A **script** node
runs TypeScript typed in its panel, on the ports its panel declares, each in a worker thread of its
own ([docs/bot-os.md](docs/bot-os.md) D76). In a real deployment, use Docker or Compose secrets, and
put the UI behind a reverse proxy with HTTPS, and on the internet with its own authentication,
rather than publishing the port.

- **`/data`** is the instance's state: the graph (`graph.json`, and its versions in
  `graph-history/`), each plugin instance's state (`instances/<id>/`), the core's own (`core/`), the
  event log (`events-<day>.jsonl`) and the modules installed (`modules/`). Back it up as one, with
  the container stopped.
- **Restart policy:** run it with `--restart unless-stopped` (or Compose's
  `restart: unless-stopped`): the owner applies a saved graph or an installed module by
  `POST /restart`, which stops the instance, its state kept, and exits for Docker to start it again.
- **Secrets** are files under `/run/secrets`, never environment variables: `web_ui_password` (the
  web UI's login; without it there is no UI at all), `bot_os_key` (to encrypt the secrets the core
  stores), and each connector's own (`znc_password`, `telegram_bot_token`, `telegram_user_api_id`,
  `telegram_user_api_hash`, `telegram_user_session`, `anthropic_api_key`). Optional, `github_token`
  (a GitHub token, to raise the API's limit of 60 requests an hour for installing and updating
  modules from GitHub links; `GITHUB_TOKEN` in the environment is read too, though the secret is the
  safer place).
- **Ports:** 8082 is the web UI. 8080 is the health endpoint (`HEALTH_PORT`): `GET /health` answers
  200 while every enabled connector is connected, 503 otherwise, and the image's `HEALTHCHECK`
  probes it; set `HEALTH_PORT` empty to turn it off, and disable the healthcheck with it. The
  control API listens on the container's loopback (8081) only.
- The container runs as the `node` user, from `/app`, with `node src/main.ts`.

To build the image yourself:

```sh
docker buildx bake --load                          # this machine's platform, megabottron1999:local
PLATFORMS=linux/arm64 docker buildx bake --load    # arm64, under emulation elsewhere
```

`BUILD_COMMIT=$(git rev-parse HEAD)` before either names the commit that `GET /instance` and the web
UI's bottom bar show beside the release (the published images carry theirs).

## How plugins work

A plugin is a TypeScript module that exports a manifest and a `create` function:

```ts
import { definePlugin } from '@megabottron1999/core';
import { z } from 'zod';

export const greeter = definePlugin({
  manifest: {
    id: 'greeter',
    version: '0.1.0',
    kinds: ['actor'],
    description: 'Says hello in a channel',
    // It reads the channel (chat-in) and sends to it (chat-out): two ports, one name.
    inputs: { channel: { type: 'chat-in', network: 'irc' } },
    outputs: { channel: { type: 'chat-out', network: 'irc' } },
    settings: z.object({ greeting: z.string().default('hello').describe('What it says') }),
  },
  create: (ctx) => ({
    start() {
      ctx.connector('channel').onMessage((m) => {
        const greeting = ctx.settings.kept().greeting ?? 'hello';
        if (m.text === '!hi') void ctx.outbox('channel').enqueue(m.chat, greeting);
      });
    },
  }),
});
```

- **The manifest** declares its kinds (connector, parser, actor, stats, agent, simulator), its input
  ports and the chats it sends through (its `chat-out` outputs), the event types it registers (each
  schema's `.describe()` saying what it is), its configuration, settings and secrets as zod schemas,
  and its interface of reads, actions and chat commands. The web UI, the chat commands and the
  owner's control API are all made from these declarations.
- **The context** gives it a clock, its own store, durable timers, the bus, the event log read back
  (its own namespaces and those it consumes), handles on the connectors its edges bind, an outbox,
  drift reporting, its settings, a way to raise a notice for the owner (`ctx.notice`), and its own
  safety stop (`ctx.stop`). A plugin is built from its node's saved config and its context alone. It
  never holds a credential: connectors do.
- **The image offers** the connectors (`irc`, `telegram-bot`, `telegram-user`, `anthropic`) and the
  `turn-actor`, one node per game bot, and the `reactor`, one node per reaction ("when this event is
  heard, or a message matches, send this command", from its config alone, on `react()`, which any
  plugin may call too), the `script` node, and `owner-notice`, which tells the owner what needs
  attention (refused events, coalesced sends, drift, cascades, failures, the graph's warnings),
  grouped and paced per kind, through a `telegram-bot` to the owner's private chat or through IRC;
  everything that knows a game comes from a module.
- **Standard services,** implemented once by the shell (D52): SVG to PNG in every plugin's context
  (`ctx.render.svgToPng`), and asking an LLM through the `anthropic` connector (`ask`, with
  structured output), for the plugins an edge binds to it.
- **States and dry runs** (D64): a node is **enabled**, **disabled** by the owner (in the graph:
  never started, still checked), **stopped** by exception (a safety stop, drift, the owner's kill or
  Telegram's stop; kept in its instance across restarts until the owner clears it), or **inactive**
  while a node its required ports bind is down, at once when that node is stopped at runtime (D65).
  A chat-out edge that is a **dry run** logs what it would send, as sent, and sends nothing. New
  nodes start disabled and new chat-out edges dry runs; every state is raised only in the editor,
  applied with a restart. The modes of before (`read-only`, `dry-run`, `live`) were migrated into
  them at the first start.
- **Drift:** a parser reports every message it claims but cannot read; past a threshold, the core
  stops the actors that depend on it, and what requires them goes inactive, until the owner looks.
- **The owner's notices** (D91): what needs the owner's attention is raised where it happens, and an
  `owner-notice` node tells it. Wire it from the editor: add the node, set its `chat` to where the
  owner reads (their private chat with the bot, by their Telegram user id), draw its `chat` edge to
  the `telegram-bot` node with that chat among the edge's sends, and make the edge live once the dry
  run's log (`core.send`, `dry-run`) reads right.
- **The dev kit** (`DevKit`, `FakeConnector`, `VirtualClock`) runs plugins on a virtual clock with
  fake connectors, for tests and simulators.

Games and their automation come as _modules_ in the data volume (`/data/modules/<id>/`, a directory
of `.ts` files and a `module.json`), installed by the owner through the control API (from a folder,
a tarball or a GitHub link, the previous version kept for a rollback), removed the same way, and
loaded at start ([docs/bot-os.md](docs/bot-os.md) D49, D53, D67, D68). A module repository develops
and tests against this one vendored as a git submodule ([docs/bot-os-api.md](docs/bot-os-api.md)
§7). The full API is [docs/bot-os-api.md](docs/bot-os-api.md).

## Layout

| Path                  | What it holds                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`       | `@megabottron1999/core`: manifests, the lifecycle, the bus, the store, the scheduler, the outbox, drift, settings, secrets, the graph of ports, the owner's controls, the dev kit |
| `packages/connectors` | `@megabottron1999/connectors`: IRC through a ZNC bouncer; Telegram as a bot (the owner's chat surface) and as a user                                                              |
| `packages/turns`      | `@megabottron1999/turns`: base plugins for a game bot played one turn at a time: a parser of its answers, an actor at a person's pace                                             |
| `packages/web`        | `@megabottron1999/web`: the web UI (React, React Flow, built by Vite) and its server behind a login                                                                               |
| `src/main.ts`         | The image's entry point                                                                                                                                                           |
| `docs/`               | The design: [principles and decisions](docs/bot-os.md), and [the plugin API](docs/bot-os-api.md)                                                                                  |

Each package has its own README.

## Development

TypeScript on Node 24 (`.nvmrc`), run from the sources by type stripping (only erasable syntax),
with strict types, Vitest (at least 90% coverage per package), ESLint and Prettier. The one build is
the web UI's, by Vite.

```sh
nvm use
npm ci
npm run validate   # tests with coverage, types, lint (with fixes), formatting, the web UI's build
```

CI runs `npm run ci` (the same checks, fixing nothing) on every push and pull request to `main`
(`.github/workflows/ci.yml`), and publishes the image to ghcr.io (`.github/workflows/publish.yml`):
`edge` on every push to `main`, and `<version>` and `latest` on every pushed tag `v<version>`. The
rules for contributing are in [CLAUDE.md](CLAUDE.md).

## Licence

MIT ([LICENSE](LICENSE)).
