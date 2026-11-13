# MegaBotTron1999: the plugin API

Documented as of 12 Nov 2026. The plugin model of MegaBotTron1999 ([bot-os.md](bot-os.md)): what a
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
| `node`          | Optional: each node's own manifest, from its config and its id, for a plugin whose ports its node's config declares (below, bot-os.md D74)                                                                                                                                                                                            |

A connector's manifest also names its **account** (§4.5): the network and the identity it holds.

**A node's own manifest** (bot-os.md D74): a plugin whose ports its node's config declares (a script
node, §5) gives `node(config, id)`, which makes each node's manifest from its config (as the schema
makes it; as written when the schema refuses it, the load then saying why) and its id. What it
returns is checked as any manifest, and must be of the plugin's id; another id, or a manifest
refused, is the node's problem (`node look: bad manifest: inputs.heard…`), and the plugin's own
stands in for it. The node's ports, kinds, registered namespaces and event types are then its own
everywhere: the check and its edges, the bus, the drift, the queue, the log's reads, `GET /status`,
and the editor, which draws the node as `POST /graph/check`'s `views` say its draft config declares
it (§2.3). `core.available()` (`GET /available`) describes the plugin's own.

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
other is running. A read may declare an `input`, a zod object whose fields are its arguments
(bot-os.md D72): its function is called with it (`state.get({ path: 'inventory.items' })`), the
owner's controls parse it against the schema, and the control API takes it from the query
(`GET /plugins/<id>/state/get?path=inventory.items`); a read without one is called with none.

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
owner), outside the plugin's outbox. What a plugin sends on its own goes through its outbox, within
its chat-out edges, each sending for real or as a dry run (§4.6). The surface is a connector's
(`ChatSurface`): the core serves every running connector that offers one the commands (`serve`),
once every plugin has started.

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
| `chat-in`   | `chat`: a connector's account, of its network (derived)                                    | `{ type: 'chat-in', network?, when? }` (declared); its edge carries the chats it `reads` and its `senders`                    |
| `chat-out`  | `{ type: 'chat-out', network? }` (declared in `outputs`); its edge carries what it `sends` | `chat`: a connector's account (derived), bound to any number of senders; their edges carry the chats sent to and `commands`   |
| `events`    | `events` (`<ns>-events` with more than one): each namespace it registers (derived)         | `{ type: 'events', namespace }`, bound to any number of instances; it hears only theirs; `namespace` may be `{ config: key }` |
| `interface` | `interface`: its declared reads and actions (every plugin has one, derived)                | `{ type: 'interface', plugin, members }`; none for a plugin it only needs started first; no `plugin`: a contract              |

**Chats flow left to right** (bot-os.md D60): only parsers read chats, actors only send, and
everything else consumes events and interfaces. A chat-in edge runs from a connector's chat-in
output, `chat`, to a reader's chat-in input, on its left: the chats it hears (`reads`). A chat-out
edge runs from a sender's chat-out output, on its right, to the connector's chat-out input, `chat`:
the chats it may send to (`sends`) and the commands it may send there (`commands`, by first word;
none: any text), with, for its queued sends, the least seconds between two sends of a command in one
chat (`minIntervalS`, `{ "/inventory": 300 }`, by first word; a command not named, the connector's
`commandIntervalS`: §4.6, bot-os.md D73). A chat-out output may **declare the commands it sends**
(`commands`, by first word) and their spacing (`minIntervalS`), as a script node's do (bot-os.md
D74): the check refuses an edge from it that allows another command, or any text
(`node look: output port chat sends only /look: its edge allows /buy too`); a new edge drawn from it
starts with them; and its queued sends are spaced by its declared intervals, its edge's own winning
for a command it names. A connector has both, as one node (one account, one session); the editor
draws it as two cards (§4.12). A connector's chat-out input takes any number of senders; a sender's
chat-out output, one edge, required unless `optional` (the connector starts first, and an unbound
required one fails the start: `node actor: output port chat (chat-out of irc) is not bound`). A
port's `network` (`irc`, `telegram`) is matched against the connector's account, as it was for a
chat. `ctx.connector(port)` hears through a chat-in input, and `ctx.outbox(port)` sends through a
chat-out output (each also by the connector's id or its account).

**What a chat-in edge reads** (bot-os.md D62) has two independent parts: `reads`, a list of chats or
`"*"`, any chat its connector monitors (§4.5); and `senders`, a list of senders by username
(`@QuestBot`, compared without case and without the `@`; a bot's username never changes, so it is
not resolved to an id), with `me` for the account's own messages; without `senders`, anyone. An edge
written before has no `senders`, so it reads from anyone as it did: nothing converts. The edge field
is `senders`, not `from`, since an edge's `from` is its output end. _Any chat from anyone_ is
allowed, and the editor flags it as broad. Sending stays explicit: a chat-out edge lists its chats.

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
(`{ node, reads, senders? }` for a chat-in, from the connector `node`; `{ node, sends, commands }`
for a chat-out, to it; `{ node }` for an interface, by default the node of the plugin's id;
`{ nodes }` for events, by default every other node registering the namespace). The manifest's older
fields stay as shorthand, read as ports: a `requires` that `reach` names is a required chat (a
chat-in input and a chat-out output, as above) named after the connector, with the reach's chats and
commands as its binding; any other `requires`, and each plugin `uses` names, a required interface
input named after it; `games.consumes` an optional events input, `<namespace>-events`; a `reach` not
required, an optional chat. A plugin's code names its ports: `ctx.connector('channel')`,
`ctx.outbox('channel')`, `ctx.use('game')`.

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
      "from": "irc.chat",
      "to": "log.chat",
      "type": "chat-in",
      "reads": "*",
      "senders": ["@DiceBot", "me"]
    },
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
its plugin's `settings`) its instance starts with: they are put in force only while the instance
keeps none of its own, so the owner's later changes win. A node may be `"disabled": true` (absent:
enabled), and a chat-out edge `"dryRun": true` (absent: live): see **Node states** below. A node may
name the `group` it is drawn in, a swimlane of the editor (bot-os.md D69, §4.12): any name, not
empty and without spaces at its ends (`"group": "Quest"`; absent: none); the check accepts it, and
nothing that runs reads it. An edge goes from `node.port` (or `node`, when one of its outputs fits)
to `node.port`, with its type and, for a chat, what it carries: a chat-in its `reads` and `senders`,
a chat-out its `sends` and `commands` (each carries only its own). The core checks it with zod and
against the manifests at load, and fails the start naming the node and the port: a plugin not in the
image, a node twice, an instance named by two nodes or kept by another plugin
(`node b: its instance tally is of the plugin other, not counter`), a setting the plugin does not
have or refuses, an edge between ports of two types or to a port that is not there, an interface
member not declared, a single input (or a chat-out output) bound twice, a connector account held
twice, a required input or chat-out output unbound
(`node actor: input port channel (chat-in of irc) is not bound`), a cycle of required edges.

Each instance has its own id (`ctx.id`), configuration, store, settings, state, timers and drift;
its log lines, its records and the owner's controls name the instance (`PluginControl.plugin` names
its plugin). Two instances of one plugin publish its event types, each heard only by the instances
its edges bind; two whose commands share a name fail the load.

**Node states** (bot-os.md D64). A node is in one of four states, which replaced the modes
(`read-only`, `dry-run`, `live`) of before:

- **Enabled**, the default: it starts and runs with all its edges allow.
- **Disabled** by the owner: `"disabled": true` on the node. Never started; its config and edges are
  checked all the same, and it survives restarts, being in the graph.
- **Stopped**, by exception: a safety stop (`ctx.stop`, or module API 1's
  `ctx.mode.set('read-only')`), drift (§4.7), the owner's kill in the editor or stop from Telegram's
  `/plugins` (§4.11). Kept in its instance (§2.2) as `_stop.json`,
  `{ "reason": "killed by the owner", "time": "2026-11-12T10:00:00.000Z", "source": "owner" }`
  (`source`: `safety`, `drift` or `owner`), so it survives restarts: the node is not started while
  it is there. The owner clears it in the editor, a change of the draft that Apply makes
  (`POST /plugins/<id>/clear-stop`, then the restart). A stop made while the node runs takes effect
  at once: its outbox refuses its sends (`stopped: <reason>`), its `pause` hook is called, and
  module API 1's `ctx.mode` listeners hear `read-only`; and every node it makes inactive (below) is
  shut down at once (bot-os.md D65).
- **Inactive**, derived at the load, never stored: a node a **required** port of which (an input, or
  a chat-out output) binds a node disabled, stopped or inactive, transitively, is not started, and
  says why (`GET /status`: `state: "inactive"`, `reason: "needs tg (disabled)"`). A stop made at
  runtime applies the same rule at once (D65): each node it makes inactive, running or not started
  yet, is so from then on, with the same reason (`needs actor (stopped)`), dependents shut down
  first, as the instance's stop does: its messages, events and timers cut at once, its `serialise`
  kept, then its `stop` called. Its outbox refuses its sends (`not running (inactive)`). Clearing
  the stop brings them back with it, at the restart. An **optional** port bound to such a node
  counts as unbound: its node runs, and `ctx.useOptional` gives undefined. A connector is one node:
  disabled, every node reading from it or sending to it through a required port is inactive.

