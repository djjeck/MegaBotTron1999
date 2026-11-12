# @megabottron1999/core

The shell's core. A plugin is a manifest (its kinds, its ports, its configuration, settings and
secrets, its interface of reads, actions and chat commands, its state's migrations) and a `create`
that gets a context: its clock, store, scheduler, bus, connectors through their handles, outbox,
drift, settings, owner, log and the render service (SVG to PNG, on resvg: `src/render.ts`). The core
loads the plugins of a graph, starts them in order (none disabled, stopped or inactive:
docs/bot-os.md D64), sends each chat-out edge's sends for real or as dry runs, stops one whose
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
  `src/module-store.ts`: the modules of the data volume, their resolve hook, their loading, install
  and rollback (docs/bot-os-api.md §7).
- `tools/modules.ts`: loads module directories as the instance does, for a module repository.
- `src/react.ts`: `react()`, a reaction: when an event is heard or a message matches, send a command
  through the outbox (docs/bot-os-api.md §4.15).
- `src/rng.ts`: a seeded generator, so that a simulated run repeats exactly.
- `src/graph.ts`, `src/ports.ts`: the graph, its port types (`chat-in`, `chat-out`, `events`,
  `interface`) and its check; a graph file of version 1 is converted to version 2 as it loads
  (`upgradeGraph`, docs/bot-os.md D60).
- `src/graph-file.ts`, `src/graph-history.ts`: the graph file of the data volume, its check, diff
  and rollback for the control API, and its history: every graph written kept as a version for 7
  days (never fewer than the 5 latest), with what changed and whether the instance started on it
  (docs/bot-os-api.md §2.3, docs/bot-os.md D61).
- `src/graph-view.ts`: the graph printed (`graphText`, a value per line, and `lineDiff`, two
  printouts' line diff) and drawn (`graphMermaid`).
- `tools/graph.ts`: prints a graph file as text or as a Mermaid flowchart.

The full description of the API is [docs/bot-os-api.md](../../docs/bot-os-api.md).
