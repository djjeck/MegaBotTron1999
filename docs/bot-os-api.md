# MegaBotTron1999: the plugin API

Documented as of 8 Nov 2026. The plugin model of MegaBotTron1999 ([bot-os.md](bot-os.md)): what a
plugin declares, how the core runs it, what it is given, and the shell's own plugins. The API stays
open until launch (P13): this document changes with it, in the same commit as the code.

The core is `packages/core/src/`; its public API is `packages/core/src/index.ts`
(`@megabottron1999/core`). The examples below use a made-up dice game (`dice`), a made-up @QuestBot,
an IRC channel `#lobby` and an owner `alice`.

## 1. A plugin

A plugin is a module that exports one `Plugin`: a manifest, and a function that makes the running
plugin from what the core gives it.

```ts
export const plugin = definePlugin({
  manifest: {
    id: 'dice-roller',
    version: '0.1.0',
    kinds: ['actor'],
    // …the rest of the manifest (§2)
  },
  create: (ctx) => ({
    start() {},
    stop() {},
  }),
});
```

`create` may be async. What it returns is the plugin's **instance**: hooks the core calls (§3), all
optional. A plugin keeps no global state: everything it holds hangs off its instance, so that tests
can make as many as they like, and one plugin can run as several instances (§2.1).

## 2. The manifest

Validated with zod when the instance loads; a bad manifest names the plugin and the field, and the
instance does not start.

| Field           | Meaning                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | Lower-case words and dashes (`dice-roller`), unique in the instance; the name of its store, its settings and its log lines. `core` is reserved                                                                                                                                                                                        |
| `version`       | Semver of the plugin                                                                                                                                                                                                                                                                                                                  |
| `kinds`         | One or more of `connector`, `parser`, `actor`, `stats` (stats and commands), `agent`, `simulator` (bot-os.md §1)                                                                                                                                                                                                                      |
| `description`   | One line, for the UI and the agents                                                                                                                                                                                                                                                                                                   |
| `archived`      | An archive (bot-os.md D32): built and tested, but refused in every instance's graph; only a run that says `allowArchived` (a test, the dev kit, a manual-test tool) runs it                                                                                                                                                           |
| `inputs`        | Its input ports, by name (§2.1): what it consumes, each of a port type, with the binding the default graph gives it                                                                                                                                                                                                                   |
| `outputs`       | Its declared output ports, by name (§2.1): its `chat-out`s, what it sends through a connector's account, with the binding the default graph gives each. Its other outputs are derived                                                                                                                                                 |
| `requires`      | Shorthand (§2.1): the plugins it needs started first, by id, read as input ports. The load order follows them; a missing one or a cycle fails the start, naming it                                                                                                                                                                    |
| `games`         | `registers`: the namespaces whose event types it defines (its game's, or its own id); `consumes`: those whose events it reads (P7)                                                                                                                                                                                                    |
| `events`        | The event types it registers, `<namespace>.<name>` → zod schema of the payload (§4.4)                                                                                                                                                                                                                                                 |
| `uses`          | Shorthand (§2.1): the other plugins' interfaces it calls, by id and member (`{ dice: ['state.game'] }`): reviewed with both (P6)                                                                                                                                                                                                      |
| `reach`         | Shorthand (§2.1): what it reads and sends, per connector: `{ connector, reads: chats, sends: chats, commands }`, read as a chat-in input and a chat-out output. The outbox refuses a send outside it (§4.6)                                                                                                                           |
| `config`        | A zod object: what is set at deploy. The core validates it at load; a bad value names the plugin and the key. Every default is in the schema, per field (`.default()`, nested ones included), never merged in code after parsing, and each field says what it is (`.describe()`): the editor shows both                               |
| `settings`      | A zod object: what the owner changes at runtime, each key with its default and its help (`.describe()`). Kept in the plugin's store, offered to every control surface (P11)                                                                                                                                                           |
| `secrets`       | The secrets it needs, by name (`znc_password`). Only a `connector` may declare any (P9); the manifest of any other kind that does is refused                                                                                                                                                                                          |
| `configSecrets` | The keys of its `config` whose values name a secret (§4.9): a connector run as several nodes, each with a credential its node's config names. Only a `connector`                                                                                                                                                                      |
| `state`         | `{ version, migrations }`: the schema version of its store and the steps from each older one (§4.2)                                                                                                                                                                                                                                   |
| `drift`         | The parser's threshold for an unrecoverable rate of unread messages (§4.7)                                                                                                                                                                                                                                                            |
| `interface`     | What it offers people, commands and agents (P11): `commands` (chat commands: name, help, arguments), `actions` (typed calls that change something: zod input and output) and `state` (typed reads, by name: zod output). The web UI, the chat commands and the agent interface are all made from these descriptions, and nothing else |

A connector's manifest also names its **account** (§4.5): the network and the identity it holds.

`core.load()` checks the manifests, the graph, their order and their configuration, and makes the
settings, before any plugin starts (`start` loads if it was not called). Each plugin instance's
configuration comes from its node of the graph, or from the deployment through the core
(`CoreOptions.config`, by instance id), and `ctx.config` holds it as the plugin's schema made it; a
bad value fails the start, `plugin irc: config port: …`. The owner's settings are kept in each
plugin's store (the core's `_settings` document), and the core's own (`CoreOptions.settings`) in its
own. `core.settings` is the registry the control surfaces use (`set`, `current`, `kept`): a bare key
names the one plugin that has it, `plugin.key` names it when two share it, and the plugin hears each
change through `settingsChanged`.