A plugin that fails (§3) is `failed`, with why, as before, and is not kept so across restarts. Every
change of a state (enable, disable, a stop cleared, an edge's dry run) is the editor's, a change of
the draft applied with Apply (a restart); nothing raises a state at runtime. **A dry-run edge**
(`"dryRun": true` on a chat-out edge): what the plugin sends through it is logged as sent
(`core.send`, outcome `dry-run`, counted in the account's rate as a send) and never sent; the plugin
sees it sent (§4.6). It covers messages only: a model's calls stop when its node is disabled. In the
editor a new node starts disabled, for the owner to set its config first, and a new chat-out edge
starts a dry run.

**The first start since the modes** (at most once; `core/node-states.json` marks it done): each
node's mode, as its instance kept it (`_mode.json`), else as its node's `mode` gave it, else
`read-only` (the default before), is folded into the graph: `live`, its chat-out edges stay live;
`dry-run` or `read-only`, each becomes a dry run. Every node is enabled, the node's `mode` is
dropped, the file is written as a version of its history (`migrated`, §2.3) when that changes it,
and the instances' `_mode.json` are deleted. No safety stop nor drift pause was kept across a
restart before, so none becomes a stop. A graph read later with a node's `mode` (an older version of
the history, a file written by hand) has it folded as it loads (`foldModes`), from the node's `mode`
alone.

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
D50): its store and the core's documents beside it (its timers, its settings, its stop, what it
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
      "config": { "chats": ["@QuestBot", "-1001000000001"] }
    },
    { "id": "quest", "plugin": "quest-parser", "group": "Quest" },
    {
      "id": "quest-turns",
      "plugin": "turn-actor",
      "instance": "quest-turns",
      "config": { "chat": "@QuestBot" },
      "group": "Quest"
    }
  ],
  "edges": [
    {
      "from": "tg.chat",
      "to": "quest.chat",
      "type": "chat-in",
      "reads": "*",
      "senders": ["@QuestBot", "me"]
    },
    { "from": "tg.chat", "to": "quest-turns.chat", "type": "chat-in", "reads": ["@QuestBot"] },
    {
      "from": "quest-turns.chat",
      "to": "tg.chat",
      "type": "chat-out",
      "sends": ["@QuestBot"],
      "commands": ["/play"],
      "dryRun": true
    },
    { "from": "quest.interface", "to": "quest-turns.parser", "type": "interface" }
  ]
}
```

Here `quest-turns` sends its turns as a dry run, logged and not sent, until the owner switches its
edge to send for real; a node `"disabled": true` would not start at all (§2.1, Node states). Both
Quest nodes are drawn in the editor's Quest lane (`group`, bot-os.md D69); the connector, whatever
its group, outside every lane. A `group` is an addition to version 2, which a release before it
refuses (its nodes are strict): roll the image back past it only with the groups taken out.

**Version 1** (one `chat` edge for both the reads and the sends, from the connector to the plugin)
is converted as it is read (`upgradeGraph`, `packages/core/src/graph.ts`, bot-os.md D60), against
the plugins' manifests and each node's config: each `chat` edge becomes a chat-in edge with its
`reads`, same ends, if its node has a chat-in input of that port's name; a chat-out edge with its
`sends` and `commands`, from the node's chat-out output of that name to the connector's `chat`, if
it has one; both for a node with both (the turn-actor, any plugin of module API 1); and both for a
node whose plugin is unknown, so nothing is lost. The port names stay the same, so the conversion is
mechanical (a version 1 edge has no `senders`: it reads from anyone): `tg.chat → quest.chat` (a
parser) stays one edge, of `chat-in`; `tg.chat → look.chat` (a reactor on events) becomes
`look.chat → tg.chat`, of `chat-out`. The instance runs a version 1 file so converted,
`GET /graph/file` shows it so, and `POST /graph/check` and `PUT /graph/file` take version 1 too; the
file itself is rewritten (as version 2) only by the next save or rollback, and a version of the
history (below) written in version 1 is shown, diffed and rolled back as version 2.

**At start** (`packages/core/src/graph-file.ts`, `GraphFile`), the core reads it and checks it as
any graph (§2.1), against the plugins `core.available()` lists, their configuration and settings
schemas, their secrets and the instances kept. No file: an empty graph. A file that does not read
(not JSON), or that the check refuses, never stops the instance, which would only start again and
fail again: it starts with no nodes, the file is kept as it is, and why is printed, recorded
(`core.graph`, `event: "refused"`), told to the owner, and reported by `GET /status`
(`graph.refused`) and `GET /graph/file` (`problems`), for the owner to fix.

**The history** (`packages/core/src/graph-history.ts`, bot-os.md D61) keeps every graph written to
the file, by a save or a rollback, as a version: `/data/graph-history/<id>.json`, the id its time in
ISO 8601 with `:` written `-` (`2026-11-12T10-00-00.000Z`, then `-1`, `-2` for another in the same
millisecond), holding the graph as written and its metadata:

```json
{
  "time": "2026-11-12T10:00:00.000Z",
  "source": "rollback",
  "summary": "+ node examine; − edge a.chat → b.chat; ~ node x: config",
  "restores": "2026-11-11T09-30-00.000Z",
  "start": { "result": "ran", "at": "2026-11-12T10:00:05.000Z" },
  "graph": { "version": 2, "nodes": [], "edges": [] }
}
```

`source` is `save`, `rollback` (which names the version it `restores`), `found` (a file that no
version holds, written by hand: kept at the next start, or before the next write replaces it) or
`migrated`. `summary` is what changed from the version before (`diffSummary`): `+` added, `−`
removed, `~` changed with the fields that changed, nodes then edges, at most 8 named and the rest
counted (`… 3 more`). `start` is how the instance last started on it, set at each start once the
graph is loaded (`GraphFile.started`): `ran`, or `refused` with its `problems`; none if it never
started on it. A write that leaves the graph the same (a version 1 file rewritten as version 2) is
no new version. Versions are kept 7 days, and never fewer than the 5 latest; the others are pruned
at each new one. The history replaces `graph.previous.json`, which earlier releases kept: the first
start with no history takes `graph.previous.json` and then `graph.json` in as `migrated` versions,
at their files' times (one, if they are the same graph), and removes `graph.previous.json`; nothing
writes it again.

**A problem** (`GraphProblem`) is its words as the load says them (`text`) and, where it can be
told, the `node`, the `edge` (`{ from, to }`), the `port`, and the `config` or `setting` key it is
about, so that the editor marks it there. An edge between ports of two types is refused with why
(`node actor: input port score: chat-in of chat cannot bind interface of scorer (edge chat.chat → actor.score)`).

**The control API's graph routes** (§4.11), the owner's alone:

- `GET /graph/file`: the saved file (`graph`, as written, a version 1 file as version 2) and its
  `text` (`graphText`, §4.12), whether there is one (`exists`), why it does not read (`error`) or is
  refused (`problems`), and whether it differs from the graph running (`differs`: a restart would
  change what runs).
- `POST /graph/check`, a graph as the body: checked as the load would, nothing saved: `ok`, its
  `problems`, its `text`, and its `diff` from the saved file: the nodes `added`, `removed` and
  `changed` (with the fields that changed), and the edges `added`, `removed` and `changed` (with the
  fields that changed), by their two ends; and `views`, each node whose ports its config declares
  (§2, bot-os.md D74) as the editor draws it (`describePlugin` of its own manifest), whether or not
  the graph checks.
- `PUT /graph/file`, a graph as the body: checked, then saved as the core holds it (each edge's ends
  and type written out), and kept as a version of the history; `saved` (false when nothing changed)
  and `restart` (whether it differs from what runs). A graph refused is not saved: 400, with its
  `problems`.
- `GET /graph/history`: the history, without the graphs: `versions`, newest first, each its `id`,
  `time`, `source`, `summary`, and `restores` and `start` if any; `current`, the id of the version
  that is the saved file, if one is; `lastGood`, the newest whose last start `ran`; and `keep`
  (`{ "days": 7, "latest": 5 }`).
- `GET /graph/history/<id>`: one version: its metadata, its `graph` (as version 2), whether it is
  the `current` one, the `diff` from the saved graph to it (as `POST /graph/check` gives it: what a
  rollback to it would change), its `text` and the saved graph's (`currentText`), their line diff
  (`lines`, `[{ "op": " " | "-" | "+", "text" }]`, §4.12), and its `problems` if the check refuses
  it now. 404 for a version not kept.
- `POST /graph/history/<id>/rollback`: that version written as the saved graph (as the check holds
  it, or as it is if the check refuses it now), kept as a new version that `restores` it, so a
  rollback can be undone; the file it replaces is kept first if no version holds it.
  `{ "rolledBack": true, "version", "restores", "restart" }`, and its `problems` if the check
  refuses it. 404 for a version not kept, 409 when it is the saved graph already. Nothing restarts:
  the UI then asks `POST /restart`.
- `POST /graph/rollback`: the same, to the version before the current one (the second newest, or the
  newest if the file was written by hand since), as the route of earlier releases did; a second goes
  forward again. 409 when there is none.
- `POST /restart`: applies it. The answer goes, then the instance ends as at `SIGTERM` (§3): the
  core stops, each plugin's state kept, and the process exits 0, so that Docker's
  `restart: unless-stopped` starts it again on the saved graph.

No agent grant ever includes these (P11): they are the control API's, which no agent is given.

## 3. The lifecycle

```text
registered ─ manifests, graph and config valid ─▶ starting ─ create(), start() ─▶ running
   running ─ every plugin started: ready() ─▶ running
   running ─ a safety stop, drift, the owner's kill or stop ─▶ stopped (kept in its instance)
   running, stopped ─ serialise(), stop() ─▶ stopping ─▶ stopped
   create(), start(), ready() or a migration fails ─▶ failed (with why), and so do the plugins
   requiring it
   at load: disabled in the graph, stopped in its instance, or inactive ─▶ never started
