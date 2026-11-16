# @megabottron1999/core

The shell's core. A plugin is a manifest (its kinds, its ports, its configuration, settings and
secrets, its interface of reads, actions and chat commands, its state's migrations) and a `create`
that gets a context: its clock, store, scheduler, bus, connectors through their handles, outbox,
drift, settings, owner, log and the render service (SVG to PNG, on resvg: `src/render.ts`). The core
loads the plugins of a graph, starts them in order (none disabled, stopped or inactive:
docs/bot-os.md D64), sends each chat-out edge's sends for real or as dry runs, serves each chat
surface the plugins' commands its commands edges serve, where and to whom they say, their answers
recorded and held by the edge's dry run (`src/commands.ts`, `core.served`, D109), stops one whose
parser drifts (and, at once, what requires it, D65), keeps each stop in its instance, and keeps
everything across a restart. The owner's controls (`src/controls.ts`) and their HTTP API
(`src/control-server.ts`) offer each plugin's state, settings, reads and actions, the instance's off
and kill switches, a single node's kill, its stop cleared, and what the web UI's graph editor draws
and forms each plugin and node with (`src/graph-view.ts`: its ports, its interface, its secrets and
event types, and its config's and settings' JSON Schemas), with the names of the secrets provided,
never their values.

- `src/index.ts` is the public API (`@megabottron1999/core`); plugins import nothing else.
- `src/devkit.ts`: a core on a virtual clock with fake connectors, for tests and simulators.
- `src/modules.ts`, `src/module-loader.ts`, `src/module-resolve.ts`, `src/module-hooks.ts`,
  `src/module-store.ts`, `src/module-files.ts`, `src/module-git.ts`, `src/module-github.ts`,
  `src/module-gitea.ts`, `src/module-hosts.ts`: the modules of the data volume, their resolve hook,
  their loading, the modules a folder or a repository holds and the files each installs, repository
  links (GitHub's, and a self-hosted Gitea-compatible server's, from the hosts allowed) and their
  updates, install and rollback (docs/bot-os-api.md §7).
- `tools/modules.ts`: loads module directories as the instance does, for a module repository.
- `src/react.ts`: `react()`, a reaction: when an event is heard or a message matches, send a command
  through the outbox (docs/bot-os-api.md §4.15).
- `src/outbox.ts`: an account's outbox: the reach, dry runs and the pace of every send, and its
  queue (docs/bot-os.md D73): one per (connector, chat), the same text of different nodes coalesced,
  each command spaced by its interval, each live send waiting while its account connects (D108),
  each send dropped when its cancel holds, its node stops or the instance does, and the merges
  counted since the start, by pair of nodes; and its watchdog (docs/bot-os.md D93), which stops an
  actor whose sends of a command go unanswered too many times in a row.
- `src/answers.ts`: command answers (docs/bot-os.md D98): the parsers' declared answers (a
  manifest's `answers`), the sends waiting for theirs (`await enqueue(…)` settles with `answer`),
  the cooldowns their `retryAt` sets per chat and command, and the retry-loop guard, which backs off
  a node refused again and again for one reason (`GET /status`'s `backoff`, a `backoff` notice), and
  the `unanswered` notice of a command no answer came for (D107).
- `src/paths.ts`: dotted paths into a payload (`valueAt`, `matches`, `holds`), as reactions, cancels
  and answers read them.
- `src/notices.ts`: the owner's notices (docs/bot-os.md D91, D94): what needs the owner's attention,
  raised where it happens (a node failed or made inactive by a stop's cascade, a drift, a send
  coalesced, a node the send-queue watchdog stopped, the load's warnings, the saved graph refused, a
  plugin's own through `ctx.notice`, and a plugin's message through `ctx.notify`, `told`, with its
  buttons), recorded in the event log (`core.notice`, for the editor's events panel), and heard by a
  node whose manifest declares `notices: true` (`ctx.notices`), those since the start first. The
  core sends no chat anything itself: `owner-notice` is the one node that reports.
- `src/summary.ts`: the owner's summary (docs/bot-os.md D92): the lines each plugin whose manifest
  declares `summary: true` contributes for a window (`ctx.summary.contribute`), after the core's own
  (each node's sends by outcome, the notices by kind), collected by a node that tells them; the
  instance as it runs, for a start notice; and `Tally`, counts by key and time for a window.
- `src/state-view.ts`: a node's state as the owner sees it (its schema, freshness and pins,
  docs/bot-os.md D72), for the state plugins and the web UI's viewer; `src/event-log.ts` keeps a
  cursor into the log (a length read per day file) for a reader that resumes where it left it.
- `src/rng.ts`: a seeded generator, so that a simulated run repeats exactly.
- `src/graph.ts`, `src/ports.ts`: the graph, its port types (`chat-in`, `chat-out`, `events`,
  `interface`) and its check, with its problems, which refuse it, and its warnings, which do not (a
  chat-in edge reading a chat its connector's `monitors` leaves out, docs/bot-os.md D89, a chat
  matched by any of its names as the running connector tells them, D90); a graph file of version 1
  is converted to version 2 as it loads (`upgradeGraph`, docs/bot-os.md D60), and a chat a node's
  config held that its plugin moved onto its edges (`movedChats`) moves there (`moveChats`, D97),
  and an edge to an input its plugin no longer has (`droppedInputs`) is dropped (`dropInputs`, D99);
  a chat-out output may take several edges (`many`, `ctx.outboxes`), send to its connector's owner
  through an edge naming none (`owner`), or need its edge to name one chat that a chat-in input
  reads alone (`single`, `sameAs`).
- `src/graph-file.ts`, `src/graph-history.ts`: the graph file of the data volume, its check, diff
  and rollback for the control API, and its history: every graph written kept as a version for 7
  days (never fewer than the 5 latest), with what changed and whether the instance started on it
  (docs/bot-os-api.md §2.3, docs/bot-os.md D61).
- `src/graph-view.ts`: the graph printed (`graphText`, a value per line, and `lineDiff`, two
  printouts' line diff) and drawn (`graphMermaid`).
- `tools/graph.ts`: prints a graph file as text or as a Mermaid flowchart.

The full description of the API is [docs/bot-os-api.md](../../docs/bot-os-api.md).