A plugin whose settings live in its own objects puts them in force itself: its instance offers
`settings` (`apply(key, value)`, `read(key)`), and `ctx.settings` gives it the owner's values as
kept (`kept()`, read at `create`) and the way to change one (`set(key, value)`: kept, put in force
and heard, as the owner's would be, for a part that switches itself off). Settings that live in the
wiring's objects are put in force by the wiring (`settings.serve`, `putInForce`).

**Interfaces.** A plugin offers others its declared interface through its instance's `interface`
(`state`: reads by name, each a function; `actions`: calls), and a plugin that needs one binds an
interface input to it (§2.1). The load checks each member: the other plugin must be there and
declare the member in its manifest's `interface`; anything else is an error of the deployment.
`ctx.use(port)` hands over only the members used, as the other's instance offers them, once the
other is running.

**Chat commands (P11).** A command of `interface.commands` has its `help` (the owner's words: the
owner's menu, the UI, the agents), its `args`, its `aliases` (other names it answers to, in no menu)
and, for the users' menus, a description in their language (`menu`; a command without one is
answered but not listed there). The instance offers a handler for each (`commands`:
`run(answer, request)`, and `allow(asker)` for a command answered only to some; a command declared
and not offered fails the plugin at `create`), and two commands or aliases of one name fail the
load. `core.commands()` lists the running plugins' commands, in load order, for the chat surface,
which registers them in its menus and answers them where they were asked
(`packages/core/src/commands.ts`). The answer is the surface's (D29): the handler says what to
answer (`Answer`: a text, plain or Markdown, with buttons that each run a command again and an
expiry in a group; a photo, as bytes or by the network's id of one sent before), and the surface
sends it in reply to the asker (`Asker`: the network's id and username, and whether it is the
owner), outside the plugin's mode. What a plugin sends on its own goes through its outbox, in its
mode (§4.6). The surface is a connector's (`ChatSurface`): the core serves every running connector
that offers one the commands (`serve`), once every plugin has started.

**The owner's commands.** A command may be the owner's (`owner: true`): the core answers it to the
owner only (`Asker.owner`), and the surface only in the owner's chat, never in a group. A command
may be `hidden`: in no menu, the owner's included, for the actions of buttons that may also be typed
by hand. A button's action is a command: as typed (`/report 8`), or in short, `name:args` or a bare
name (`opt:fast:on`, `kill`; `tapOf` reads both), which keeps the owner's buttons within Telegram's
64 bytes. A tap runs the command again and redraws the message tapped with its answer, unless the
answer says `keep`. The core adds its own commands after the plugins' (§4.11); a plugin's command of
one of their names fails the load.

### 2.1 Ports and the graph

Composition is a typed graph (bot-os.md P17, D27): each plugin instance is a node, with input ports
(what it consumes, drawn on the left) and output ports (what it produces, on the right), each of a
port type the core defines (`packages/core/src/ports.ts`); an edge binds an input to an output of
its type. The instance's wiring is that graph, kept as data (`packages/core/src/graph.ts`), and the
edges are the permissions (P6): a plugin reads a chat, sends through an outbox, uses an interface or
hears a namespace's events only through a port an edge binds.

| Port type   | Output                                                                                     | Input                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `chat-in`   | `chat`: a connector's account, of its network (derived)                                    | `{ type: 'chat-in', network?, when? }` (declared); its edge carries the chats it `reads`                                      |
| `chat-out`  | `{ type: 'chat-out', network? }` (declared in `outputs`); its edge carries what it `sends` | `chat`: a connector's account (derived), bound to any number of senders; their edges carry the chats sent to and `commands`   |
| `events`    | `events` (`<ns>-events` with more than one): each namespace it registers (derived)         | `{ type: 'events', namespace }`, bound to any number of instances; it hears only theirs; `namespace` may be `{ config: key }` |
| `interface` | `interface`: its declared reads and actions (every plugin has one, derived)                | `{ type: 'interface', plugin, members }`; none for a plugin it only needs started first; no `plugin`: a contract              |

**Chats flow left to right** (bot-os.md D60): only parsers read chats, actors only send, and
everything else consumes events and interfaces. A chat-in edge runs from a connector's chat-in
output, `chat`, to a reader's chat-in input, on its left: the chats it hears (`reads`). A chat-out
edge runs from a sender's chat-out output, on its right, to the connector's chat-out input, `chat`:
the chats it may send to (`sends`) and the commands it may send there (`commands`, by first word;
none: any text). A connector has both, as one node (one account, one session); the editor draws it
as two cards (§4.12). A connector's chat-out input takes any number of senders; a sender's chat-out
output, one edge, required unless `optional` (the connector starts first, and an unbound required
one fails the start: `node actor: output port chat (chat-out of irc) is not bound`). A port's
`network` (`irc`, `telegram`) is matched against the connector's account, as it was for a chat.
`ctx.connector(port)` hears through a chat-in input, and `ctx.outbox(port)` sends through a chat-out
output (each also by the connector's id or its account).

A chat-in input may say `when: { config: key }`, a key of its plugin's `config` schema: the node has
the port only while its config sets that key (the reactor reads a chat only with a `match`),
resolved as an events input's namespace is (below).

**Module API 1** keeps loading: a manifest's `{ type: 'chat' }` input, and the `requires`/`reach`
shorthand's chat, are read as a chat-in input and a chat-out output of the same name, the `bind`
split between them (`reads` to the input; `sends`, `commands` to the output). A chat-out declared in
`outputs` under that name replaces the old input's half. So a module written before the split runs
unchanged: its `ctx.connector('channel')` and `ctx.outbox('channel')` name the two halves.

An interface input that names no plugin is a **contract**: any node whose interface declares its
members binds it (`interface with state.rest, actions.sent`), so each instance of one plugin may use
another plugin's interface (each turn-actor instance its own bot's parser, §5). It has no default
edge: the graph binds it.

**An events input whose namespace its node's config names** (bot-os.md D57): a plugin that learns
what it listens to from its node's config (the `reactor`, §5) declares
`{ type: 'events', namespace: { config: 'on' } }`, where `on` is a key of its `config` schema (the
manifest is refused otherwise). Each node resolves it from its config, as the plugin's schema makes
it (its defaults included; as written when the schema refuses it): the key's value names a namespace
(`dice`) or an event type, whose namespace it takes (`dice.roll` → `dice`). The resolved namespace
is the port's everywhere: the graph's check compares it with the output an edge binds
(`events of dice cannot bind events of cards`), the default graph binds it to the nodes registering
it, the node's `ctx.bus.subscribe` and `ctx.events.read` allow it, `GET /graph/view` draws it on the
node (with the `config` key it came from), and the editor resolves it from the draft's config as
written (`GET /available` gives the key, `config`, and no `namespace`). A node whose config leaves a
required one unresolved is refused, naming the node
(`node r: input port events: its namespace comes from config on, which is not set`), and so is one
whose value names no namespace; an optional one whose key is not set is not there: the node has no
such port, and an edge to it is refused. `resolveInputs` (`packages/core/src/ports.ts`) resolves
them; `ResolvedNode.ports` holds a node's.

Each port type has a stable id, a description, and a shape and a colour for the drawing
(`PORT_TYPE_INFO`). An input may be `optional`: it may be left unbound, imposes no order and fails
nothing, and the plugin asks for it when it needs it (`ctx.useOptional`, undefined while unbound or
while its other end is not running), so that two plugins can each use the other without tying their
failures together. Every other input is required: it must be bound, the instance it binds starts
first, and its failure fails this one.

A manifest's `inputs` and `outputs` give each port its `bind`, the edge the default graph makes
(`{ node, reads }` for a chat-in, from the connector `node`; `{ node, sends, commands }` for a
chat-out, to it; `{ node }` for an interface, by default the node of the plugin's id; `{ nodes }`
for events, by default every other node registering the namespace). The manifest's older fields stay
as shorthand, read as ports: a `requires` that `reach` names is a required chat (a chat-in input and
a chat-out output, as above) named after the connector, with the reach's chats and commands as its
binding; any other `requires`, and each plugin `uses` names, a required interface input named after
it; `games.consumes` an optional events input, `<namespace>-events`; a `reach` not required, an
optional chat. A plugin's code names its ports: `ctx.connector('channel')`, `ctx.outbox('channel')`,
`ctx.use('game')`.

```ts
manifest: {
  inputs: { channel: { type: 'chat-in', network: 'irc', bind: { node: 'irc', reads: ['#lobby'] } } },
  outputs: {
    channel: { type: 'chat-out', network: 'irc', bind: { node: 'irc', sends: ['#lobby'], commands: ['!roll'] } },
  },
}
```

**The graph** is `{ version: 2, nodes, edges }`, the chats left to right:

```json
{
  "version": 2,
  "nodes": [
    { "id": "irc", "plugin": "irc", "config": { "host": "znc.example.net", "nick": "alice" } },
    { "id": "dice", "plugin": "dice" }
  ],
  "edges": [
    { "from": "irc.chat", "to": "dice.channel", "type": "chat-in", "reads": ["#lobby"] },
    {
      "from": "dice.channel",
      "to": "irc.chat",
      "type": "chat-out",
      "sends": ["#lobby"],
      "commands": ["!roll"]
    }
  ]
}
```

A node is a plugin instance: its id (a plugin id's form), the plugin it instantiates (one the image
or a module offers, registered with `core.register`), the `instance` whose kept state it runs on
(§2.2; the node's id when it names none), its configuration, and, for a connector, its own `account`
in place of the manifest's (of the same network). It may also give the `settings` (checked against
its plugin's `settings`) and the `mode` its instance starts with: they are put in force only while
the instance keeps none of its own, so the owner's later changes win. An edge goes from `node.port`
(or `node`, when one of its outputs fits) to `node.port`, with its type and, for a chat, what it
carries: a chat-in its `reads`, a chat-out its `sends` and `commands` (each carries only its own).
The core checks it with zod and against the manifests at load, and fails the start naming the node
and the port: a plugin not in the image, a node twice, an instance named by two nodes or kept by
another plugin (`node b: its instance tally is of the plugin other, not counter`), a setting the
plugin does not have or refuses, an edge between ports of two types or to a port that is not there,
an interface member not declared, a single input (or a chat-out output) bound twice, a connector
account held twice, a required input or chat-out output unbound
(`node actor: input port channel (chat-in of irc) is not bound`), a cycle of required edges.

Each instance has its own id (`ctx.id`), configuration, store, settings, mode, timers and drift; its
log lines, its records and the owner's controls name the instance (`PluginControl.plugin` names its
plugin). Two instances of one plugin publish its event types, each heard only by the instances its
edges bind; two whose commands share a name fail the load.

**Where the graph comes from.** `CoreOptions.graph` is the instance's graph; without it, the core
makes the default one from the plugins registered, in their order: a node per plugin, its id the
plugin's, each input bound as its `bind` says (`defaultGraph`), which tests and simulators use.
`CoreOptions.graph` may also be a function of the default graph:
`withInstances(graph, plugin, instances)` replaces the default node of a plugin meant for several
instances by its instances. `core.graph()` gives the graph the instance runs, every edge written
out. A changed graph takes effect at the next start (P8). The instance's entry point (`src/main.ts`)
registers the connectors, the turn-actor, the reactor and the modules' plugins (§7), and runs the
graph saved in its volume (`CoreOptions.graphFile`, §2.3).

### 2.2 Instances

A plugin's kept state belongs to an **instance**, apart from the node that runs on it (bot-os.md
D50): its store and the core's documents beside it (its timers, its settings, its mode, what it
serialised), in `/data/instances/<instance>/`. A node names its instance: an existing one of the
same plugin, whose state it takes up, or a fresh id, made at its first start. So a node can be
removed and added again, renamed, or replaced by another node of its plugin, without losing what it
kept; and one plugin can run as several nodes (the turn-actor, one per bot), each on its own
instance.

As built (`packages/core/src/instance-registry.ts`): each instance keeps a record of itself,
`_instance.json`: its `plugin`, when it was `created` and when a node last `referenced` it (each a
time in ms). The load refuses a node on an instance of another plugin, and two nodes on one
instance. An instance that no node references, of the running graph or of the saved one (§2.3), for
7 days (`ORPHAN_MS`) is deleted, with its state: the core looks at start and then daily
(`core.sweepInstances`), touching the instances referenced, prints each one deleted and records it
(`core.instance`, `event: "deleted"`). While the saved graph does not read, nothing is deleted. A
directory without its record (put there by hand) is listed and left alone. `core.instances()`, and
`GET /instances`, list them: each with its plugin, its times, the node that runs on it, and whether
a node uses it (`used`).

### 2.3 The graph file

`/data/graph.json` is the only source of the instance's composition (bot-os.md D50): no code
declares it, the owner builds it node by node (the web UI's graph editor, bot-os.md D55, or the
control API), and a restart applies it (P8). It is the graph of §2.1, each node with its `instance`
(§2.2):

```json
{
  "version": 2,
  "nodes": [
    {
      "id": "tg",
      "plugin": "telegram-user",
      "account": "telegram:alice",
      "config": { "chats": ["@QuestBot"] }
    },
    { "id": "quest", "plugin": "quest-parser" },
    {
      "id": "quest-turns",
      "plugin": "turn-actor",
      "instance": "quest-turns",
      "mode": "dry-run",
      "config": { "chat": "@QuestBot" }
    }
  ],
  "edges": [
    { "from": "tg.chat", "to": "quest.chat", "type": "chat-in", "reads": ["@QuestBot"] },
    { "from": "tg.chat", "to": "quest-turns.chat", "type": "chat-in", "reads": ["@QuestBot"] },
    {
      "from": "quest-turns.chat",
      "to": "tg.chat",
      "type": "chat-out",
      "sends": ["@QuestBot"],
      "commands": ["/play"]
    },
    { "from": "quest.interface", "to": "quest-turns.parser", "type": "interface" }
  ]
}
```

**Version 1** (one `chat` edge for both the reads and the sends, from the connector to the plugin)
is converted as it is read (`upgradeGraph`, `packages/core/src/graph.ts`, bot-os.md D60), against
the plugins' manifests and each node's config: each `chat` edge becomes a chat-in edge with its
`reads`, same ends, if its node has a chat-in input of that port's name; a chat-out edge with its
`sends` and `commands`, from the node's chat-out output of that name to the connector's `chat`, if
it has one; both for a node with both (the turn-actor, any plugin of module API 1); and both for a
node whose plugin is unknown, so nothing is lost. The port names stay the same, so the conversion is
mechanical: `tg.chat → quest.chat` (a parser) stays one edge, of `chat-in`; `tg.chat → look.chat` (a
reactor on events) becomes `look.chat → tg.chat`, of `chat-out`. The instance runs a version 1 file
so converted, `GET /graph/file` shows it so, and `POST /graph/check` and `PUT /graph/file` take
version 1 too; the file itself is rewritten (as version 2) only by the next save, so
`graph.previous.json` and a rollback keep working on either version.

**At start** (`packages/core/src/graph-file.ts`, `GraphFile`), the core reads it and checks it as
any graph (§2.1), against the plugins `core.available()` lists, their configuration and settings
schemas, their secrets and the instances kept. No file: an empty graph. A file that does not read
(not JSON), or that the check refuses, never stops the instance, which would only start again and
fail again: it starts with no nodes, the file is kept as it is, and why is printed, recorded
(`core.graph`, `event: "refused"`), told to the owner, and reported by `GET /status`
(`graph.refused`) and `GET /graph/file` (`problems`), for the owner to fix.

**A problem** (`GraphProblem`) is its words as the load says them (`text`) and, where it can be
told, the `node`, the `edge` (`{ from, to }`), the `port`, and the `config` or `setting` key it is
about, so that the editor marks it there. An edge between ports of two types is refused with why
(`node actor: input port score: chat-in of chat cannot bind interface of scorer (edge chat.chat → actor.score)`).