```

`packages/core/src/core.ts` runs it (`Core`: `register`, `load`, `start`, `stop`, `stopNode`,
`clearStop`, `status`); every change of state is logged as `core.plugin`, with the plugin, the state
and the reason.

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
- **Stopped** by exception is the core's (§2.1, Node states): a plugin stopped by its own safety
  stop, by drift (§4.7) or by the owner. Its sends are refused by the outbox from then on; its
  `pause` hook is called so that it can stop planning, and its stop is kept in its instance, so the
  next start does not start it. Only the owner clears it, in the editor, applied with a restart; the
  `resume` hook is never called (module API 1 keeps it, unused). The nodes the stop makes inactive
  are shut down at once (§2.1, Node states; bot-os.md D65).
- **Disabled** and **inactive** nodes are never started (§2.1): their state is the load's, or, for a
  node made inactive by a runtime stop, the stop's.
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
  pause?(reason: string): void; // the core stopped it (§2.1, Node states)
  resume?(): void; // module API 1, deprecated: never called
  /** The owner changed settings; the new values are already in ctx.settings. */
  settingsChanged?(keys: string[]): void;
  off?(): void; // the owner turned the instance off (§4.11)
  on?(): string | undefined; // back on: what came of it
  kill?(): string | { text: string; buttons?: Buttons } | undefined; // its safety stop
  onTimer?(name: string, payload: unknown): void; // §4.3
  settings?: { apply(key, value): void; read(key): SettingValue }; // its own in force (§2)
  interface?: {
    state?: Record<string, (input?) => unknown>; // a read's input, if it declares one (§2)
    actions?: Record<string, Function>;
  };
  view?: { read(): StateView; summary?(): string | undefined }; // the state it keeps (§4.11)
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
  events: {
    read(query?: EventQuery): LogEntry[]; // the log read back, its instance's (§4.4)
    after(cursor: LogCursor, options?: { types? }): LogTail; // what was written after a cursor
  };
  clock: Clock; // now(), and timers; virtual in tests and simulators
  store: Store; // §4.2
  scheduler: Scheduler; // §4.3
  bus: Bus; // §4.4
  config: Config; // validated (§2)
  settings: { kept(): Partial<Settings>; set(key, value): string | undefined }; // §2
  connector(port: string): ConnectorHandle; // §4.5, a chat-in input an edge binds (§2.1)
  outbox(port: string): Outbox; // §4.6, through a chat-out output's edge (a dry run if it is one)
  use<T>(port: string): T; // the interface an input's edge binds (§2.1)
  useOptional<T>(port: string): T | undefined; // an optional input's, while bound and running
  drift: DriftReporter; // §4.7, parsers only
  notify(text: string, buttons?: Buttons): void; // the owner (§4.8); nothing while off
  stop(reason: string): void; // its safety stop: its node stopped, kept (§2.1, Node states)
  off(): boolean; // the instance is off (§4.11)
  mode: { get(); set(mode, by?: 'owner' | 'safety'); onChange(listener) }; // module API 1, derived
  resume(): boolean; // module API 1, deprecated: refused, false
  restored?: unknown; // what serialise returned at the last stop (§3)
  render: Render; // §4.13: SVG to PNG
}
```

**`ctx.mode`, module API 1, deprecated** (bot-os.md D64): the modes are gone, and `ctx.mode` is
derived for the plugins written against them. `get()` is `dry-run` when every chat-out edge of the
node is a dry run (or it has none), `live` otherwise, never `read-only` (a stopped node does not
run). `set('read-only', by)`, the owner's (`by` absent or `owner`) or a safety stop's (`safety`),
**stops** the node (`source` `owner` or `safety`, its reason `read-only, by the owner` or
`safety stop (read-only)`). `set('dry-run' | 'live', …)` is **refused and logged**, returning why:
states are raised only in the editor. `onChange(listener)` hears `read-only` when the node is
stopped. `ctx.resume()` is refused and logged too, and returns false. A plugin written now uses
`ctx.stop(reason)`, and reads how it sends from its outbox handle (`mode()`).

A connector's context also has `secrets.get(name)`, for the secrets it declared or its config names
(§4.9), `account`, its node's account (§4.5), on which it makes its connector, and `readers()`, what
each chat-in edge leaving its node reads (`{ reads, senders? }`, §2.1), as the graph says, of the
nodes that read now: about to start, starting or running, not disabled, stopped, inactive or failed
(bot-os.md D66). Asked again, it says what holds then: the chats a catch-up fetches (§4.5).

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
order. A timer fires once its plugin is running (or stopped since it started, bot-os.md D64: its
plugin drops what it planned), never while it is starting, shut down or failed; a timer that fires
is removed before `onTimer` runs, so the handler may set it again. A handler that throws is logged,
and the core goes on. Timers beyond Node's longest delay (about 24.8 days) are armed again when they
wake.

### 4.4 Event types and the bus

- An event type is `<namespace>.<name>` (`dice.roll`, `quest.turn`), registered by the plugin whose
  manifest lists it, with the zod schema of its payload. The schema's description, if it has one
  (`z.object({...}).describe('A roll of the dice')`), says what the event is: the editor lists each
  events output's types with it (bot-os.md D71). It is optional; a type without one is listed by
  name. The namespace is a game's, or the registering plugin's own id for what belongs to no game
  (`turn-actor.step`); `core.*` is the core's.
- `bus.publish(type, payload, t?)` fails for a type nobody registered, or one in a namespace the
  plugin does not register (its node's, for a plugin whose nodes register their own, bot-os.md D74:
  two such nodes never publish each other's types). In tests and in development (`NODE_ENV` not
  `production`) the payload is validated against its schema; in production it is not, to spare the
  parse on every message.
- `bus.subscribe(type or namespace, handler)` delivers only what the plugin declared it consumes:
  the namespaces of its events inputs, from the instances their edges bind, and its own (§2.1).
  Handlers run in order of subscription, synchronously: a message has reached every consumer before
  the next one is read. It returns the way to stop; a plugin that fails or stops is unsubscribed.
  The handler gets, with the event, where the log put it (`at`, a `LogPosition`, below; undefined
  without a log).
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
  without). **Replay belongs to the parsers** (bot-os.md D62): a parser resumes from its own records
  (what it parsed: its store, or its events read back), never by re-reading the chat; it rebuilds
  its recent state at `ready` with `read({ type: 'dice.roll', since: ctx.clock.now() - 6 * HOUR })`,
  and a fresh instance reads the whole log once with `read({ type: 'dice.roll' })`. What was said
  while the instance was down is the connector's to deliver, once, as missed messages (§4.5). It
  reads the instance's log (`CoreOptions.events`); the dev kit's is in memory (§4.10); without one
  it reads nothing. **By instance:** it reads its own instance's records of its own namespaces, and,
  of a namespace an events input consumes, those of the instances its edges bind, as the bus would
  have delivered them; so two instances of one plugin (a turn-actor per bot) never read each
  other's. `all: true` reads every instance's. A record with no `instance` (imported from an older
  log, §8, or written before records carried one) belongs to no instance, and every reader of its
  namespace reads it.

**A cursor into the log** (bot-os.md D72), for a reader that resumes where it left the log (the
state plugins, §5). A record goes to the file of its own time's UTC day, so one of an old time (a
missed message, published late) is appended to an old day's file, and no single count orders the
log. A place in it is a day's: `LogPosition` is `{ day: '2026-11-12', end }`, `end` the file's
length with the record (bytes; records in the dev kit's log in memory), as the log's `write` returns
it and the bus hands it to each subscriber. A `LogCursor` is `{ "<day>": <length read> }` for each
day file: a record whose `end` is at most its day's length is behind it, and a day it does not name
is read from its start. `ctx.events.after(cursor, { types? })` gives what was written after the
cursor (`{ entries: [{ entry, at }], cursor }`): each day's file from the cursor, whole lines only
(a line a crash cut short is passed; the log starts its next write on a new line), in the order
written, the days merged by time; filtered as `read` filters (its types or namespaces, its
instances); and the cursor past everything read, kept or not. Files only grow, so a cursor stays
true across restarts; a file found shorter than it (a backup put back) is not read again. A reader
that subscribes and reads after its cursor in one synchronous step misses nothing and reads nothing
twice: what was published before is in the log, what comes after is heard live.

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
  playback: boolean; // not news: ZNC's buffer at connection, or missed while down
  missed?: boolean; // said while the instance was down, delivered once by the connector
  own?: boolean; // sent by the account itself, from any of its devices
}

