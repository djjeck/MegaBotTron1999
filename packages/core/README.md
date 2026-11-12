# @megabottron1999/core

The shell's core. A plugin is a manifest (its kinds, its ports, its configuration, settings and
secrets, its interface of reads, actions and chat commands, its state's migrations) and a `create`
that gets a context: its clock, store, scheduler, bus, connectors through their handles, outbox,
drift, settings, owner, log and the render service (SVG to PNG, on resvg: `src/render.ts`). The core
loads the plugins of a graph, starts them in order, enforces each acting plugin's mode (`read-only`,
`dry-run`, `live`) on its sends, pauses one whose parser drifts, and keeps everything across a
restart. The owner's controls (`src/controls.ts`) and their HTTP API (`src/control-server.ts`) offer
each plugin's state, mode, settings, reads and actions, the instance's off and kill switches, a
single node's kill, and what the web UI's graph editor draws and forms each plugin and node with
(`src/graph-view.ts`: its ports, its interface, its secrets and event types, and its config's and
settings' JSON Schemas), with the names of the secrets provided, never their values.

- `src/index.ts` is the public API (`@megabottron1999/core`); plugins import nothing else.
- `src/devkit.ts`: a core on a virtual clock with fake connectors, for tests and simulators.
- `src/modules.ts`, `src/module-loader.ts`, `src/module-resolve.ts`, `src/module-hooks.ts`,
  `src/module-store.ts`: the modules of the data volume, their resolve hook, their loading, install
  and rollback (docs/bot-os-api.md §7).
- `tools/modules.ts`: loads module directories as the instance does, for a module repository.
- `src/react.ts`: `react()`, a reaction: when an event is heard or a message matches, send a command
  through the outbox (docs/bot-os-api.md §4.15).
- `src/rng.ts`: a seeded generator, so that a simulated run repeats exactly.
- `src/graph.ts`, `src/ports.ts`: the graph, its port types (`chat-in`, `chat-out`, `events`,
  `interface`) and its check; a graph file of version 1 is converted to version 2 as it loads
  (`upgradeGraph`, docs/bot-os.md D60).
- `tools/graph.ts`: prints a graph file as text or as a Mermaid flowchart.

The full description of the API is [docs/bot-os-api.md](../../docs/bot-os-api.md).