**The control API's graph routes** (§4.11), the owner's alone:

- `GET /graph/file`: the saved file (`graph`, as written, a version 1 file as version 2), whether
  there is one (`exists`), why it does not read (`error`) or is refused (`problems`), and whether it
  differs from the graph running (`differs`: a restart would change what runs).
- `POST /graph/check`, a graph as the body: checked as the load would, nothing saved: `ok`, its
  `problems`, and its `diff` from the saved file: the nodes `added`, `removed` and `changed` (with
  the fields that changed), and the edges `added`, `removed` and `changed`, by their two ends.
- `PUT /graph/file`, a graph as the body: checked, then saved as the core holds it (each edge's ends
  and type written out), the file before kept as `graph.previous.json`; `saved` (false when nothing
  changed) and `restart` (whether it differs from what runs). A graph refused is not saved: 400,
  with its `problems`.
- `POST /graph/rollback`: `graph.previous.json` and `graph.json` swap, so a second rollback goes
  forward again; 409 when there is no previous version. Its `problems`, if the check refuses it.
- `POST /restart`: applies it. The answer goes, then the instance ends as at `SIGTERM` (§3): the
  core stops, each plugin's state kept, and the process exits 0, so that Docker's
  `restart: unless-stopped` starts it again on the saved graph.

No agent grant ever includes these (P11): they are the control API's, which no agent is given.

## 3. The lifecycle

```text
registered ─ manifests, graph and config valid ─▶ starting ─ create(), start() ─▶ running
   running ─ every plugin started: ready() ─▶ running
   running ⇄ paused        running, paused ─ serialise(), stop() ─▶ stopping ─▶ stopped
   create(), start(), ready() or a migration fails ─▶ failed (with why), and so do the plugins
   requiring it
```

`packages/core/src/core.ts` runs it (`Core`: `register`, `load`, `start`, `stop`, `pause`, `resume`,
`status`); every change of state is logged as `core.plugin`, with the plugin, the state and the
reason.

- **Errors of the deployment** fail the whole instance at load, before any plugin runs, naming the
  plugin and what is wrong: a bad manifest, two plugins with one id, a bad graph, a cycle, a bad
  configuration value, a secret declared but not provided, an archived plugin in the graph (unless
  `CoreOptions.allowArchived`).
- **Errors at runtime** fail one plugin: `create` or `start` throws, or a migration fails. That
  plugin is `failed`, with why; the plugins that require it (a required edge, §2.1) are `failed`
  too; every other plugin starts. The owner is told, and the failure is logged (`core.plugin`).
- **Start** runs in load order (requirements first), each plugin's `start` awaited before the next
  begins. **Stop** runs in the reverse order, at `SIGTERM` or the owner's restart (§2.3), each
  plugin's `stop` awaited for up to 5 seconds (a stop that fails or takes longer is logged, and the
  next plugin stops). The process exits 0 once the core has stopped, or after 30 seconds however far
  it got (`packages/core/src/shutdown.ts`).
- **Ready:** once every plugin has started, each running one hears `ready`, in load order, before
  the core's `start` resolves. It is for the work that needs the plugins that use this one in place
  (a parser replaying recent history to the plugins that listen to it). A `ready` that throws fails
  its plugin, which is stopped, and those that require it.
- **Paused** is the core's: an acting plugin paused by drift (§4.7) or by the owner. Its sends are
  refused by the outbox while it is; its `pause` and `resume` hooks are called so that it can stop
  planning. Only the owner resumes it.
- **Serialise and restore** (P8): a plugin writes what must survive through its store as it changes,
  which survives a crash too. For state cheap to lose but costly to rebuild, its `serialise` hook is
  called at stop, and what it returned is handed back to the next `create` as `ctx.restored`.

The instance's hooks:

```ts
interface Instance {
  start?(): void | Promise<void>;
  ready?(): void | Promise<void>; // every plugin has started
  stop?(): void | Promise<void>;
  serialise?(): unknown;
  pause?(reason: string): void;
  resume?(): void;
  /** The owner changed settings; the new values are already in ctx.settings. */
  settingsChanged?(keys: string[]): void;
  off?(): void; // the owner turned the instance off (§4.11)
  on?(): string | undefined; // back on: what came of it
  kill?(): string | { text: string; buttons?: Buttons } | undefined; // its safety stop
  onTimer?(name: string, payload: unknown): void; // §4.3
  settings?: { apply(key, value): void; read(key): SettingValue }; // its own in force (§2)
  interface?: {
    state?: Record<string, () => unknown>;
    actions?: Record<string, Function>;
  };
  connector?: Connector; // a connector plugin's (§4.5)
  surface?: ChatSurface; // a connector's chat surface (§2)
}
```

## 4. What the core gives a plugin

`create(ctx)` receives the plugin's context. Everything in it is bound to that plugin instance: its
store is its own namespace, its scheduler its own timers, its bus only the namespaces it declared.
It never holds a credential (P9).

```ts
interface PluginContext<Config, Settings> {
  id: string;
  log: Logger; // stdout, prefixed with the id, secrets redacted (§4.9)
  record(type: string, fields: object): void; // to the event log (§4.4), with its instance
  events: { read(query?: EventQuery): LogEntry[] }; // the log read back, its instance's (§4.4)
  clock: Clock; // now(), and timers; virtual in tests and simulators
  store: Store; // §4.2
  scheduler: Scheduler; // §4.3
  bus: Bus; // §4.4
  config: Config; // validated (§2)
  settings: { kept(): Partial<Settings>; set(key, value): string | undefined }; // §2
  connector(port: string): ConnectorHandle; // §4.5, a chat-in input an edge binds (§2.1)
  outbox(port: string): Outbox; // §4.6, the account a chat-out output's edge binds
  use<T>(port: string): T; // the interface an input's edge binds (§2.1)
  useOptional<T>(port: string): T | undefined; // an optional input's, while bound and running
  drift: DriftReporter; // §4.7, parsers only
  notify(text: string, buttons?: Buttons): void; // the owner (§4.8); nothing while off
  mode: { get(); set(mode, by?: 'owner' | 'safety'); onChange(listener) }; // its own (P10)
  off(): boolean; // the instance is off (§4.11)
  resume(): boolean; // the owner's resume, carried by the plugin
  restored?: unknown; // what serialise returned at the last stop (§3)
  render: Render; // §4.13: SVG to PNG
}
```

A connector's context also has `secrets.get(name)`, for the secrets it declared or its config names
(§4.9), and `account`, its node's account (§4.5), on which it makes its connector.

**Built from its saved config alone** (bot-os.md D50): everything a plugin needs is its node's
`config` and its context, so the graph's nodes are data the editor can make. A plugin factory may
take what is code (a game's grammar, a test's fake client), never a deployment's values (a chat, a
group, an account, a closure over the event log): those are config, an edge, or the context.

### 4.1 The clock

`now()`, `setTimeout` and `clearTimeout`, injected. The wall clock in an instance; a virtual clock
in tests and simulators, which advance it by hand. Nothing in the core or a plugin reads
`Date.now()` or calls the global timers directly.

As built (`packages/core/src/clock.ts`): `wallClock()`, whose timers do not keep the process alive,
and `VirtualClock`, the dev kit's (§4.10), whose timers are a heap in time order (ties in the order
set). It moves only when told: `advance` and `advanceTo` run every timer due on the way, each at its
own time; a simulator drives it one timer at a time (`nextAt`, `runNext`), interleaving events of
its own, and sets its own at an absolute time (`at`).

### 4.2 The store

`/data/instances/<instance>/` (P6), one directory per plugin instance (§2.2), under the data volume;
the core's own is `/data/core/`:

- `read(name)` and `write(name, value)` of JSON documents, by name (letters, digits, `-`, `_` and
  `.`: no path), written atomically (a temporary file, then a rename), so that a crash leaves the
  old document or the new one, never half of one.
- `version`: the schema version kept with the documents (`_meta.json`). At start the core runs the
  manifest's migrations from the kept version up to the manifest's, each one awaited; a failed one
  leaves the store as it was, and fails that plugin only (§3).

A plugin reaches nothing outside its own directory. Data of another plugin comes through that
plugin's interface (`use`), never its files.

As built (`packages/core/src/store.ts`): documents are `<name>.json`, written with mode 600 in a
directory of mode 700; the core keeps its own beside them (`_meta.json`, the version;
`_restore.json`, what `serialise` returned, handed back once; `_timers.json`; `_settings.json`;
`_mode.json`; `_instance.json`, the instance's record, §2.2). Migrations run on a staged copy
(`<instance>.migrating/`) that replaces the directory only when every step has succeeded, so a
failed one leaves the store as it was, and a store newer than its plugin (an image rolled back)
fails that plugin rather than being read wrong. A crash between the two renames of the commit is
undone at the next start.

**Backups.** The whole data volume is the instance's state: the graph, the event log, the instances'
stores, the core's own and the modules. Back up the volume as one, with the instance stopped for the
copy, so that no document is caught between writes. Restore it as one too: a store restored without
the event log, or the reverse, would replay a history the state does not match. A single plugin's
state can be restored on its own by putting back its instance's directory, `instances/<instance>/`,
while the instance is stopped.

### 4.3 The scheduler

Durable named timers, kept in the plugin's store (P8):

- `at(name, time, options)` and `after(name, ms, options)` set a timer, replacing one of that name;
  `cancel(name)` drops it. A timer holds a small JSON `payload`.
- `options.late`: what a timer that came due while the instance was down does at the next start:
  `fire` (at once, the default), or `drop`; with `graceMs`, it fires only if it is no later than
  that, and is dropped otherwise.
- The plugin's handler is its instance's `onTimer(name, payload)`: timers outlive the closures of
  the process that set them, so a timer is data, and the handler reads what it means.

As built (`packages/core/src/scheduler.ts`): `ctx.scheduler` has `at`, `after`, `cancel`, `get` and
`names`. Those due while the instance was down are settled when the plugin is created: dropped ones
(logged as `core.timer`) are gone before `create`; the rest fire at once after its `start`, in time
order. A timer fires once its plugin is running (or paused), never while it is starting, stopped or
failed; a timer that fires is removed before `onTimer` runs, so the handler may set it again. A
handler that throws is logged, and the core goes on. Timers beyond Node's longest delay (about 24.8
days) are armed again when they wake.

### 4.4 Event types and the bus

- An event type is `<namespace>.<name>` (`dice.roll`, `quest.turn`), registered by the plugin whose
  manifest lists it, with the zod schema of its payload. The namespace is a game's, or the
  registering plugin's own id for what belongs to no game (`turn-actor.step`); `core.*` is the
  core's.