interface Surface {
  id: string; // as configs and edges name it: '-100…', '@QuestBot', '#lobby'
  title: string;
  kind: 'private' | 'group' | 'channel' | 'bot';
  lastActive?: number; // ms
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

**Surfaces** (bot-os.md D63): a connector may list the chats it can see,
`surfaces({ search?, limit? })`, most recently active first, for the owner to pick from (the control
API's `GET /accounts/<id>/surfaces`, §4.11): `telegram-user` the dialogs of the account, monitored
or not (so that the owner can pick new ones), each named as its `chats` config would name it:
without a search, those whose latest message is at most 7 days old (by the core's clock), from every
folder but the archive (folder 1), and those its `chats` config lists whatever their activity,
latest first, at most 50 once filtered; a search, by title, username or id, finds any of them,
archived and inactive ones too. Both draw on the account's full list of dialogs, fetched once for 30
s: a fetch with a limit returns the pinned dialogs first, however old, and filled the list with
them; `telegram-bot` the chats it has seen in updates, kept in its store (`surfaces`), and one
searched by its id or `@username`, asked of Telegram (`getChat`) and kept, since the Bot API cannot
list a bot's chats; `irc` its channel. A connector's `chats` config (the two Telegram ones) is what
it **monitors**: unset, every chat it has; each chat-in edge reads a subset (`reads`, `"*"` for all
of them). A connector not running lists nothing.

**Missed messages** (bot-os.md D62): what was said while the instance was down is the connector's to
deliver once, marked `playback` (so nothing acts on it: the reactor skips it, and the replies'
matchers too) and `missed` (so a parser reads it as any other). `telegram-bot`: Telegram keeps a
bot's updates for a day and delivers them at the next poll, and the connector marks those sent
before it connected; Telegram delivers an update again when its poll was not confirmed (the process
killed), so the connector keeps the last message id it delivered in each chat (`last-seen`) and
delivers none twice (D66). `irc`: ZNC's buffer, played back at connection, is `playback` (not
`missed`: ZNC may play back what was already heard). `telegram-user`: GramJS 2.26.22 offers no
update catch-up (`client.catchUp()` is an empty stub, and neither `StringSession` nor the client
keeps the update state that `updates.getDifference` needs), so the connector fetches back each
chat's history at connection:

**Exactly once** (bot-os.md D66): across live delivery, the catch-up and restarts, each message (its
chat and its id) reaches the readers at most once, and a gap is fetched until it is filled, or the
cap is hit. The connector keeps in its store what it has accounted for in each chat, delivered or
skipped on purpose (`packages/connectors/src/transport/seen-ledger.ts`):

- `last-seen`, `{ "<the chat's marked id>": <message id> }`: every message up to that id is
  accounted for. It never moves past a gap that is not filled.
- `seen-above`, `{ "<the chat's marked id>": [[<from>, <to>], …] }`: the ids accounted for above it,
  while a gap below is open: what was heard live (every message from the connection's first live id
  on comes live) and what the account sent itself. A range that meets `last-seen` folds into it; at
  most 100 a chat, past which the lowest gap is given up (and warned of).

A message is accounted for before it is delivered, so that a stop in between never delivers it
twice. One heard live twice (or live after the catch-up delivered it) is delivered once.

- **Which chats**: those some running reader reads (an edge's `reads`, every monitored chat for
  `"*"`, as `ctx.readers()` gives them: not a reader disabled, stopped, inactive or failed) with a
  gap: messages up to the latest (the dialog's top message, from `getDialogs`) not accounted for. A
  chat with a gap that no running reader reads is not fetched: its gap is skipped, accounted for up
  to its latest message, and what is heard there live is accounted for as it comes, delivered to no
  one. So a reader enabled later starts from then: a disabled node is off, and the catch-up covers
  the instance's downtime only. A chat no running reader reads by the time its turn comes is skipped
  too. A chat seen for the first time is not fetched: it is accounted for up to its latest message.
- **How far**: each gap, newest first, back to what is accounted for, at most **1000** a chat, in
  pages of 100. A chat still missing older messages at the cap is warned of in the log and recorded
  in the event log (`telegram-user.catch-up`, with the `chat` and how many were `fetched`); the
  older ones are skipped.
- **Rate limits**: one request at a time, a second apart; a `FLOOD_WAIT` is waited out, then the
  page asked again. Live messages are delivered meanwhile.
- **Delivery**: chat after chat, each chat's oldest first, each message once, marked `missed` and
  `playback`, through the edges' filters (`reads`, `senders`) as any message: parsers read it,
  reactors and reply matchers skip it. Service messages (a join, a pin), and one whose sender cannot
  be fetched, are skipped. `last-seen` moves with each message delivered; a stop in the middle keeps
  it there, and the next connection fetches only what is still missing.
- **A fetch that fails** is logged, and the chat is fetched again in a minute, then after twice as
  long each time, at most an hour apart, while the connection lasts, and at the next connection.
- **The account's own messages**: those it sends through the outbox are never heard back live from
  its own session, so each is accounted for as it is sent: the catch-up does not deliver it as
  missed. Those sent from the owner's other devices come live, and are delivered as any (`own`).

As built (`packages/core/src/connector.ts`): a connector plugin's instance offers its `connector`,
whose account must be the manifest's (or its node's); `ConnectorBase` keeps the listeners and the
status for the implementations. `ctx.connector(port)` gives a handle only on a connector a chat-in
input of the plugin is bound to, and the handle hears only the chats that edge `reads` (compared
without case; any, for `"*"`) and the `senders` it names (anyone without; `me`, the account's own,
`own` or its own name), as `hears(filter, message, self)` matches them. A connector's node has a
chat-in output, `chat`, which the readers' edges leave, and a chat-out input, `chat`, which the
senders' edges reach (§2.1, bot-os.md D60). The wiring reaches the full connector with
`core.connector(id)`. The shell's connectors are in §5.

### 4.6 The outbox

One per account; every send goes through it (bot-os.md §3). A plugin gets its handle with
`ctx.outbox(port)`, bound to its own id, through a chat-out output an edge binds to the account's
connector (§2.1):

- **The reach:** each chat-out edge from it to the account's connector lets it send to its `sends`,
  with its `commands`; a send outside them is refused. A chat-in edge sends nothing. The handle
  `ctx.outbox(port)` gives sends through that output's edge alone; named by the connector or the
  account, through every edge to it.
- **A dry run** (bot-os.md D64): a send through a `dryRun` chat-out edge is logged as sent (outcome
  `dry-run`), counted in the account's rate, and never sent; through a live edge (one of several
  that let it send this, if any is live), it is sent. The handle's `mode()` says which: `dry-run`
  when every edge it sends through is a dry run, `live` otherwise.
- **The node's state** (§2.1, Node states): a stopped node's sends are refused
  (`stopped: <reason>`), and so are those of a node not running (`not running (<state>)`). The modes
  of before (P10's `read-only`, `dry-run`, `live`, kept as `_mode.json`) are gone: the first start
  folded them into the edges.
- **Pacing:** `send` sends now or is refused with why (too soon, the hourly limit), for actors that
  time their sends to the second; `enqueue` queues the send (below, bot-os.md D73) and spaces it
  within the account's limits (`connector.limits`) and its command's interval in its chat, and the
  network's waits (Telegram's `FLOOD_WAIT`) hold the account's queue.
- **Replies:** matchers pair a bot's answer with the send that caused it: `replyTo`, `mentioning`,
  `within` and `from`, combined with `all`, and `waitFor` waits on a connector handle for the first
  match (`packages/core/src/replies.ts`).
- Every attempt is logged (`core.send`), with its outcome.

As built (`packages/core/src/outbox.ts`): the checks run in a fixed order, each refusal with its
reason: the caller's own refusal (`refuse`, for a game's grammar), the reach
(`… does not send to …`, `… is not among …'s commands`, by first word), whether it is a dry run, a
stop (`stopped: …`, or `not running (…)`), a flood wait (a connector throws `FloodWait`, which holds
the account), the rate (`too soon`, `hourly limit`, dry runs counted), and the connector
(`not connected`). `deliver(chat, text)` runs the same checks, then awaits the connector's
`deliver`: `sent` with the network's id of the message, `refused`, or `failed` with why the network
refused it; the rate counts the send when it leaves. A send may say its text is Markdown
(`format: 'markdown'`): a connector of a network that formats sends it formatted, any other as
written. Every attempt's record (`core.send`) has the `mode` it went in (`dry-run` or `live`).

**The queue** (bot-os.md D73): an acting node that needs a piece of state asks for it with a command
(`/inventory`), but another node may ask too, or the state may come meanwhile, so it queues the
send, with what makes it pointless:

```ts
const q = ctx.outbox('chat').enqueue('@QuestBot', '/inventory', {
  origin: 'stock',
  cancel: {
    on: 'quest-state.changed', // event types or namespaces its node hears
    when: { sections: 'inventory' }, // dotted paths; a list matches a value it holds
    test: (e) => e.t > asked, // a plugin's own predicate, optional
    withinMs: 10 * 60_000, // or `deadline`, a time: then expired
  },
});
const r = await q; // { text, outcome: 'sent' | 'dry-run' | 'refused' | 'cancelled' | 'expired', reason?, event? }
q.status(); // 'waiting', or its outcome
q.cancel(); // true if it still waited
```

- **One queue per (connector, chat),** side by side in the account's outbox, in the order queued.
  The same text waiting for the same chat, anywhere in its queue, is **coalesced** across nodes: one
  send, a handle per node, each with its own cancel; logged once (`core.send` of the first node that
  sends for real, with `with`, the others). Only **different nodes'** sends coalesce: a node's own
  same text queued again (buying several of an item with one command) is a send of its own, and
  another node's same send joins the first of them it is not in yet.
