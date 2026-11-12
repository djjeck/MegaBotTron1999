# MegaBotTron1999

A plugin-based bot shell for chat networks, with a node-graph web UI.

MegaBotTron1999 runs plugins in one process and gives each its own store, durable timers, settings
and mode. It routes messages between connectors (IRC, Telegram as a bot, Telegram as a user) and
parsers on a typed bus, and sends through an outbox that keeps every network's limits. The way the
plugins are wired is a typed graph of ports, which the web UI draws: each plugin instance is a node,
each binding an edge, and the edges are the permissions.

It knows no game. Games, and what plays them, are plugins on top of it.

**Status: v1-alpha.** The core, the connectors, the turn plugins, the reactor, the module loader,
the graph read from the data volume (`/data/graph.json`) with each node's state in an instance apart
from it, and the web UI's graph editor, where the graph is built node by node, work. The plugin API
changes freely until the launch ([docs/bot-os.md](docs/bot-os.md) P13).

> **Plugins run with the shell's full rights.** There is no sandbox. A plugin can read every secret
> the process holds and send as every account it is connected to. Run only plugins you have read.

## Running it

The image is `ghcr.io/djjeck/megabottron1999`, for `linux/amd64` and `linux/arm64`. `edge` follows
`main`; each release `v<version>` is tagged `<version>` and `latest`, and a pre-release
(`v0.1.0-alpha.1`) `<version>` alone.

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
plugins the image and the modules offer, wire its ports, set its config, review the changes and save
them, then apply them with a restart (the page waits for the instance and comes back by itself; the
login lasts 30 days, across restarts). A module (a game, an automation) is a folder holding a
`module.json`: get that folder onto your computer (clone its repository, or download it as a ZIP
from GitHub and unzip it), open the Modules page, click **Choose folder** (or drop the folder on the
page), pick the module's own folder (for example `modules/dice/`, not the whole repository), check
the id and version it shows, install it, then click **Apply (restart)** to load it. The Modules page
also installs a `.tar.gz` and rolls a module back to its previous version; the Import page brings in
an older data directory's event log ([docs/bot-os.md](docs/bot-os.md) D55). In a real deployment,
use Docker or Compose secrets, and put the UI behind a reverse proxy with HTTPS rather than
publishing the port.

- **`/data`** is the instance's state: the graph (`graph.json`, and `graph.previous.json`), each
  plugin instance's state (`instances/<id>/`), the core's own (`core/`), the event log
  (`events-<day>.jsonl`) and the modules installed (`modules/`). Back it up as one, with the
  container stopped.
- **Restart policy:** run it with `--restart unless-stopped` (or Compose's
  `restart: unless-stopped`): the owner applies a saved graph or an installed module by
  `POST /restart`, which stops the instance, its state kept, and exits for Docker to start it again.
- **Secrets** are files under `/run/secrets`, never environment variables: `web_ui_password` (the
  web UI's login; without it there is no UI at all), `bot_os_key` (to encrypt the secrets the core
  stores), and each connector's own (`znc_password`, `telegram_bot_token`, `telegram_user_api_id`,
  `telegram_user_api_hash`, `telegram_user_session`, `anthropic_api_key`).
- **An older data directory** (a deployment of before v1) can be mounted read-only at `/legacy`
  (`LEGACY_DIR`) to import its plugins' stores and its event log through the control API
  ([docs/bot-os-api.md](docs/bot-os-api.md) §8).
- **Ports:** 8082 is the web UI. The control API listens on the container's loopback (8081) only.
- The container runs as the `node` user, from `/app`, with `node src/main.ts`.

To build the image yourself:

```sh
docker buildx bake --load                          # this machine's platform, megabottron1999:local
PLATFORMS=linux/arm64 docker buildx bake --load    # arm64, under emulation elsewhere
```

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
    inputs: { channel: { type: 'chat', network: 'irc' } },
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
  ports, the event types it registers, its configuration, settings and secrets as zod schemas, and
  its interface of reads, actions and chat commands. The web UI, the chat commands and the owner's
  control API are all made from these declarations.
- **The context** gives it a clock, its own store, durable timers, the bus, the event log read back
  (its own namespaces and those it consumes), handles on the connectors its edges bind, an outbox,
  drift reporting, its settings and its mode. A plugin is built from its node's saved config and its
  context alone. It never holds a credential: connectors do.
- **The image offers** the connectors (`irc`, `telegram-bot`, `telegram-user`, `anthropic`) and the
  `turn-actor`, one node per game bot, and the `reactor`, one node per reaction ("when this event is
  heard, or a message matches, send this command", from its config alone, on `react()`, which any
  plugin may call too); everything that knows a game comes from a module.
- **Standard services,** implemented once by the shell (D52): SVG to PNG in every plugin's context
  (`ctx.render.svgToPng`), and asking an LLM through the `anthropic` connector (`ask`, with
  structured output), for the plugins an edge binds to it.
- **Modes:** every plugin that sends has a mode, `read-only`, `dry-run` or `live`, enforced by the
  outbox, starting `read-only` and changed only by the owner.
- **Drift:** a parser reports every message it claims but cannot read; past a threshold, the core
  pauses the actors that depend on it until the owner looks.
- **The dev kit** (`DevKit`, `FakeConnector`, `VirtualClock`) runs plugins on a virtual clock with
  fake connectors, for tests and simulators.

Games and their automation come as _modules_ in the data volume (`/data/modules/<id>/`, a directory
of `.ts` files and a `module.json`), installed by the owner through the control API (the previous
version kept for a rollback) and loaded at start ([docs/bot-os.md](docs/bot-os.md) D49, D53). A
module repository develops and tests against this one vendored as a git submodule
([docs/bot-os-api.md](docs/bot-os-api.md) §7). The full API is
[docs/bot-os-api.md](docs/bot-os-api.md).

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