- `bus.publish(type, payload, t?)` fails for a type nobody registered, or one in a namespace the
  plugin does not register. In tests and in development (`NODE_ENV` not `production`) the payload is
  validated against its schema; in production it is not, to spare the parse on every message.
- `bus.subscribe(type or namespace, handler)` delivers only what the plugin declared it consumes:
  the namespaces of its events inputs, from the instances their edges bind, and its own (§2.1).
  Handlers run in order of subscription, synchronously: a message has reached every consumer before
  the next one is read. It returns the way to stop; a plugin that fails or stops is unsubscribed.
- Every event published is written to the event log, as `{ type, t, instance, ...payload }`, one
  JSON line per record in a file per UTC day (`packages/core/src/event-log.ts`); `instance` is the
  instance whose state the publishing node runs on (§2.2). `type`, `t` and `instance` are the
  core's: a payload's own fields of those names never replace them.
- **Its own records:** `ctx.record(type, fields)` writes `{ type, t, instance, ...fields }` (`t`
  now, `instance` its node's) to the log, with no schema and to no subscriber, for what a plugin
  keeps a trace of without publishing it: a type of a namespace it registers or of its plugin's id
  (`dice-roller.turn`); any other is refused.
- **Reading the log back:** `ctx.events.read({ type?, since?, until?, all? })` gives the log's
  records in time order, of the namespaces it registers, of its plugin's id, and of those its events
  inputs consume (asking for another is refused, naming what it reads): one type (`dice.roll`), one
  namespace (`dice`), or all of them; from `since` (the log's first day without) to `until` (now
  without). A parser replays its recent history at `ready` with
  `read({ type: 'dice.roll', since: ctx.clock.now() - 6 * HOUR })`; a fresh instance reads the whole
  log once with `read({ type: 'dice.roll' })`. It reads the instance's log (`CoreOptions.events`);
  the dev kit's is in memory (§4.10); without one it reads nothing. **By instance:** it reads its
  own instance's records of its own namespaces, and, of a namespace an events input consumes, those
  of the instances its edges bind, as the bus would have delivered them; so two instances of one
  plugin (a turn-actor per bot) never read each other's. `all: true` reads every instance's. A
  record with no `instance` (imported from an older log, §8, or written before records carried one)
  belongs to no instance, and every reader of its namespace reads it.

Two plugins registering one type is an error of the deployment; two instances of one plugin share
its types, and each subscriber hears only the instances its edges bind. A subscriber that throws is
logged and the others still get the event.

### 4.5 Accounts and connectors

An **account** is one identity on one network, with an id of the form `<network>:<name>`:
`irc:alice`, `telegram:alice` (a user), `telegram-bot:ExampleBot`. Each connector is bound to one
account, and holds its credentials; the plugins get a handle.

```ts
interface Inbound {
  account: string; // which account saw it
  network: string; // 'irc', 'telegram', …
  chat: string; // '#lobby', a Telegram chat id or @username
  sender: string; // a nick, a username
  text: string;
  time: number;
  id?: string; // the network's message id, where it has one
  replyTo?: string;
  playback: boolean; // history replayed at connection (ZNC's buffer), not news
  own?: boolean; // sent by the account itself, from any of its devices
}

interface ConnectorHandle {
  account: string;
  status(): ConnectorStatus; // 'connecting' | 'connected' | 'closed', with the network's phase
  self(): string | undefined; // the account's own name on the network, once connected
  onMessage(handler: (m: Inbound) => void): () => void;
  onStatus(handler: (s: ConnectorStatus) => void): () => void;
  isAdmin?(chat: string): Promise<boolean>; // where the network can say
}
```

The connector itself also implements `send(chat, text)`, and, for a network whose sends answer later
(Telegram), `deliver(chat, text)`, which resolves with the message's id; only the outbox calls them:
no plugin holds a way to send that skips it.

As built (`packages/core/src/connector.ts`): a connector plugin's instance offers its `connector`,
whose account must be the manifest's (or its node's); `ConnectorBase` keeps the listeners and the
status for the implementations. `ctx.connector(port)` gives a handle only on a connector a chat-in
input of the plugin is bound to, and the handle hears only the chats that edge `reads` (compared
without case). A connector's node has a chat-in output, `chat`, which the readers' edges leave, and
a chat-out input, `chat`, which the senders' edges reach (§2.1, bot-os.md D60). The wiring reaches
the full connector with `core.connector(id)`. The shell's connectors are in §5.

### 4.6 The outbox

One per account; every send goes through it (bot-os.md §3). A plugin gets its handle with
`ctx.outbox(port)`, bound to its own id, through a chat-out output an edge binds to the account's
connector (§2.1):

- **The mode (P10)** of the sending plugin: `read-only` refuses, `dry-run` logs as if sent, `live`
  sends. Every acting plugin has one, starts `read-only`, is changed only by the owner (a safety
  stop may only lower it), and keeps it across restarts, in the core's store (`_mode.json` in its
  instance's store, §2.2).
- **The reach:** each chat-out edge from it to the account's connector lets it send to its `sends`,
  with its `commands`; a send outside them is refused. A chat-in edge sends nothing.
- **Pacing:** `send` sends now or is refused with why (too soon, the hourly limit), for actors that
  time their sends to the second; `enqueue` queues the send and spaces it within the account's
  limits (`connector.limits`), and the network's waits (Telegram's `FLOOD_WAIT`) hold the account's
  queue.
- **Replies:** matchers pair a bot's answer with the send that caused it: `replyTo`, `mentioning`,
  `within` and `from`, combined with `all`, and `waitFor` waits on a connector handle for the first
  match (`packages/core/src/replies.ts`).
- Every attempt is logged (`core.send`), with its outcome.

As built (`packages/core/src/outbox.ts`): the checks run in a fixed order, each refusal with its
reason: the caller's own refusal (`refuse`, for a game's grammar), the reach
(`… does not send to …`, `… is not among …'s commands`, by first word), the mode (`read-only`), a
pause (`paused: …`, also for a plugin not running), a flood wait (a connector throws `FloodWait`,
which holds the account), the rate (`too soon`, `hourly limit`, dry runs counted), and the connector
(`not connected`). `deliver(chat, text)` runs the same checks, then awaits the connector's
`deliver`: `sent` with the network's id of the message, `refused`, or `failed` with why the network
refused it; the rate counts the send when it leaves. A send may say its text is Markdown
(`format: 'markdown'`): a connector of a network that formats sends it formatted, any other as
written. `core.modes.has(plugin)` tells whether a mode was ever set.

### 4.7 Drift