- **In its turn:** what can never go now is refused at once (the reach, a stop), as `send` refuses
  it. A send goes when its command's interval in its chat has passed since that command last went
  (by `send`, `deliver` or the queue; a dry run counted), within the account's pace: the oldest such
  first, so a send of another command never waits behind one held by its interval; a command never
  sent goes at once. The interval is the window in which a cancel can land. It is the longest its
  coalesced nodes' edges name (`minIntervalS`), else the connector's (`limits.commandIntervalMs`,
  from its config's `commandIntervalS`; 0 by default).
- **Cancelled** when an event of `on` that its node hears (its events inputs' namespaces, or its
  own; another is refused at once, nothing queued) holds `when` and `test`; **expired** at its
  deadline; cancelled by its node's `cancel()`. Its outcome says why
  (`cancelled by quest-state.changed`) and carries the event.
- **When it goes,** each node's checks run again: one refused is told so, the others go; through a
  dry-run edge its share is a dry run, and the send is a dry run unless one of its nodes sends for
  real (the dry ones are told `dry-run`).
- **A node that stops** (stopped, inactive, failed, or the instance stopping) has its waiting sends
  dropped, `cancelled` with why. The queue is not kept across a restart: its nodes queue again at
  their start, so a downtime never leaves stale commands to send.
- **Logged:** each step as `core.queue` (`{ account, plugin, chat, text, event, reason?, by? }`,
  `event` one of `queued`, `coalesced`, `sent`, `dry-run`, `refused`, `cancelled`, `expired`); the
  queue as it stands is the connector's (`GET /plugins/<id>/queue`, §4.11), shown in its panel.
- **Merges seen:** a merge may say that two nodes duplicate a piece of logic, so while the queue is
  young they are easy to see without the log: the connector's panel marks a send several nodes share
  (`shared by 2 nodes`), and counts the sends coalesced since the start with the pairs of nodes that
  shared them (`3 sends coalesced since the start: a + b (2), a + c (1)`), which its card's line and
  `GET /status`'s `summary` carry too. The count lives in memory, as the queue does, and starts
  again at each start. (A watchdog of the queue is #41.)

**An outbox made outside the core** (a module's own, over a game of its own: module API 1,
deprecated) may still keep its senders' modes: `new Outbox({ …, modes: new Modes() })`, with
`modes.set(plugin, mode, by?)`, where `read-only` refuses, `dry-run` logs as if sent and `live`
sends, as before. The core's own outboxes have no modes.

### 4.7 Drift

A parser sorts every message it sees into one of three (P5): **not its bot's**, **read** (events
published), or **claimed but unread** (its bot's, in a form it does not know). The parser reports
the third to `ctx.drift`, with the text; the core logs it (`core.drift`), counts it per parser, and
tells the owner.

**Unrecoverable** (bot-os.md D21): more than 5 unread messages from one parser within 15 minutes, a
threshold each parser's manifest may change (`drift`: `unreadAt`, `windowMin`). Then the core stops
every running plugin of kind `actor` that requires that parser, directly or through other plugins
(`source` `drift`, kept in its instance: §2.1, Node states), until the owner clears its stop in the
editor, and the nodes those stops make inactive are shut down at once (D65); the other plugins keep
running and reporting. Nothing stops before the threshold is passed: the unread messages under it
are only reported.

As built (`packages/core/src/drift.ts`): a parser reports through `ctx.drift` (`read`, `unread` with
the text and the lines it did not know); the contract's type is `Reading`. Each unread message is
logged (`event: "unread"`) and told to the owner, the first at once and then at most once an hour
with the count of those meanwhile. Past the threshold the core stops the actors once until the rate
falls back, logs it (`event: "pause"`, with the plugins stopped) and tells the owner; `core.drift()`
gives the counts.

### 4.8 The owner

The owner of the instance (D19) is told of what the core does on its own (a plugin failed, a stop
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
  kept settings (`settings`) and the documents their stores start with (`documents`), and the event
  log before the run (`history`), which the plugins read with `ctx.events`; `kit.log` is that log in
  memory, every record of the run added (`MemoryEventLog`). An archived plugin runs on a kit only
  when the run says so (`allowArchived`). `start` refuses a setting refused and a run with a plugin
  failed; `runUntil(t)` runs the clock. The core is the instance's own, unchanged.
- **`defineSimulator({ manifest, run })`**: a simulator plugin (bot-os.md D13), a model of a game
  that runs other plugins on a kit. It is not registered in an instance: its manifest (kind
  `simulator`) names it, the game it plays (`games.consumes`) and the plugins it runs (`requires`),
  and `run(run, options)` plays one run.

### 4.11 The owner's controls

What the owner sees and changes of the instance, built from what each plugin declares (P11) and
nothing else, so that every surface offers the same: the chat surface's owner commands, the HTTP
control API, the web UI and later the agents, whose grants will be subsets of it. As built
(`packages/core/src/controls.ts`, `core.controls`):

- **Each plugin:** its state (bot-os.md D64, §2.1: `running`; `disabled`; `stopped`, with its
  `stop`, `{ reason, time, source }`; `inactive`, its `reason` the node it needs,
  `needs tg (disabled)`; `failed` with why), its settings with the values in force, the names of the
  reads and actions its `interface` declares, its own account of itself if it declares a read named
  `status`, and, if it keeps a state (its instance's `view`, bot-os.md D72), one line of it
  (`summary`), for its card; a connector whose queue coalesced sends since the start says so there
  too (`2 sends coalesced: a + b (2)`, D73).
- **The owner's changes:** a declared read (`read`) and a declared action (`act`), whose input is
  checked against the action's schema (an error names the field) and which the plugin refuses by
  throwing, with why; a node's stop cleared (`clearStop`), for the next start. No control raises a
  state at runtime: a node is enabled, disabled or cleared of its stop, and an edge sent for real,
  in the editor, applied with a restart (the modes and their `setMode`, and `resume`, are gone).
- **The off switch,** instance-wide, unchanged: off, every running plugin hears `off` and stops what
  it does, the owner is told nothing; `on` lets each plugin take up what it did and say what. It is
  kept in the core's store (`/data/core/power.json`) across restarts, logged as `core.power`, and a
  plugin reads it with `ctx.off()`. The outbox does not refuse sends while off: a plugin's `off`
  stops it (D30).
- **The accounts and drift:** each connector instance with its account and its connection's status
  (`accounts`), and each parser's drift (`drift`).
- **The kill switch:** each running plugin's own `kill`, its safety stop (which may stop its node,
  `ctx.stop`), with what came of it and the buttons of its ways on; a plugin without one is left as
  it is (D30).
- **A node's kill** (`killNode(id, reason = KILLED)`, D44, D48, D64), the graph view's, and its stop
  from Telegram's `/plugins` (the reason `stopped by the owner`, `STOPPED`): that plugin's own
  `kill`, then the core stops it (`source` `owner`), kept in its instance, so that its outbox
  refuses its sends and the next start does not start it. The nodes that require it, through
  required ports, are inactive and shut down at once (§2.1, Node states; bot-os.md D65). The owner
  clears the stop in the editor (Clear stop, applied with Apply: `POST /plugins/<id>/clear-stop`,
  then the restart). Refused for a node that is not up (running, or stopped since it started).

**The core's commands** (`packages/core/src/owner-commands.ts`), the owner's, answered by the chat
surface after the plugins': `/plugins` (the instance on or off and each plugin's state, with
buttons), `/plugins <id>` (a plugin's state and why, its stop, its settings, reads and actions; and,
while it runs, the one action that changes a node's state there, **⛔ Stop**, `/plugins <id> stop`,
a node's kill as above), `/kill`, `/settings` and `/set <key> <value>`; hidden, the cards' buttons
and the off switch's `/off` and `/on`. Nothing there starts a node again: that is the editor's. Each
card ends with the way back to the owner's main card that the wiring names (`CoreOptions.home`).

**The HTTP control API** (`packages/core/src/control-server.ts`), one request handler
(`controlHandler`) that the entry point serves twice: on the container's loopback (`CONTROL_PORT`,
8081), and under `/api/` on the web UI's listener, only behind its login. `GET /status`;
`GET /instance` (off or on, the process's uptime, Node's version and memory, the plugins and the
accounts counted by state); `GET /accounts`; `GET /accounts/<id>/surfaces?search=&limit=50` (a
connector's surfaces, §4.5: `{ running, listed, surfaces }`, `running` false until it runs, `listed`
false for a connector that cannot list its chats, 409 with why when it cannot tell now, such as not
connected, 404 for a node that is not a connector); `GET /drift`;
`GET /events?limit=100&type=<prefix>&hours=24` (the event log's latest records, newest first);
`POST /off`, `/on`, `/kill`; `GET` and `POST /settings`; `GET /graph` and `GET /graph/view` (§4.12);
`POST /plugins/<id>/kill` and `POST /plugins/<id>/clear-stop` (409 with why when refused, such as
`actor is not stopped`); `GET /plugins/<id>/state/<name>?<field>=<value>` (a read, its input the
query's fields, §2); `GET /plugins/<id>/queue` (what waits in a connector's queue, D73:
`{ account, entries: [{ chat, text, command, queuedAt, waitingUntil, intervalS, nodes }], coalesced }`,
each node with its `origin` and its `cancel`, `{ on?, when?, test?, deadline? }`, and `coalesced`
the sends merged since the start, `{ count, pairs: [{ nodes: [a, b], count }] }`; 404 for a node
that is not a connector); `GET /plugins/<id>/view` (the state a node keeps, read only, D72:
`{ schema, state, updatedAt?, freshness?, pin? }`, its schema a JSON Schema; 404 for a node that
keeps none, 409 for one not running); `POST /plugins/<id>/actions/<name>`, the body the action's
input (400 for an input refused by its schema, 409 for the plugin's refusal); `GET /instances`
(§2.2); `GET /graph/file`, `POST /graph/check`, `PUT /graph/file`, `GET /graph/history`,
`GET /graph/history/<id>`, `POST /graph/history/<id>/rollback`, `POST /graph/rollback` and
`POST /restart` (§2.3); `GET /legacy`, `GET /legacy/events`, `POST /instances/import` and
`POST /legacy/events/import` (§8); `GET /available`, `GET /modules`, `POST /modules`,
`POST /modules/plan`, `POST /modules/github`, `POST /modules/updates`, `POST /modules/<id>/rollback`
and `DELETE /modules/<id>` (§7.4); `GET /secrets`, the names of the Docker secrets provided, never
their values, for a connector's config to name (§4.9; the wiring leaves out `web_ui_password`,
`bot_os_key` and `github_token`, the shell's own). Ids and names in a path may be URL-encoded. The
control API is the owner's alone: no agent is ever given it (P11), so no agent installs a module
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

`packages/core/src/graph-view.ts`: `graphText` prints the graph so that a changed value is a changed
line (bot-os.md D61): each node a line, `<id> (<plugin>)`, then its instance when not its id,
`disabled` when it is (D64), its account, and its group (D69); then a line per key of its config and
of its settings, the value as compact JSON with its keys sorted; then each edge a line, with its
type and what it carries, a chat-out edge's `dry-run` among it, so that the history's diffs show a
state changed, and its commands' spacing (`spaced /inventory 300s`, D73); nodes sorted by id, edges
by their text, so the same graph prints the same:

```text
nodes:
  quest (quest-parser), group Quest
  quest-turns (turn-actor), instance quest-turns-old, disabled, group Quest
    config.chat: "@QuestBot"
  tg (telegram-user), account telegram:alice
    config.chats: ["@QuestBot"]
edges:
  quest-turns.chat → tg.chat (chat-out): sends @QuestBot; commands /play; dry-run
  quest.interface → quest-turns.parser (interface)
  tg.chat → quest.chat (chat-in): reads @QuestBot
```

`lineDiff` gives two printouts' line diff, their longest common subsequence of lines kept and the
rest removed (`-`) or added (`+`), with no dependency (two texts of over 4 million line pairs give
every line removed, then every one added). `graphMermaid` draws a Mermaid flowchart, left to right,
a box per node (and a second, `<id> · out`, for a connector that chat-out edges reach, so that the
sends flow left to right too) and an arrow per edge, coloured by its port type; `writeGraphFile`
writes a graph to `<dir>/graph.json` atomically (the versions before it are the history's, §2.3).
`packages/core/tools/graph.ts [file] [--mermaid]` prints a graph file, a version 1 file as
version 2.

**The graph editor** (bot-os.md D47, D55) is the web UI's home page (`packages/web/src/ui/graph/`),
drawn with React Flow. It edits a draft of the saved graph (`GET /graph/file`), each node drawn from
its plugin as `GET /available` describes it (a node whose ports its config declares, as the last
check's `views` describe it, bot-os.md D74) (`describePlugin`: its version, description, kinds and
account, its input and output ports, the reads, actions and commands its `interface` declares, and
the JSON Schemas of its `config`, its `settings` and its actions' inputs and outputs and reads'
outputs, zod's `toJSONSchema`), with the node's own id, account and config; the port types' looks
come from `GET /graph/view` (`PORT_TYPE_INFO`). It polls `GET /status` and `GET /drift` for each
node's live state and drift. Each change of the draft is checked (`POST /graph/check`) and every
problem shown where it is located (§2.3). A node's config starts filled with its schema's defaults
(nested objects within), written to the draft as if typed; a node opened shows the defaults of the
fields its config leaves unset filled in, unmarked, and writes them with its first change, so that
merely opening a node changes nothing. A field's description is its help. A node selected shows its
forms, editable, a key of `configSecrets` as a choice of `GET /secrets`, and what each of its
outputs carries, not its type, which the graph draws (bot-os.md D71): an events output, the event
types its plugin registers in that namespace (`types` of its port in `GET /available`), each with
its schema's description (§4.4) and its payload's JSON Schema (`schema`); a chat-out output that
declares its commands, each with its spacing (bot-os.md D74); an interface output, its members'
names, folded, opening on each one's signature (from its schemas:
`actions.sent({ chat: string, id?: string, t: number })`,
`state.rest() → { until: number, why: string }`) and help; another output, its port in words. An
edge selected, what it carries: a chat-in edge its `reads` alone, a chat-out edge its `sends` and
`commands`, with each command's spacing for its queued sends (`minIntervalS`, empty for the
connector's default, D73); a running connector's panel lists its queue. **States and dry runs**
(bot-os.md D64, §2.1): a node is drawn greyed while disabled in the draft (its panel's **Enabled**
switch), in red tones with a warning icon and its reason while stopped, greyed with the node it
needs while inactive (from `GET /status`); a stopped node's panel says why, when and by what, with
**Clear stop**. A node added starts disabled, and a chat-out edge drawn starts a dry run: its
rhombus hollow and its part from the rhombus to the connector greyed and dashed, its panel's
**Dry-run / Send for real** switch setting `dryRun`. All of these are changes of the draft, listed
in the review (a stop cleared as "Stops cleared") and made by Apply. A connector is drawn as two
cards (`cards.ts`, bot-os.md D60), one node in the graph all the same: its **in** card
(`telegram-user · in`) at the left, with its chat-in output and its other ports, and its **out**
card (`telegram-user · out`) in a column of its own at the right, with its chat-out input, where the
senders' edges end. Each card is placed on its own; selecting either selects the node and opens its
panel (the other card shows itself selected too); removing it removes both, after a confirmation
that names them. The split lives in the editor's view alone: the graph file holds one node. Each
edge has a rhombus at its midpoint in its port type's colour (`PortEdge.tsx`, React Flow's
`EdgeLabelRenderer`), a button named after the edge (`edge irc.chat → dice.channel`) that selects it
and opens its panel, by a click or the keyboard. Its review shows the diff and two actions: Apply,
`PUT /graph/file`, then `POST /plugins/<id>/clear-stop` for each stop cleared, then `POST /restart`
(none if the core refuses the graph, which the review says, nor if the saved graph is what runs
already and no stop was cleared), and Revert, the draft back to the saved graph; a banner offers
Apply (`POST /restart`) when the saved file differs from what runs (`differs`). After a restart the
page waits on `GET /session` for the new process (another `boot` id), and comes back to the page,
still logged in. One or several running nodes selected can be killed, each by
`POST /plugins/<id>/kill`: stopped, until their stops are cleared. Its **Text** toggle shows the
draft printed (the check's `text`), read-only, with a copy button. The rollback is not the editor's:
it is the admin page's **Graph history** (`#/graph-history`), which lists the versions newest first
(time, summary, start, the last that ran marked "last good"), shows one opened in two tabs,
**Changes** (the review's diff from the saved graph to it) and **As text** (the line diff), and
rolls back to it after a confirmation repeating the diff, then restarts as Apply does; beside it,
**Graph as text**, the saved graph printed.

**Swimlanes** (bot-os.md D69): a draft whose nodes name groups is drawn in lanes (`layout.ts`'s
`swimlanes`, `lanes.ts`, `LaneNode.tsx`). The columns stay global, as above, so a stage lines up
across lanes; each group is a horizontal band across them, a tinted rounded box with its name at its
top left, ordered by its first node in the graph's order, and the ungrouped nodes have an unlabelled
band last. The connectors (the nodes drawn as two cards) stay outside every band, their in cards
stacked in the leftmost column and their out cards in the rightmost; a connector's group is kept and
ignored, as its panel says. A band is a React Flow group node and its cards its children, kept
inside it: a card cannot be dragged into another lane. A node's panel sets its **Group**: none, one
of the draft's, or **new group…**, named and set; a change of the draft, applied with Apply. A
lane's label zooms to fit it; resting on a node dims what it does not reach, and resting on a lane's
label dims everything outside it but the edges its cards are at and the connectors those reach; the
minimap tints each lane in its colour. A lane's colour is the one of a fixed palette its name hashes
to, or the next free one when a lane before it has it, so that no two lanes share one while the
palette's eight last. A draft with no group is drawn with no lane.

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
  through its chat-out output `via`, so its edge's reach (the chats it `sends` to, its `commands`)
  and dry run (D64), its node's state, the account's pacing and the `core.send` log all apply
  (§4.6).
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
| `telegram-user` | connector | `@megabottron1999/connectors` | A Telegram user account (GramJS), reading and sending in the chats it monitors                   |
| `anthropic`     | connector | `@megabottron1999/connectors` | The Claude API: `ask`, with structured output (§4.13)                                            |
| (service)       | connector | `@megabottron1999/connectors` | `ServiceConnector`: the connector of a plugin that holds secrets for an API client, no chat      |
| (turn parsers)  | parser    | `@megabottron1999/turns`      | `turnParserPlugin`: a parser of one game bot's answers to turns, from a grammar a game gives     |
| `turn-actor`    | actor     | `@megabottron1999/turns`      | One game bot's turns, at a person's pace, run as one instance per bot                            |
| `reactor`       | actor     | `@megabottron1999/turns`      | One reaction (§4.15) from its config: a command sent when an event is heard or a message matches |
| (states)        | stats     | `@megabottron1999/turns`      | `statePlugin`: a game's player state, kept from its parsers' events, from a spec a game gives    |

- **`irc`** (`packages/connectors/src/plugins/irc.ts`, on the IRC client of
  `packages/connectors/src/transport/irc-client.ts`): one IRC account through ZNC, its configuration
  the ZNC login (`host`, `port`, `tls`, `zncUser`, `zncNetwork`), the `nick`, the `channel` and the
  rate limiter (`minIntervalS`, `maxPerHour`) and its queue's default interval between two sends of
  a command (`commandIntervalS`, D73); its password is the `znc_password` secret. It opens one
  connection however often it is started (networks' clone limits). It logs each line of the channel,
  played back or live, as `irc.line`, and each step of the connection as `irc.status`. With
  `healthPort` it serves `GET /health`: 200 while it is in the channel, 503 when not.
- **`telegram-bot`** (`packages/connectors/src/plugins/telegram-bot.ts`, on grammY in
  `packages/connectors/src/transport/telegram-bot.ts`): a bot, made from its `telegram_bot_token`
  secret at `create` (with auto-retry), connected and polling at `start` with retries (a backoff
  capped at ten minutes). Its status is `connecting` until `getMe` answers, `connected` while it
  polls; its own name is the bot's username. It hears every message Telegram delivers the bot and
  sends through the account's outbox (`deliver`, to a chat id or an `@username`; a 429 longer than
  auto-retry waits out becomes `FloodWait`); `commandIntervalS` in its config is its queue's default
  interval between two sends of a command (D73). With `chats` in its config (ids or `@username`s) it
  monitors only those for the plugins; its surfaces are the chats it has seen (§4.5), and the
  updates Telegram kept while it was down come marked `missed`. Configured with the owner's Telegram
  user id and optionally a group (`owner`, `group`, in its node's config), it is the instance's chat
  surface, and the owner's chat that the core sends the owner's notices to (§4.8, bot-os.md D56)
  (`telegram-surface.ts`): the switchboard on its bot (`telegram-switchboard.ts`, on
  grammy-switchboard), the plugins' commands answered in the group, the owner's chat and any other
  private chat (`telegram-commands.ts`), the menus kept registered, and the owner's notices carried
  in order (`telegram-notifier.ts`). Nothing hands its bot out (P9).
- **`telegram-user`** (`packages/connectors/src/plugins/telegram-user.ts`, on GramJS in
  `packages/connectors/src/transport/telegram-user.ts`): the owner's own account, from three secrets
  (`telegram_user_api_id`, `telegram_user_api_hash`, `telegram_user_session`). It monitors the chats
  of its configuration (`chats`: a group by its id, a private chat by the other's `@username`, or
  their id when they have none), or every chat of the account when `chats` is unset (a new
  connection), each edge reading a subset (§2.1); it lists its dialogs, monitored or not, as its
  surfaces (§4.5: those active this week by default, any by a search), and catches up at each
  connection on what its readers' chats said while it was down, each message once (§4.5, D62, D66).
  It starts without waiting, retries every minute, and tells the owner of the first failure; a
  message carries its id, the one it replies to, and `own` for the owner's own from any device. It
  sends only through the account's outbox (`deliver`, with the message's id), its queue's default
  interval between two sends of a command its config's `commandIntervalS` (D73); GramJS's flood
  waits become `FloodWait`.
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
  group: a `chat-in` input only, with no way to send; its default edge reads from its bot and the
  owner (`senders: ["@<bot>", "me"]`). It knows the owner's turns (a turn command of its game's,
  bare or addressed to its bot, sent by hand from any device; and those its actor sends, told
  through its action `sent`, since the account never sees its own sends come back), and which of its
  bot's messages answer one: a reply to it or, in the private chat, the first message within two
  minutes of it. What it reads it publishes as `<id>.turn` (`{ chat, outcome }`); a message it
  claims and cannot read goes to drift (§4.7) and is published as an `unknown` outcome. Its read
  `rest` says until when the bot rests, from its last answer. It resumes from what it parsed (D62):
  the owner's recent turns and its bot's rest are kept in its store (`parsed`) as they change and
  read back at its start; it never re-reads the chat, and reads missed messages as any other. Its
  game gives it a spec (`TurnParserSpec`): its `id`, its `bot`, its `description`, its grammar
  (`read`) and its `turnCommands`, the bot's turn commands by first word (`["/play"]`, at least
  one): which commands are turns is a fact of the game, so it has no config (bot-os.md D70). A node
  saved while it had one (`"config": { "commands": [...] }`) still loads and runs: a plugin with no
  config schema ignores its node's config, which the file keeps as written until the owner takes it
  out. The tests play a made-up @QuestBot (`packages/turns/test/quest.ts`).
- **`turn-actor`** (`packages/turns/src/turn-actor.ts`): one plugin run as one instance per game bot
  (P3, P17), each with its own id, configuration, store, timer and state. Its ports: `chat`, a
  chat-in input on `telegram`, which reads the private chat with its bot (for the turns the owner
  sends by hand), and `chat`, a chat-out output, which sends there (its command only); and `parser`,
  a contract (`state.rest`, `actions.sent`) bound to its bot's parser, required, so that drift on
  the parser stops it. (Its read is to go, its parser telling it of the turns sent by hand, #21.)
  Its configuration: `chat` (the bot's `@username`), `command` (the bot's turn command; `/play` when
  unset), `schedule` (the planner's pace, each field with its default in the schema,
  `DEFAULT_SCHEDULE` of `packages/turns/src/schedule.ts`: 17–20 minutes between turns, some skipped,
  nights off in its `timeZone`), `nightSalt` (the instances with one salt sleep the same nights) and
  `seed`. It plans from the owner's last turn with the bot (kept in its store; a turn sent by hand
  counts too), as the durable timer `turn` (dropped if it came due more than 10 minutes before a
  start); when it is due, it asks its parser whether the bot rests and, if so, comes back a few
  minutes after; through a live chat-out edge it waits for the account to be connected, sends
  through its outbox and tells its parser the message's id; through a dry-run edge (bot-os.md D64,
  as a new one is drawn) it logs its turn (`sent`, `/play (dry run)`) and sends nothing; a failed
  send is tried again two minutes later. It plays while its node runs and the instance is on; its
  safety stop (`kill`) stops its node (`ctx.stop`), which drops its plan until the owner clears the
  stop in the editor. It needs no `ctx.mode`. It declares no chat command, since two instances would
  clash: the owner reaches each with `/plugins <id>` and its read `status`. Each step is published
  as `turn-actor.step`. The image offers it (`src/main.ts`): the editor adds one node per bot, each
  on its own instance, its `chat` edges from and to the owner's `telegram-user` node and its
  `parser` edge to its bot's parser. The turn parsers are not the image's: each is made from a
  game's grammar, so a game's module offers it.
- **`reactor`** (`packages/turns/src/reactor.ts`): one reaction (`react`, §4.15) made from its
  node's config, with no code, run as one instance per reaction. An actor: whether it sends for real
  is its chat-out edge's (a dry run as the editor draws it, D64). Its configuration
  (`reactorConfig`): `on`, the event type it reacts to (or a namespace), or `match`, a regular
  expression the messages read on its chat-in input must match (its named groups in the payload),
  with `in` (the one chat whose messages it reads; every chat its edge reads without) and
  `ignoreCase`; exactly one of `on` and `match`. Then `when` (dotted paths of the payload, each
  equal to its value), `chat` and `send` (`{path}` templates of the payload), and `maxAgeS` (how old
  an event may be, 120 seconds by default). Its ports: `chat`, a chat-out output, the account it
  sends through (on any network), whose edge carries the chat it sends to and its commands; `chat`,
  a chat-in input there only with `match` (`when: { config: 'match' }`, §2.1), the chats it reads;
  and `events`, optional, whose namespace is the one of its `on` (§2.1): bound to the nodes whose
  events it hears, and not a port at all of a reactor on messages. So a reactor on events only
  sends. Each reaction is recorded as `reactor.reaction`, and each send logged as `core.send` with
  the node's id as its origin. The image offers it (`src/main.ts`); a node that examines what a
  game's parser reads, in the graph file:

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

- **`statePlugin`** (`packages/turns/src/state-plugin.ts`, bot-os.md D72): a game's player state (an
  inventory, a profile), kept by the shell from the events its parsers publish, one plugin per
  state, made from a spec a game gives, as a turn parser is. It never sends: acquiring a piece of
  state is the acting nodes' job, through their outbox's queue (§4.6).

  ```ts
  import { statePlugin } from '@megabottron1999/turns/state-plugin.ts';

  const Item = z.object({ name: z.string().describe('Item'), count: z.number().describe('Count') });
  export const questState = statePlugin({
    id: 'quest-state',
    description: "The player's inventory at @QuestBot",
    schema: z.object({
      inventory: z
        .object({ items: z.array(Item).describe('Items'), gold: z.number().describe('Gold') })
        .describe('Inventory'),
    }),
    initial: { inventory: { items: [], gold: 0 } },
    consumes: ['quest.inventory', 'quest.gain'],
    reduce: (state, event) => /* the next state, pure */ state,
    freshness: (event, changed) =>
      event.type === 'quest.inventory' ? { inventory: 'snapshot' } : { inventory: 'delta' },
    queries: {
      count: {
        help: 'How many of an item',
        input: z.object({ name: z.string() }),
        output: z.number(),
        run: (state, { name }) => state.inventory.items.find((i) => i.name === name)?.count ?? 0,
      },
    },
  });
  ```

  - **The spec:** `schema`, a zod object whose keys are the state's **sections**, each value
    `.describe()`d (the viewer's labels); `initial`; `consumes`, the event types it applies, heard
    through a **required** events input per namespace (`events`, or `<ns>-events` for several): a
    parser disabled or stopped makes it inactive, at once and at the next start, and with it every
    node that requires it (§2.1, D65), since running on it would be frozen in time while the nodes
    acting on it go on asking; on its parser's drift (§4.7) the actors that require it are stopped
    through it, and it, of kind `stats`, goes on, as every node that does not act;
    `reduce(state, event)`, pure; `freshness(event, changed)`, what the event says of the sections
    it touches (`snapshot`, `delta` or `uncertain`; by default each section it changed a `delta`);
    `queries`, reads of its interface beside `get` and `freshness`; and `migrations` (§4.2) for a
    kept state whose schema changed (one that does not fit fails the node, with why). Its kind is
    `stats`; its namespace is its id.
  - **Kept** in its store, one document, `state`:
    `{ state, updatedAt, cursor, freshness, batch, unannounced }`. **Freshness** per section:
    `{ snapshot?: { t, event }, deltas, uncertain, updated?: { t, event } }`, "a full snapshot at T,
    plus 3 deltas since, 1 of them uncertain"; a snapshot sets `deltas` and `uncertain` back to 0.
  - **Exactly once** (§4.4, a cursor into the log): at start it subscribes to its namespaces and
    reads the log after its cursor in one synchronous step, and applies what it finds of its types,
    in the log's order; then each event live. Each day's cursor moves to the furthest event applied,
    and the state and the cursor are written together once the bus's delivery is over (a microtask):
    an event published while another is delivered reaches it first, so the cursor passes the other
    until it is applied too. A crash before the write: the next start reads both from the log again.
    A fresh instance reads the whole log. An event the reducer throws on, or whose result the schema
    refuses, leaves the state as it was, is passed (the cursor moves past it) and recorded
    (`<id>.refused`, with why), never retried.
  - **Announced** after the write: each applied event that changed a section's value or freshness as
    `<id>.changed`, `{ sections, refreshed, event: { type, t } }`; a catch-up at start as one, its
    sections summed, with no event. A crash between the write and the announcement: the batch kept
    with the state is announced at the next start (a note, `announced`, says the last done), so a
    change is announced at least once, and never lost.
  - **Its interface:** `state.get({ path? })` (the state, or the value at a dotted path: a copy),
    `state.freshness({ section? })` and the spec's queries (each given a copy of the state), each
    with its `help` and schemas, which the panel lists (bot-os.md D71).
  - **Its node's config:** `pin`, dotted paths of the state (each checked against the schema) drawn
    first in its panel; the first two make the line on its card (`2 Items · Gold: 40`: a list or a
    map counted, a value shown, each by its schema's description).
  - **Its view** (§4.11): `GET /plugins/<id>/view` gives its state with the schema as a JSON Schema,
    its freshness and its pins; the node panel's **State** section draws it with no renderer of any
    game's (`packages/web/src/ui/graph/StateViewer.tsx`): a list of objects as a table whose columns
    are the items' properties, sorted by a click on a column's head and searched across its cells; a
    map (a record) as a table of keys and values; an object as a section that folds; a list of plain
    values on a line; a plain value as a line labelled by its description; each section with its
    freshness in words.

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
(the resolve hook), `module-loader.ts` (the loading), `module-store.ts` (install and rollback),
`module-files.ts` (the modules in a folder or a repository, and each one's files),
`module-github.ts` (GitHub links and their updates) and `semver.ts`.

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
| `files`       | Optional: what an install keeps, as globs from its directory (`*`, `**`, `?`; a directory names all under it), with its `module.json` always; by default all but its tests (§7.4)  |

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

**Its mode** (§4, bot-os.md D64): the plugin API stays `"1"`, and a module written for the modes
keeps loading. Its `ctx.mode` is derived from its node's edges (`get()`: `dry-run` or `live`), its
`ctx.mode.set('read-only', 'owner' | 'safety')` stops its node, kept until the owner clears it, and
its `set('dry-run' | 'live', …)` is refused and logged, since only the editor raises a state;
`onChange` hears `read-only` at a stop, and `ctx.resume()` is refused, false. So a module that
lowers its mode from its owner commands and its safety stops stops its node with them, and its
raises do nothing: the owner clears the stop, and chooses its edges' dry runs, in the editor. An
outbox it makes of its own keeps its `Modes` (§4.6). These are deprecated: a plugin written now
calls `ctx.stop(reason)`, and its outbox handle's `mode()` says whether it sends for real.

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

### 7.4 Installing, rolling back and removing

The owner installs a module through the control API (§4.11), never an agent (P1, P11); it is loaded
at the next start (P8). The shell downloads a module only when the owner asks it to install one from
a GitHub link, and never installs or restarts on its own (bot-os.md D67). `ModuleStore`
(`<data>/modules`):

- **Install** (`POST /modules`), one module a request: from a directory of the container's
  (`{"dir": "/path"}`); from a tarball, `.tar.gz` or `.tar` (base64 in `{"tarball": "…"}`, which the
  web UI's same-origin rule allows; or the bytes as the body, with `content-type: application/gzip`,
  on the loopback); from a directory's files one by one, as a browser reads a folder picked or
  dropped (`{"files": [{"path": "dice/module.json", "content": "<base64>"}, …]}`); or from GitHub
  (`{"github": {"repo": "<owner>/<repo>", "ref": "main", "refType"?: "branch", "path": "modules/dice", "commit"?: "<sha>"}}`,
  below). A tarball or files may name their source for the owner (`"name"`). Up to 64 MiB: the body,
  and the files' bytes together. The tarball, or the files, hold the module at their root or in
  their one directory (as `git archive --prefix=dice/`, GitHub's release tarballs and a folder
  picked make it), which is stripped. A tarball holds files and directories only, nothing outside
  it; a file's path is relative to that root, with `/` (or `\`) between its parts, and one that is
  absolute, a drive's, or goes through `..` refuses the whole upload
  (`<path> leaves the module's directory`). It is staged in `.staging/`, checked (its
  `module.json`), pruned to the files it installs (below), checked again (each plugin entry must be
  among them: `its plugin entry src/p.ts is not there`), and replaces `<id>/`, whose version before
  is kept as `.previous/<id>/`. The answer is `{id, version, previous?, left?}`, `left` the files
  left out. 400 with why for what is not a module. Reinstalling an id is how a module is upgraded,
  or reinstalled at the same version (versions are not always bumped), the version before one
  rollback away.
- **What a module installs** (`module-files.ts`): the files under its directory, but `.git` and
  `node_modules` (never taken) and another module's directory nested in it. Of those, the ones its
  `module.json`'s `files` globs name (§7.1), or, without `files`, all but its tests: `*.test.ts`,
  `*.spec.ts` (and `.tsx`, `.js`, …), and the `test/`, `tests/`, `__tests__/` and `__snapshots__/`
  directories at any depth, and its own top-level `vendor/`. Its `module.json` is always kept. A
  module's runtime code is under `src/` (§7.1), which no plugin may import its tests from.
- **Its source** is recorded at each install in `<data>/modules/.sources.json`, never in the
  module's own files: `{"kind": "folder", "name"?}`, `{"kind": "tarball", "name"?}`,
  `{"kind": "directory", "path"}` or
  `{"kind": "github", "repo", "ref", "refType", "path", "commit", "commitDate"?}`, with when it was
  installed (`installedAt`). The version kept for a rollback keeps its own, and a rollback swaps
  them; an install that replaces nothing (the module removed) leaves the previous version, and its
  record, as they are. A module installed before has none.
- **The modules in a tree** (`POST /modules/plan`): a folder may be a module's or a repository's
  root with several. Given its listing
  (`{"paths": ["games/modules/dice/module.json", …], "manifests": {"<path>": "<its text>"}}`, the
  `module.json` files' text only), it answers each module found: every `module.json` at any depth,
  but under `.git`, `node_modules`, a `vendor/` directory (vendored copies, not the owner's) or a
  test directory (fixtures). Each with its `path` in the tree, `id`, `version`, `description`, its
  `status` against the version of its id installed (`new`; `update`, `same` or `older`, with the
  version `installed`), the `files` it installs and those `left` out, by their paths in the tree; or
  its `error`: its manifest refused (as `module.json: api: …`), a plugin entry missing or left out
  by its `files`, its id found twice. Nothing is installed; the web UI then sends each module the
  owner checks, with only its files.
- **From GitHub** (`module-github.ts`, #13): `POST /modules/github {"url": "…"}` takes a public
  repository's link: `https://github.com/<owner>/<repo>` (its default branch), `…/tree/<ref>` or
  `…/tree/<ref>/<path>` (a branch, which may hold slashes, a tag, or a commit). The shell resolves
  the ref to a commit through GitHub's API (`GET /repos/<repo>`, for the default branch;
  `GET /repos/<repo>/commits?sha=<ref>&per_page=1`, the commit and its date; and
  `GET /repos/<repo>/git/ref/tags/<ref>`, whether it is a tag), downloads the repository's tarball
  at that commit from codeload (`https://codeload.github.com/<repo>/tar.gz/<commit>`, outside the
  API's rate limit; the last two are kept in memory, so the installs that follow a look download
  nothing), and finds its modules under the path as above:
  `{"source": {"repo", "ref", "refType", "path", "commit", "commitDate"}, "modules": [ … ]}`. Each
  module is then installed with `{"github": {…, "path": "<the module's>", "commit"}}`, from that
  commit; without a `commit`, from the ref's head now. 404 for a repository, branch, tag or commit
  not found (a private repository reads as not found: private sources are not supported), 429 for
  GitHub's rate limit, 502 for GitHub unreachable or failing.
- **Updates:** for the modules installed from GitHub, the shell checks at its start, every 6 hours,
  and when the owner asks (`POST /modules/updates`, which answers the list): each branch's head once
  (`commits?sha=<branch>`), however many modules follow it, and each repository's tags once
  (`GET /repos/<repo>/tags`) for the modules installed from a tag. A module whose branch now names
  another commit, or whose tag has a newer semver tag (`v1.2.3` or `1.2.3`; pre-releases only after
  a pre-release), has an `update`: `{ref, commit, commitDate?, compare}`, `compare` GitHub's
  comparison of the two commits. It is installed as any install (`POST /modules` with its `github`
  source at the new commit and ref), never on its own; a module installed from a commit is pinned.
- **GitHub's limits:** without a token, its API allows 60 requests an hour. When it refuses one (403
  or 429, with `x-ratelimit-remaining: 0` or a `retry-after`), the shell makes no request to it
  until the reset, and each call says until when; the check stops, and its `error` says so. A token
  raises the limit: the `github_token` Docker secret, or `GITHUB_TOKEN` in the environment; neither
  is needed. The image's Node reaches `api.github.com` and `codeload.github.com` over HTTPS with its
  own certificate authorities; behind a proxy, set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1`, which
  Node 24 honours.
- **Rollback** (`POST /modules/<id>/rollback`): `.previous/<id>/` and `<id>/` swap, so a second
  rollback goes forward again; 409 when there is no previous version.
- **Removal** (`DELETE /modules/<id>`, bot-os.md D68): `<id>/` is moved aside as `.previous/<id>/`,
  replacing any older previous version, and its source record follows it in `.sources.json` (the
  older one dropped), so that the rollback above restores it (the Modules page's **Restore**). The
  answer is `{id, version?}`. Refused, 409 with why, while the module is used:
  `dice cannot be removed: the saved graph's node roller (dice-roll) uses it: delete or replace it first; module cards imports it (@example/dice)`.
  A node uses it when its plugin is one that the module's loaded version offers, read from the saved
  `graph.json`, disabled nodes too; a module not loaded offers none the instance knows. A module
  imports it when its manifest's `imports` names what it `provides`. 404 for a module not installed.
  Like an install, it takes effect at the next start (P8). A module removed stays listed as such,
  restorable, until an install of its id replaces it; that install keeps the version removed as its
  previous. It is not checked for updates (its source record is no longer current).
- **The list** (`GET /modules`): each module installed (its manifest, or why it does not read), its
  `source` (above), the version kept for a rollback (`previous`), the version the running instance
  loaded (`loaded`), its `update` if the last check found one, the modules it refused at its start
  with why (`failures`), whether a restart would change what is loaded (`restart`), and the last
  check for updates (`updates`: `checkedAt`, and its `error`). Each module installed has `inUse`,
  why it cannot be removed now, when it cannot; the modules removed are listed apart (`removed`,
  only when there are some), each with its version kept, its manifest's description or why it does
  not read, its `source` and the version `loaded`. `GET /available` lists the plugins the instance
  offers, each as the editor adds a node of it (`describePlugin`, `PluginView`): its id, its module
  (none for the image's own), version, description and kinds, its account, its input and output
  ports, its interface, the JSON Schemas of its config and settings, the secrets it declares, the
  keys of its config that name one (`configSecrets`), and the event types it registers.

From the host, through the loopback: `docker cp dice/ megabottron1999:/tmp/dice`, then
`docker exec megabottron1999 wget -qO- --header 'content-type: application/json' --post-data '{"dir":"/tmp/dice"}' http://127.0.0.1:8081/modules`,
and restart it (`POST /restart`). The web UI's Modules page does the same: **Choose folder** (or a
folder dropped on the page) or a GitHub link pasted lists the modules found as a checklist (each
with its path, version and status, and its files left out; all checked but downgrades), installs
those checked one by one, each on its own, and says how each went; it shows each module's source
(linked to GitHub at its commit) and when it was installed, its update (**Update**, **Update all**,
**Check for updates**), installs a `.tar.gz`, rolls one back, removes one (**Remove**, confirmed in
a dialog that names it; disabled, its reason shown on hover, while the module is used) and restores
one removed (**Restore**), and offers the restart.

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
- **Shipping:** the owner installs from the repository's folder (its root: every module is found,
  `vendor/` aside) or, for a public repository on GitHub, from its link, and updates from it (§7.4);
  `git archive --prefix=dice/ -o dice.tar.gz HEAD:packages/dice` makes the tarball of one module. A
  module's tests are left out of the install; one whose runtime needs other files than the defaults
  keep lists them in its `module.json`'s `files` (§7.1), which an older shell than `v0.1.0-alpha.12`
  refuses.

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
  settings come too; its mode does not: whether its node sends for real is its chat-out edges'
  (bot-os.md D64), and the mode it had is only reported. 409 for an instance kept already, 400 for
  an unknown plugin. An instance no node uses is deleted after 7 days, as any.
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