A parser sorts every message it sees into one of three (P5): **not its bot's**, **read** (events
published), or **claimed but unread** (its bot's, in a form it does not know). The parser reports
the third to `ctx.drift`, with the text; the core logs it (`core.drift`), counts it per parser, and
tells the owner.

**Unrecoverable** (bot-os.md D21): more than 5 unread messages from one parser within 15 minutes, a
threshold each parser's manifest may change (`drift`: `unreadAt`, `windowMin`). Then the core pauses
every running plugin of kind `actor` that requires that parser, directly or through other plugins,
until the owner resumes it; read-only plugins keep running and reporting.

As built (`packages/core/src/drift.ts`): a parser reports through `ctx.drift` (`read`, `unread` with
the text and the lines it did not know); the contract's type is `Reading`. Each unread message is
logged (`event: "unread"`) and told to the owner, the first at once and then at most once an hour
with the count of those meanwhile. Past the threshold the core pauses the actors once until the rate
falls back, logs it (`event: "pause"`, with the plugins) and tells the owner; `core.drift()` gives
the counts.

### 4.8 The owner

The owner of the instance (D19) is told of what the core does on its own (a plugin failed, a pause
for drift) and of what a plugin asks to say (`notify`): through the core, to the owner's chat
surface, and never while the instance is off. **Which surface is the graph's** (bot-os.md D56): the
first node, in load order, whose instance offers a chat surface, which is a `telegram-bot` node
configured with its `owner` (the owner's Telegram user id: the owner's private chat with the bot,
§5); a notice made before it has started waits for it, in order. A wiring may name the node itself
(`CoreOptions.owner`, tests); without a surface, notices go to `CoreOptions.notify`, or are printed
(`core: not told …`) when the wiring gives none, as the image's does. Only the owner's chat may use
the owner's commands and their buttons: the surface answers them to the owner alone (`Asker.owner`),
never in a group. The owner's controls are the core's (§4.11).

### 4.9 Secrets

Secrets come in as Docker secrets, files under `/run/secrets` (P9), are given only to the connectors
that declared them, and are redacted (`[redacted]`) from every log line, record and error that
passes through the core.

As built (`packages/core/src/secrets.ts`): `Secrets` reads each file once (its trailing newline
dropped) and remembers every value read, for `redact` and `redactDeep` (values under 6 characters,
or only digits, are not redacted, to spare ordinary text); the core passes what it prints, records
and tells, and a failed plugin's reason, through them, and the entry point its `console` and its
event log. A connector's `ctx.secrets.get(name)` gives only the secrets its manifest declares, and
those its node's config names in a key of its manifest's `configSecrets` (a connector run as several
nodes, each with its own credential: `{ "token": "bot_token_b" }`; `secrets.names()` lists the names
provided, never their values, for the editor's choice); no other kind of plugin has `ctx.secrets`; a
secret declared or named and not provided, or a value that is no secret's name, fails the load (and
the graph's check), naming it and its file. `core.secretStore` keeps the core's own secrets (a login
done later through the UI), each in `/data/core/secrets/<name>.json` of mode 600: AES-256-GCM with a
random IV and the secret's name as additional data, under a key derived (HKDF-SHA256) from the
`bot_os_key` Docker secret; without that secret it stores nothing.

**Backups and secrets.** The Docker secrets are not in the data volume: back them up where the
deployment keeps them. The secrets the core stores itself are in the volume, encrypted: a backup of
the volume holds them only as ciphertext, readable with `bot_os_key`, which is not in it. Restoring
the volume elsewhere therefore needs the same `bot_os_key`; with another key, those secrets are lost
and must be stored again.

### 4.10 The dev kit

What any plugin runs against outside an instance, in tests and in simulators (P15), from the core's
public API (`packages/core/src/devkit.ts`):

- **`FakeConnector`**, and `fakeConnectorPlugin(id, connector)`, the connector plugin on it: a
  connector of any network (the account's prefix), whose messages the test or the simulator says
  (`hear`, live unless `playback`) and whose status it sets (`open`, `close`), and whose sends go to
  its `onSend` (and are kept, `sent`), with the account's `limits` and the chats it administers
  (`admins`). The plugins read it through their handles and send through their outboxes, as they do
  live.
- **`DevKit`**: a core on a `VirtualClock` (§4.1) whose stores are in memory, with the plugins of
  the run, the run's graph (`graph`; by default one instance of each, bound as the manifests say)
  and, set before it starts, keyed by plugin instance: their configuration (`config`), the owner's
  kept settings (`settings`), the acting instances' modes (`modes`; `read-only` otherwise) and the
  documents their stores start with (`documents`), and the event log before the run (`history`),
  which the plugins read with `ctx.events`; `kit.log` is that log in memory, every record of the run
  added (`MemoryEventLog`). An archived plugin runs on a kit only when the run says so
  (`allowArchived`). `start` refuses a setting refused and a run with a plugin failed; `runUntil(t)`
  runs the clock. The core is the instance's own, unchanged.
- **`defineSimulator({ manifest, run })`**: a simulator plugin (bot-os.md D13), a model of a game
  that runs other plugins on a kit. It is not registered in an instance: its manifest (kind
  `simulator`) names it, the game it plays (`games.consumes`) and the plugins it runs (`requires`),
  and `run(run, options)` plays one run.

### 4.11 The owner's controls

What the owner sees and changes of the instance, built from what each plugin declares (P11) and
nothing else, so that every surface offers the same: the chat surface's owner commands, the HTTP
control API, the web UI and later the agents, whose grants will be subsets of it. As built
(`packages/core/src/controls.ts`, `core.controls`):

- **Each plugin:** its state (running, paused with why, failed with why), its mode if it sends
  anywhere (an edge binds a chat it `sends` to, P10), its settings with the values in force, the
  names of the reads and actions its `interface` declares, and its own account of itself if it
  declares a read named `status`.
- **The owner's changes:** a plugin's mode (`setMode`, P10); a paused plugin resumed (`resume`, P5);
  a declared read (`read`) and a declared action (`act`), whose input is checked against the
  action's schema (an error names the field) and which the plugin refuses by throwing, with why.
- **The off switch,** instance-wide: off, every running plugin hears `off` and stops what it does,
  the owner is told nothing, and every change of a mode or a resume is refused until on; `on` lets
  each plugin take up what it did and say what. It is kept in the core's store
  (`/data/core/power.json`) across restarts, logged as `core.power`, and a plugin reads it with
  `ctx.off()`. The outbox does not refuse sends while off: a plugin's `off` stops it (D30).
- **The accounts and drift:** each connector instance with its account and its connection's status
  (`accounts`), and each parser's drift (`drift`).
- **The kill switch:** each running plugin's own `kill`, its safety stop, with what came of it and
  the buttons of its ways on; a plugin without one is left as it is (D30).
- **A node's kill** (`killNode`, D44, D48), the graph view's: that plugin's own `kill`, then the
  core pauses it with the reason `killed by the owner` (`KILLED`), so that its outbox refuses its
  sends; the status marks it `killed: true`, and its `resume` reinstates it. The core leaves its
  mode as its stop made it, kills nothing else with it, and does not keep the kill across a restart.
  Refused for a node that is not running or paused.

**The core's commands** (`packages/core/src/owner-commands.ts`), the owner's, answered by the chat
surface after the plugins': `/plugins` (the instance on or off and each plugin's state and mode,
with buttons), `/plugins <id>` (a plugin's state, mode, settings, reads and actions, with a button
for each mode and one to resume it if paused), `/mode <id> <mode>`, `/kill`, `/settings` and
`/set <key> <value>`; hidden, the cards' buttons. Each card ends with the way back to the owner's
main card that the wiring names (`CoreOptions.home`).

**The HTTP control API** (`packages/core/src/control-server.ts`), one request handler
(`controlHandler`) that the entry point serves twice: on the container's loopback (`CONTROL_PORT`,
8081), and under `/api/` on the web UI's listener, only behind its login. `GET /status`;
`GET /instance` (off or on, the process's uptime, Node's version and memory, the plugins and the
accounts counted by state); `GET /accounts`; `GET /drift`;
`GET /events?limit=100&type=<prefix>&hours=24` (the event log's latest records, newest first);
`POST /off`, `/on`, `/kill`; `GET` and `POST /settings`; `GET /graph` and `GET /graph/view` (§4.12);
`POST /plugins/<id>/mode`, `/plugins/<id>/resume` and `/plugins/<id>/kill` (409 with why when
refused); `GET /plugins/<id>/state/<name>`; `POST /plugins/<id>/actions/<name>`, the body the
action's input (400 for an input refused by its schema, 409 for the plugin's refusal);
`GET /instances` (§2.2); `GET /graph/file`, `POST /graph/check`, `PUT /graph/file`,
`POST /graph/rollback` and `POST /restart` (§2.3); `GET /legacy`, `GET /legacy/events`,
`POST /instances/import` and `POST /legacy/events/import` (§8); `GET /available`, `GET /modules`,
`POST /modules` and `POST /modules/<id>/rollback` (§7); `GET /secrets`, the names of the Docker
secrets provided, never their values, for a connector's config to name (§4.9; the wiring leaves out
`web_ui_password` and `bot_os_key`, the shell's own). Ids and names in a path may be URL-encoded.
The control API is the owner's alone: no agent is ever given it (P11), so no agent installs a module
(P1).

**The web UI's login** (`packages/web/src/server/auth.ts`, bot-os.md D45): one password, the
`web_ui_password` secret; a session is a random token in an `HttpOnly`, `SameSite=Strict` cookie
(`Secure` over HTTPS) that lasts 30 days from its login, the cookie's `Max-Age` to match. The
sessions outlive a restart, kept in the core's own store as `<data>/core/web-sessions.json`, written
atomically:
`{"version": 1, "password": {"salt", "hash"}, "sessions": {"<sha256 of a token>": <expiry in ms>}}`,
never a token nor the password (`hash` is a salted scrypt of it). A start with another password ends
every session; `POST /api/logout` ends its own; expired ones are pruned. `GET /api/session` answers
`{"authenticated", "boot"}`, `boot` a random id per process.

### 4.12 The graph printed and drawn

`packages/core/src/graph-view.ts`: `graphText` prints the nodes and the edges
(`irc.chat → dice.channel (chat-in): reads #lobby`); `graphMermaid` draws a Mermaid flowchart, left
to right, a box per node (and a second, `<id> · out`, for a connector that chat-out edges reach, so
that the sends flow left to right too) and an arrow per edge, coloured by its port type;
`writeGraphFile` writes a graph to `<dir>/graph.json` atomically, the one before kept as
`graph.previous.json` when it changed. `packages/core/tools/graph.ts [file] [--mermaid]` prints a
graph file, a version 1 file as version 2.

**The graph editor** (bot-os.md D47, D55) is the web UI's home page (`packages/web/src/ui/graph/`),
drawn with React Flow. It edits a draft of the saved graph (`GET /graph/file`), each node drawn from
its plugin as `GET /available` describes it (`describePlugin`: its version, description, kinds and
account, its input and output ports, the reads, actions and commands its `interface` declares, and
the JSON Schemas of its `config`, its `settings` and its actions' inputs and outputs and reads'
outputs, zod's `toJSONSchema`), with the node's own id, account and config; the port types' looks
come from `GET /graph/view` (`PORT_TYPE_INFO`). It polls `GET /status` and `GET /drift` for each
node's live state, mode and drift. Each change of the draft is checked (`POST /graph/check`) and
every problem shown where it is located (§2.3). A node's config starts filled with its schema's
defaults (nested objects within), written to the draft as if typed; a node opened shows the defaults
of the fields its config leaves unset filled in, unmarked, and writes them with its first change, so
that merely opening a node changes nothing. A field's description is its help. A node selected shows
its forms, editable, a key of `configSecrets` as a choice of `GET /secrets`; an edge selected, what
it carries: a chat-in edge its `reads` alone, a chat-out edge its `sends` and `commands`. A
connector is drawn as two cards (`cards.ts`, bot-os.md D60), one node in the graph all the same: its
**in** card (`telegram-user · in`) at the left, with its chat-in output and its other ports, and its
**out** card (`telegram-user · out`) in a column of its own at the right, with its chat-out input,
where the senders' edges end. Each card is placed on its own; selecting either selects the node and
opens its panel (the other card shows itself selected too); removing it removes both, after a
confirmation that names them. The split lives in the editor's view alone: the graph file holds one
node. Each edge has a rhombus at its midpoint in its port type's colour (`PortEdge.tsx`, React
Flow's `EdgeLabelRenderer`), a button named after the edge (`edge irc.chat → dice.channel`) that
selects it and opens its panel, by a click or the keyboard. Its review shows the diff and two
actions: Apply, `PUT /graph/file` then `POST /restart` (none if the core refuses the graph, which
the review says, nor if the saved graph is what runs already), and Revert, the draft back to the
saved graph; a banner offers Apply (`POST /restart`) when the saved file differs from what runs
(`differs`). After a restart the page waits on `GET /session` for the new process (another `boot`
id), and comes back to the page, still logged in. One or several running nodes selected can be
killed, each by `POST /plugins/<id>/kill`.

### 4.13 The standard services

What every plugin needs and none should implement again (bot-os.md D49, D52): the shell implements
it once, as a higher-order call, with whatever npm dependencies or native binaries it takes, so that
a module, which has none of its own, is written in those terms. Two kinds, by what they reach:

- **In the context,** for a service that reaches nothing outside the process and costs nothing:
  every plugin has it, with no edge.
- **Through a connector,** for a service that holds a credential or spends money: the connector
  holds the secret (P9), and a plugin reaches it through an interface input that an edge binds
  (§2.1), so that the edge is the permission and the graph shows who spends.

**SVG to PNG** (`ctx.render`, `packages/core/src/render.ts`), in the context:

```ts
interface Render {
  svgToPng(svg: string, options?: SvgToPngOptions): Promise<Uint8Array>;
}
interface SvgToPngOptions {
  width?: number; // the picture's width; its height follows the SVG's proportions
  height?: number; // without width: its height; its width follows
  scale?: number; // without either: the zoom on the SVG's own size, 1 by default
  maxSide?: number; // the longest side at most, shrinking to fit (2560 for a Telegram photo)
  background?: string; // a CSS colour; transparent without one
  fonts?: readonly string[]; // font files (.ttf, .otf), by absolute path
  defaultFontFamily?: string; // for text that names no family, or none loaded
  systemFonts?: boolean; // the host's fonts too: false by default
}
```

On resvg (`@resvg/resvg-js`, a native binding with prebuilt binaries for `linux/amd64` and
`linux/arm64`, loaded at the first render), rendered on libuv's thread pool rather than the event
loop. It loads no system font unless asked, so that a picture looks the same on every host; the
image has none, so a plugin that draws text ships its font files (a module, in its directory:
`fileURLToPath(new URL('fonts/Example.ttf', import.meta.url))`) and names them in `fonts`. An SVG it
cannot read, or a size that is not a positive number, rejects with why. `CoreOptions.render`
replaces it (a test's stub); the dev kit's core has the real one.

**Asking an LLM** (`ask`, the `anthropic` connector, §5), through a connector. A plugin declares an
interface input bound to it, and asks through it:

```ts
inputs: { llm: { type: 'interface', plugin: 'anthropic', members: ['actions.ask'] } },
// …
const { actions } = ctx.use<{ actions: { ask: Ask } }>('llm');
const r = await actions.ask({ system: 'You score dice rolls.', prompt, schema: Score });
if (r.ok) use(r.output); // typed by the schema; else r.error says why
```

```ts
interface AskRequest<T> {
  system?: string; // the fixed instructions, cached by the API between the calls that share them
  prompt: string; // the user's turn
  model?: string; // the configuration's `model` by default (claude-opus-5-5)
  maxTokens?: number; // the configuration's `maxTokens` by default (16000)
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; // the configuration's, or the model's
  cacheTtl?: '5m' | '1h'; // how long the system prompt stays cached; the configuration's (5m)
  schema?: z.ZodType<T>; // structured output: the answer must fit it, and is returned parsed
}
type AskResult<T> =
  | { ok: true; text: string; output?: T; model: string; usage: AskUsage }
  | { ok: false; error: string; usage?: AskUsage };
// AskUsage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
```

`ask` never throws: a refusal (`refused`), an answer cut short (`answer cut short`), an answer that
does not fit the schema (`unreadable answer`) and an error of the API or the network
(`API error 429 …`) are failed answers, so that a plugin's loop survives them. The owner may call it
too, as the action `ask` of the control API (without a schema, which JSON cannot carry).

### 4.14 From closures to the context

An entry point used to hand plugin factories closures of its own; a plugin built from its config
alone (§4) finds each in its context, its config or an edge:

| A factory was given                                    | A plugin now uses                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| the bot messages of the whole log, read once           | `ctx.events.read({ type: '<ns>.message' })`, when its store keeps nothing yet (a fresh instance)                        |
| the bot messages of the last hours, to replay          | `ctx.events.read({ type, since: ctx.clock.now() - hours * HOUR })` at `ready`, the hours in its config                  |
| the event log's records from one time to another       | `ctx.events.read({ since, until })`, of the namespaces it registers or its events inputs consume                        |
| a log writer                                           | `ctx.bus.publish` for an event others hear, `ctx.record(type, fields)` for a trace of its own                           |
| a print function                                       | `ctx.log.info` (`warn`, `error`): stdout, prefixed with its node's id                                                   |
| `now`, timers                                          | `ctx.clock` (`now()`, `setTimeout`), virtual in tests; durable timers in `ctx.scheduler`                                |
| the account it plays                                   | its config, or `ctx.connector(port).self()`, the connected account's own name                                           |
| a group or a chat to post in                           | its config names it, and its chat-out edge carries it in its `sends` (the outbox refuses any other)                     |
| an LLM's ask function                                  | an interface input bound to the `anthropic` connector, `ctx.use(port).actions.ask` (§4.13)                              |
| a drawing function                                     | `ctx.render.svgToPng` (§4.13)                                                                                           |
| another plugin's object (a game, a ledger, a registry) | that plugin's declared interface (`state`, `actions`), through an interface input an edge binds: `ctx.use(port)` (§2.1) |
| a callback on a setting                                | its instance's `settingsChanged`, or the other plugin's action                                                          |
| a credential                                           | only a connector: a secret its manifest declares, or one its config names (`configSecrets`, §4.9)                       |

### 4.15 Reactions

A building block of automation (bot-os.md D58): when something happens, send a command.
`react(ctx, reaction)` (`packages/core/src/react.ts`, imported from `@megabottron1999/core` by any
plugin, a module's too) reacts until the function it returns is called; a plugin calls it as often
as it likes, and stops each reaction as its conditions change. The `reactor` (§5) is one reaction
made from its node's config.

```ts
import { react } from '@megabottron1999/core';

const stop = react(ctx, {
  on: 'quest.turn', // an event type or a namespace; or { port?, chats?, match } for messages
  when: { 'outcome.kind': 'gain', 'outcome.sure': true }, // dotted paths, each equal
  chat: '@QuestBot', // a {path} template, or a function of the payload
  send: '/look {outcome.item}', // the same
  record: 'dice-roller.reaction', // the type of its records: of its plugin's id
});
```

```ts
interface Reaction {
  on: string | { port?: string; chats?: readonly string[]; match: string | RegExp };
  when?: Record<string, unknown>;
  chat: string | ((payload: ReactionPayload) => string | undefined);
  send: string | ((payload: ReactionPayload) => string | undefined);
  via?: string; // the chat-out output whose outbox it sends through: `chat` by default
  record: string; // ctx.record's type for each reaction
  name?: string; // in its records, and the send's origin in `core.send`: `react` by default
  maxAgeMs?: number; // how old an event may be and still be reacted to: 2 minutes by default
}
```

- **On an event:** `on` is an event type (`quest.turn`) or a namespace on the bus, one its events
  inputs consume or its own (§4.4), heard from the nodes its edges bind. Its payload is the event as
  published, `{ type, t, instance, ...payload }`. An event older than `maxAgeMs` (a parser's replay
  of its history at `ready`) is skipped, and recorded, so that history is not acted on again.
- **On a message:** `on` is `{ port, chats, match }`: the messages read on the chat-in input `port`
  (`chat` by default), in `chats` (compared without case; every chat its edge reads without), whose
  text contains `match` (a string) or matches it (a `RegExp`). Messages played back and the
  account's own are never reacted to. Its payload is `{ chat, sender, text, time, id?, replyTo? }`,
  with the regular expression's named groups beside them (`(?<item>\w+)` is `{item}`; a group of one
  of those names is shadowed).
- **When:** each field of `when`, by dotted path (`outcome.kind`, `outcome.tags.0`), must equal
  (`===`) its value; without it, every payload.
- **Send:** `chat` and `send` are texts whose `{path}`s are replaced by the payload's values there,
  or functions of the payload. A path with no value (or one that is not a string, a number or a
  boolean), or a function that makes no text, sends nothing: the reaction is skipped and recorded
  (`reason: "no value at outcome.item"`), never sent half made. Text in braces that is not a path is
  kept as written.
- **Through the outbox:** each send is `ctx.outbox(via).enqueue(chat, text, { origin: name })`,
  through its chat-out output `via`, so the plugin's mode, its edge's reach (the chats it `sends`
  to, its `commands`), the account's pacing and the `core.send` log all apply (§4.6).
- **Recorded:** each reaction is written with `ctx.record(record, …)`:
  `{ reaction, on, outcome, reason?, chat?, text? }`, its outcome the outbox's (`sent`, `dry-run`,
  `refused`, with why) or `skipped`.

`react` throws, as the context does, for a namespace no events input of the plugin consumes, an
event type nobody registers, and a message trigger on a chat-in input no edge binds. `valueAt`,
`matches` and `fill` (the dotted paths, `when` and the templates) are exported beside it.

## 5. The shell's own plugins

| Plugin          | Kinds     | Package                       | What it is                                                                                       |
| --------------- | --------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `irc`           | connector | `@megabottron1999/connectors` | An IRC account through a ZNC bouncer, with its flood limits and a health endpoint                |
| `telegram-bot`  | connector | `@megabottron1999/connectors` | A Telegram bot (grammY), and the owner's chat surface                                            |
| `telegram-user` | connector | `@megabottron1999/connectors` | A Telegram user account (GramJS), reading and sending in the chats of its configuration          |
| `anthropic`     | connector | `@megabottron1999/connectors` | The Claude API: `ask`, with structured output (§4.13)                                            |
| (service)       | connector | `@megabottron1999/connectors` | `ServiceConnector`: the connector of a plugin that holds secrets for an API client, no chat      |
| (turn parsers)  | parser    | `@megabottron1999/turns`      | `turnParserPlugin`: a parser of one game bot's answers to turns, from a grammar a game gives     |
| `turn-actor`    | actor     | `@megabottron1999/turns`      | One game bot's turns, at a person's pace, run as one instance per bot                            |
| `reactor`       | actor     | `@megabottron1999/turns`      | One reaction (§4.15) from its config: a command sent when an event is heard or a message matches |

- **`irc`** (`packages/connectors/src/plugins/irc.ts`, on the IRC client of
  `packages/connectors/src/transport/irc-client.ts`): one IRC account through ZNC, its configuration
  the ZNC login (`host`, `port`, `tls`, `zncUser`, `zncNetwork`), the `nick`, the `channel` and the
  rate limiter (`minIntervalS`, `maxPerHour`); its password is the `znc_password` secret. It opens
  one connection however often it is started (networks' clone limits). It logs each line of the
  channel, played back or live, as `irc.line`, and each step of the connection as `irc.status`. With
  `healthPort` it serves `GET /health`: 200 while it is in the channel, 503 when not.
- **`telegram-bot`** (`packages/connectors/src/plugins/telegram-bot.ts`, on grammY in
  `packages/connectors/src/transport/telegram-bot.ts`): a bot, made from its `telegram_bot_token`
  secret at `create` (with auto-retry), connected and polling at `start` with retries (a backoff
  capped at ten minutes). Its status is `connecting` until `getMe` answers, `connected` while it
  polls; its own name is the bot's username. It hears every message Telegram delivers the bot and
  sends through the account's outbox (`deliver`, to a chat id or an `@username`; a 429 longer than
  auto-retry waits out becomes `FloodWait`). Configured with the owner's Telegram user id and
  optionally a group (`owner`, `group`, in its node's config), it is the instance's chat surface,
  and the owner's chat that the core sends the owner's notices to (§4.8, bot-os.md D56)
  (`telegram-surface.ts`): the switchboard on its bot (`telegram-switchboard.ts`, on
  grammy-switchboard), the plugins' commands answered in the group, the owner's chat and any other
  private chat (`telegram-commands.ts`), the menus kept registered, and the owner's notices carried
  in order (`telegram-notifier.ts`). Nothing hands its bot out (P9).
- **`telegram-user`** (`packages/connectors/src/plugins/telegram-user.ts`, on GramJS in
  `packages/connectors/src/transport/telegram-user.ts`): the owner's own account, from three secrets
  (`telegram_user_api_id`, `telegram_user_api_hash`, `telegram_user_session`). It reads only the
  chats of its configuration (`chats`: a group by its id, a private chat with a bot by the bot's
  `@username`, P3), since the account sees every chat of its owner. It starts without waiting,
  retries every minute, and tells the owner of the first failure; a message carries its id, the one
  it replies to, and `own` for the owner's own from any device. It sends only through the account's
  outbox (`deliver`, with the message's id); GramJS's flood waits become `FloodWait`.
- **`ServiceConnector`** (`packages/connectors/src/plugins/service.ts`): for a connector plugin that
  holds an account's secrets and offers what it makes from them through its declared interface, but
  has no chat: it reads and sends nothing. The `anthropic` connector is one.
- **`anthropic`** (`packages/connectors/src/plugins/anthropic.ts`, on the Anthropic SDK): the Claude
  API's account (`anthropic:api`, or the name it is given), made from its `anthropic_api_key` secret
  at `create`, a `ServiceConnector`. Its configuration holds the defaults of `ask` (§4.13): `model`
  (`claude-opus-5-5`), `maxTokens` (16000), `effort` (unset: the model's own) and `cacheTtl`. It
  offers `ask` as its interface's action, for the plugins an edge binds to it. A system prompt is
  sent with a cache breakpoint, so calls that share one pay for it once; `cacheTtl` says how long it
  stays cached: `5m` (the API's default) or `1h`, for calls more than five minutes apart (writing it
  costs more, reading it the same), and a request may ask its own.
- **`turnParserPlugin`** (`packages/turns/src/turn-parser.ts`): one parser plugin per game bot, each
  made from its bot's grammar (`read`), which knows the game. Each reads, on the owner's account
  (`telegram-user`), the private chat with its bot and, when its edge also reads it, the game's
  group: a `chat-in` input only, with no way to send. It knows the owner's turns (a turn command of
  its configuration, `commands`, bare or addressed to its bot, sent by hand from any device; and
  those its actor sends, told through its action `sent`, since the account never sees its own sends
  come back), and which of its bot's messages answer one: a reply to it or, in the private chat, the
  first message within two minutes of it. What it reads it publishes as `<id>.turn`
  (`{ chat, outcome }`); a message it claims and cannot read goes to drift (§4.7) and is published
  as an `unknown` outcome. Its read `rest` says until when the bot rests, from its last answer. The
  tests play a made-up @QuestBot (`packages/turns/test/quest.ts`).
- **`turn-actor`** (`packages/turns/src/turn-actor.ts`): one plugin run as one instance per game bot
  (P3, P17), each with its own id, configuration, store, timer and mode. Its ports: `chat`, a
  chat-in input on `telegram`, which reads the private chat with its bot (for the turns the owner
  sends by hand), and `chat`, a chat-out output, which sends there (its command only); and `parser`,
  a contract (`state.rest`, `actions.sent`) bound to its bot's parser, required, so that drift on
  the parser pauses it. (Its read is to go, its parser telling it of the turns sent by hand, #21.)
  Its configuration: `chat` (the bot's `@username`), `command` (the bot's turn command; `/play` when
  unset), `schedule` (the planner's pace, each field with its default in the schema,
  `DEFAULT_SCHEDULE` of `packages/turns/src/schedule.ts`: 17–20 minutes between turns, some skipped,
  nights off in its `timeZone`), `nightSalt` (the instances with one salt sleep the same nights) and
  `seed`. It plans from the owner's last turn with the bot (kept in its store; a turn sent by hand
  counts too), as the durable timer `turn` (dropped if it came due more than 10 minutes before a
  start); when it is due, it asks its parser whether the bot rests and, if so, comes back a few
  minutes after; in `live` it waits for the account to be connected, sends through its outbox and
  tells its parser the message's id; a failed send is tried again two minutes later. It plays in
  `dry-run` and `live` only (a new instance starts `dry-run`, D33). It declares no chat command,
  since two instances would clash: the owner reaches each with `/plugins <id>` and its read
  `status`. Each step is published as `turn-actor.step`. The image offers it (`src/main.ts`): the
  editor adds one node per bot, each on its own instance, its `chat` edges from and to the owner's
  `telegram-user` node and its `parser` edge to its bot's parser. The turn parsers are not the
  image's: each is made from a game's grammar, so a game's module offers it.
- **`reactor`** (`packages/turns/src/reactor.ts`): one reaction (`react`, §4.15) made from its
  node's config, with no code, run as one instance per reaction. An actor: it starts `read-only`,
  and the owner sets its mode. Its configuration (`reactorConfig`): `on`, the event type it reacts
  to (or a namespace), or `match`, a regular expression the messages read on its chat-in input must
  match (its named groups in the payload), with `in` (the one chat whose messages it reads; every
  chat its edge reads without) and `ignoreCase`; exactly one of `on` and `match`. Then `when`
  (dotted paths of the payload, each equal to its value), `chat` and `send` (`{path}` templates of
  the payload), and `maxAgeS` (how old an event may be, 120 seconds by default). Its ports: `chat`,
  a chat-out output, the account it sends through (on any network), whose edge carries the chat it
  sends to and its commands; `chat`, a chat-in input there only with `match`
  (`when: { config: 'match' }`, §2.1), the chats it reads; and `events`, optional, whose namespace
  is the one of its `on` (§2.1): bound to the nodes whose events it hears, and not a port at all of
  a reactor on messages. So a reactor on events only sends. Each reaction is recorded as
  `reactor.reaction`, and each send logged as `core.send` with the node's id as its origin. The
  image offers it (`src/main.ts`); a node that examines what a game's parser reads, in the graph
  file:

  ```json
  {
    "nodes": [
      {
        "id": "look-gains",
        "plugin": "reactor",
        "config": {
          "on": "quest.turn",
          "when": { "outcome.kind": "gain", "outcome.sure": true },
          "chat": "@QuestBot",
          "send": "/look {outcome.item}"
        }
      }
    ],
    "edges": [
      {
        "from": "look-gains.chat",
        "to": "tg.chat",
        "type": "chat-out",
        "sends": ["@QuestBot"],
        "commands": ["/look"]
      },
      { "from": "quest.events", "to": "look-gains.events", "type": "events" }
    ]
  }
  ```

## 6. Boundaries

- `packages/core/src/` imports nothing of any game, nor any other package: ESLint refuses imports of
  the other workspaces there. Its npm dependencies are zod and resvg (the render service, §4.13).
- A plugin reaches the core only through its context; it never imports `packages/core/src/`
  internals, only its public API (`@megabottron1999/core`, its `src/index.ts`), and the subpaths the
  packages export (`@megabottron1999/<name>/<path under src/>`).
- Production code never imports test helpers (`#test/*`, `@megabottron1999/<name>/test/*`): ESLint
  refuses it.
- The web UI's React app (`packages/web/src/ui/`, D43) reaches the instance through the control API
  only, and imports the core's types alone (`import type`; ESLint refuses a value import of the
  shell there), so its bundle holds none of the shell's code and no game.
- Nothing in this repository names a game other than the made-up ones of its tests, a person, a
  chat, or a host (CLAUDE.md).

## 7. Modules

Games and automation come as modules (bot-os.md D49, D53): directories of plain `.ts` files, with no
npm dependencies of their own, installed in the data volume and loaded at start. As built:
`packages/core/src/modules.ts` (the manifest, the order), `module-resolve.ts` and `module-hooks.ts`
(the resolve hook), `module-loader.ts` (the loading), `module-store.ts` (install and rollback) and
`semver.ts`.

### 7.1 The format

A module is a directory, `/data/modules/<id>/`, holding its `module.json` and its sources under
`src/`:

```json
{
  "id": "dice",
  "version": "0.1.0",
  "api": "1",
  "provides": "@example/dice",
  "imports": { "@example/dice-rules": "^0.1.0" },
  "plugins": ["src/plugins/roller.ts"]
}
```

| Field         | Meaning                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Lower-case words and dashes; the name of its directory, which must match                                                                                                           |
| `version`     | `MAJOR.MINOR.PATCH`, with an optional pre-release                                                                                                                                  |
| `api`         | The plugin API it targets: the shell's (`PLUGIN_API`, today `"1"`) exactly, or it is refused                                                                                       |
| `provides`    | Its import name, an npm package name: `<provides>/<path>` is `<its directory>/src/<path>`, and `<provides>` alone `src/index.ts`, as a package's `exports` maps `./*` to `./src/*` |
| `imports`     | Optional: the modules it imports, by the name each provides, each with a version range (`1.2.3`, `^`, `~`, `>=`, `<`, `*`, spaces for all, `\|\|` for either)                      |
| `plugins`     | Optional: its plugin entry files, relative to its directory; a module without any is a library for others                                                                          |
| `description` | Optional: one line, for the owner                                                                                                                                                  |

Nothing else is allowed. A module's files import:

- `@megabottron1999/*` and `zod`: the host's own copies, so that a module's plugins, schemas and
  `instanceof` checks are the shell's;
- its own files, relatively, by its `provides` name, or by `#` imports if it keeps its workspace's
  `package.json` (§7.5) in its directory, whose `imports` Node reads;
- the modules its `imports` declare, by the names they provide;
- Node's built-ins.

Anything else is refused when the file is imported, by name: an npm package (a module has no npm
dependencies: what it needs that the shell lacks belongs in the shell, as a standard service,
§4.13), and a module it does not declare.

### 7.2 A plugin entry

Each file of `plugins` exports `plugins`, an array of plugins as `definePlugin` makes them (§1):

```ts
import { definePlugin, type Plugin } from '@megabottron1999/core';
import { z } from 'zod';
import { faces } from '@example/dice-rules/faces.ts';

export const plugins: Plugin[] = [
  definePlugin({
    manifest: {
      id: 'dice-roller',
      version: '0.1.0',
      kinds: ['actor'],
      description: 'Rolls the dice',
      config: z.object({ faces: z.number().default(faces) }),
    },
    create: (ctx) => ({/* everything from ctx, its configuration in ctx.config */}),
  }),
];
```

A plugin of a module is built from its saved configuration alone (bot-os.md D50): what changes from
one use to the next is its `config`, read from `ctx.config`, never the arguments of a factory, so
that the graph's nodes are data the editor can make. Its id is new: one of the image's own (`irc`,
`anthropic`, …) or of a module loaded before is refused.

**Its chats** (§2.1, bot-os.md D60): a plugin that reads a chat declares a `chat-in` input, one that
sends a `chat-out` output, and one that does both, both, under one name if it likes:

```ts
inputs: { channel: { type: 'chat-in', network: 'irc', bind: { node: 'irc', reads: ['#lobby'] } } },
outputs: { channel: { type: 'chat-out', network: 'irc', bind: { node: 'irc', sends: ['#lobby'] } } },
```

`ctx.connector('channel')` hears through the first, `ctx.outbox('channel')` sends through the
second. A module written for the plugin API `"1"` before the split keeps loading unchanged: its
`{ type: 'chat' }` input (and the `requires`/`reach` shorthand's chat) is read as both, a chat-in
input and a chat-out output of its name, its `bind`'s `reads` to the first and `sends` and
`commands` to the second. Its graphs of version 1 are converted as they load (§2.3); code that types
a graph as `GraphInput` writes `version: 2`, and its chat edges each way.

### 7.3 Loading

At start (`src/main.ts`), before the core loads, `loadModules` reads `/data/modules/` (the data
directory's `modules/`, `LOG_DIR`), the hidden directories aside (`.previous/`, `.staging/`), and:

1. reads and checks each `module.json`, and that its plugin entries exist;
2. checks each module's `api` against the shell's, and each import against the installed version of
   the module that provides it;
3. orders the modules so that each loads after those it imports;
4. registers the resolve hook (`module.register`, run on Node's hooks thread) with the table of the
   modules that load: their `provides` names and directories, and the host's file to resolve
   `@megabottron1999/*` and `zod` from;
5. imports each module's plugin entries, in that order, and checks what they export and their
   manifests.

A module that fails any step is refused, by name and with why, and so is every module that imports
it, directly or not; the others load. The reasons read as:
`it targets plugin API 2, and this shell offers 1`,
`it imports @example/dice ^0.2.0, and dice 0.1.0 is installed`,
`it imports @example/nowhere, which no module provides`,
`it imports @example/old, which is refused`, `its imports form a cycle: a → b → a`,
`@example/same is provided by a and b`, `src/p.ts failed to load: …`,
`src/p.ts exports no plugins array`, `its plugin irc is offered by the image already`. The entry
point prints each module loaded and each refused.

The plugins loaded are registered with the core beside the image's (`core.registerModule`), and
`core.available()` lists them all, each with its module: the plugins the instance offers, which the
editor will add as nodes. A plugin runs once a node of the saved graph (§2.3) names it.

### 7.4 Installing, and rolling back

The owner installs a module through the control API (§4.11), never an agent (P1, P11); it is loaded
at the next start (P8). `ModuleStore` (`<data>/modules`):

- **Install** (`POST /modules`): from a directory of the container's (`{"dir": "/path"}`; its `.git`
  and `node_modules` are left behind); from a tarball, `.tar.gz` or `.tar` (base64 in
  `{"tarball": "…"}`, which the web UI's same-origin rule allows; or the bytes as the body, with
  `content-type: application/gzip`, on the loopback); or from a directory's files one by one, as a
  browser reads a folder picked or dropped
  (`{"files": [{"path": "dice/module.json", "content": "<base64>"}, …]}`). Up to 64 MiB: the body,
  and the files' bytes together. The tarball, or the files, hold the module at their root or in
  their one directory (as `git archive --prefix=dice/`, GitHub's release tarballs and a folder
  picked make it), which is stripped. A tarball holds files and directories only, nothing outside
  it; a file's path is relative to that root, with `/` (or `\`) between its parts, and one that is
  absolute, a drive's, or goes through `..` refuses the whole upload
  (`<path> leaves the module's directory`); the files under a `.git` or a `node_modules` directory
  are left behind, as from a directory. It is staged in `.staging/`, checked (its `module.json`),
  and replaces `<id>/`, whose version before is kept as `.previous/<id>/`. 400 with why for what is
  not a module.
- **Rollback** (`POST /modules/<id>/rollback`): `.previous/<id>/` and `<id>/` swap, so a second
  rollback goes forward again; 409 when there is no previous version.
- **The list** (`GET /modules`): each module installed (its manifest, or why it does not read), the
  version kept for a rollback (`previous`), the version the running instance loaded (`loaded`), the
  modules it refused at its start with why (`failures`), and whether a restart would change what is
  loaded (`restart`). `GET /available` lists the plugins the instance offers, each as the editor
  adds a node of it (`describePlugin`, `PluginView`): its id, its module (none for the image's own),
  version, description and kinds, its account, its input and output ports, its interface, the JSON
  Schemas of its config and settings, the secrets it declares, the keys of its config that name one
  (`configSecrets`), and the event types it registers.

From the host, through the loopback: `docker cp dice/ megabottron1999:/tmp/dice`, then
`docker exec megabottron1999 wget -qO- --header 'content-type: application/json' --post-data '{"dir":"/tmp/dice"}' http://127.0.0.1:8081/modules`,
and restart it (`POST /restart`). The web UI's Modules page does the same: it lists them, installs
one from its folder (**Choose folder**, or the folder dropped on the page: it reads the folder's
`module.json` and shows its id, version and description for the owner to confirm, leaves out `.git`
and `node_modules`, and sends the rest as `files`) or from an uploaded `.tar.gz` (sent as base64),
rolls one back, and offers the restart.

### 7.5 Developing a module against MegaBotTron1999

A module repository vendors this repository as a git submodule, pinned to a tag, and makes its
packages workspaces of its own, so that its modules are written, type-checked and tested against the
very shell they will run in:

```sh
git submodule add https://github.com/djjeck/MegaBotTron1999 vendor/MegaBotTron1999
git -C vendor/MegaBotTron1999 checkout v0.1.0 && git add vendor/MegaBotTron1999
```

```json
{
  "name": "example-modules",
  "private": true,
  "type": "module",
  "workspaces": [
    "vendor/MegaBotTron1999/packages/core",
    "vendor/MegaBotTron1999/packages/connectors",
    "vendor/MegaBotTron1999/packages/turns",
    "packages/*"
  ]
}
```

- **Each module is a workspace package** (`packages/dice/`), named as its `provides`
  (`@example/dice`), with `exports` `{ "./*": "./src/*" }` and `imports` `{ "#src/*": "./src/*" }`
  as this repository's packages have, and its `module.json` beside its `package.json`. So the same
  imports resolve in development (through npm's workspaces) and in the instance (through the hook).
  Its `dependencies` name `@megabottron1999/*` and `zod` at the versions the vendored shell pins,
  and other modules of the repository: they are for development only, and the loader ignores them.
- **Leave out `vendor/MegaBotTron1999/packages/web`**: the web UI's build tools are its own
  `devDependencies`, and a module needs only its types, which it does not import.
- **TypeScript:** extend the vendored configuration, which the shell's sources need as they are
  (strict, `erasableSyntaxOnly`, `.ts` imports), with the repository's own `include`:
  `{ "extends": "./vendor/MegaBotTron1999/tsconfig.json", "include": ["packages"] }`.
- **Tests:** Vitest, with the dev kit (§4.10) from `@megabottron1999/core`; exclude `vendor/**` from
  the repository's own runs, since the shell's tests are its own.
- **Loading as the instance does:**
  `node vendor/MegaBotTron1999/packages/core/tools/modules.ts packages/dice packages/dice-rules`
  links the modules given into a temporary modules' directory, loads them through the resolve hook,
  checks their plugins' manifests, prints each module with its plugins and each refused with why,
  and exits 1 if any is refused (`--installed [dir]` checks a modules' directory as it is). It
  catches what the workspaces allow and the instance does not: an npm package imported, a module not
  declared in `imports`.
- **Shipping:** `git archive --prefix=dice/ -o dice.tar.gz HEAD:packages/dice` makes the tarball of
  one module, for `POST /modules`.

Upgrading the shell is moving the submodule to a newer tag; a module that targets another plugin API
than the instance's is refused at start, by name. Moving past the split of chat edges (bot-os.md
D60, `v0.1.0-alpha.7`) changes no module's plugins (§7.2), but a module's own code or tests that
write a graph typed as `GraphInput` change it to `version: 2`, each `chat` edge as a `chat-in` edge
(its `reads`) and a `chat-out` edge from the plugin to the connector's `chat` (its `sends`,
`commands`); untyped, a version 1 graph still loads, converted.

## 8. Importing from an older MegaBotTron1999 data directory

An instance from before the graph lived in the volume kept its state by plugin, not by instance. Its
data directory, mounted read-only into the new container (`LEGACY_DIR`, `/legacy` by default), can
be imported from, one store at a time and its event log (bot-os.md D54). Nothing writes to it. As
built: `packages/core/src/legacy.ts` (`LegacyImport`).

**The older layout:**

| Path                    | What it holds                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/<id>/`         | A plugin's store, by its plugin's id: documents `<name>.json`, and the core's `_meta.json`, `_timers.json`, `_settings.json`, `_restore.json` |
| `plugins/core/`         | The core's own: `modes.json` (every plugin's mode), `power.json` (the off switch), `secrets/`                                                 |
| `events-<day>.jsonl`    | The event log, a file per UTC day, one JSON record per line; records of before types were namespaced have plain types (`message`)             |
| other files at the root | What an older entry point kept itself; not imported                                                                                           |

**The control API** (§4.11), the owner's alone; each says so (404) when no directory is mounted:

- `GET /legacy`: what it offers: each store (`plugins/<id>/` but the core's) with its documents, its
  schema `version`, its `timers`, whether it keeps `settings`, and the `mode` it had; and its event
  log's days (`days`, `first`, `last`).
- `POST /instances/import {"from": "<store>", "instance"?: "<id>", "plugin"?: "<id>"}`: copies the
  store's JSON documents, the core's beside them, into a fresh instance (`instances/<instance>/`,
  `from` by default), of a plugin the instance offers (`from` by default), which a node then names
  (§2.2). Its version comes with it, so its plugin's migrations run from there; its timers and
  settings come too; its mode does not (P10): the instance starts `read-only`, or in its node's
  `mode`. 409 for an instance kept already, 400 for an unknown plugin. An instance no node uses is
  deleted after 7 days, as any.
- `GET /legacy/events`: the types of its event log that are not namespaced (those an import would
  skip), each with how many records have it and the event types registered here whose name after the
  namespace is it (`suggest`: `message` → `dice.message`, where a plugin registers `dice.message`),
  for the owner's table of renames: one suggestion is the rename to give, several a choice, none a
  name to type. Nothing is guessed beyond that.
- `POST /legacy/events/import {"types"?: {"<old>": "<ns>.<name>"}, "since"?: <ms>}`: merges its
  event log into this instance's, day by day, from the day of `since`: each record once (a record
  there already is not added again, so the import may be run again), its type renamed by `types`,
  each day's file rewritten in time order. A record whose type is still not namespaced is left out
  and counted by its old type (`skipped`), for the owner to give its name and import again. It
  answers the `days` read, the records `imported`, those `present` already, and those `skipped`. The
  records imported carry no `instance` (§4.4): every reader of their namespace reads them.

From the host: mount the older volume read-only (`-v old-data:/legacy:ro`), `GET /legacy`, import
each store a node will use and the event log, save the graph that names those instances
(`PUT /graph/file`), and restart (`POST /restart`). In the web UI: a store is imported as the
instance of a node as the node is added in the graph editor, and the event log from the Import page,
its table of renames started from `GET /legacy/events`.
