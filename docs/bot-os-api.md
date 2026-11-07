# MegaBotTron1999: the plugin API

Documented as of 7 Nov 2026. The plugin model of MegaBotTron1999 ([bot-os.md](bot-os.md)): what a
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

| Field         | Meaning                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Lower-case words and dashes (`dice-roller`), unique in the instance; the name of its store, its settings and its log lines. `core` is reserved                                                                                                                                                                                        |
| `version`     | Semver of the plugin                                                                                                                                                                                                                                                                                                                  |
| `kinds`       | One or more of `connector`, `parser`, `actor`, `stats` (stats and commands), `agent`, `simulator` (bot-os.md §1)                                                                                                                                                                                                                      |
| `description` | One line, for the UI and the agents                                                                                                                                                                                                                                                                                                   |
| `archived`    | An archive (bot-os.md D32): built and tested, but refused in every instance's graph; only a run that says `allowArchived` (a test, the dev kit, a manual-test tool) runs it                                                                                                                                                           |
| `inputs`      | Its input ports, by name (§2.1): what it consumes, each of a port type, with the binding the default graph gives it                                                                                                                                                                                                                   |
| `requires`    | Shorthand (§2.1): the plugins it needs started first, by id, read as input ports. The load order follows them; a missing one or a cycle fails the start, naming it                                                                                                                                                                    |
| `games`       | `registers`: the namespaces whose event types it defines (its game's, or its own id); `consumes`: those whose events it reads (P7)                                                                                                                                                                                                    |
| `events`      | The event types it registers, `<namespace>.<name>` → zod schema of the payload (§4.4)                                                                                                                                                                                                                                                 |
| `uses`        | Shorthand (§2.1): the other plugins' interfaces it calls, by id and member (`{ dice: ['state.game'] }`): reviewed with both (P6)                                                                                                                                                                                                      |
| `reach`       | Shorthand (§2.1): what it reads and sends, per connector: `{ connector, reads: chats, sends: chats, commands }`. The outbox refuses a send outside it (§4.6)                                                                                                                                                                          |
| `config`      | A zod object: what is set at deploy. The core validates it at load; a bad value names the plugin and the key                                                                                                                                                                                                                          |
| `settings`    | A zod object: what the owner changes at runtime, each key with its default and its help (`.describe()`). Kept in the plugin's store, offered to every control surface (P11)                                                                                                                                                           |
| `secrets`     | The secrets it needs, by name (`znc_password`). Only a `connector` may declare any (P9); the manifest of any other kind that does is refused                                                                                                                                                                                          |
| `state`       | `{ version, migrations }`: the schema version of its store and the steps from each older one (§4.2)                                                                                                                                                                                                                                   |
| `drift`       | The parser's threshold for an unrecoverable rate of unread messages (§4.7)                                                                                                                                                                                                                                                            |
| `interface`   | What it offers people, commands and agents (P11): `commands` (chat commands: name, help, arguments), `actions` (typed calls that change something: zod input and output) and `state` (typed reads, by name: zod output). The web UI, the chat commands and the agent interface are all made from these descriptions, and nothing else |

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
edges are the permissions (P6): a plugin reaches a connector, an outbox, an interface or a
namespace's events only through an input an edge binds.

| Port type   | Output (derived from the manifest)                                       | Input (declared)                                                                                                 |
| ----------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `chat`      | `chat`: a connector's account, of its network                            | `{ type: 'chat', network? }`; its edge carries the chats it `reads` and `sends` to, and the `commands` sent      |
| `events`    | `events` (`<ns>-events` with more than one): each namespace it registers | `{ type: 'events', namespace }`, bound to any number of instances; it hears only theirs                          |
| `interface` | `interface`: its declared reads and actions (every plugin has one)       | `{ type: 'interface', plugin, members }`; none for a plugin it only needs started first; no `plugin`: a contract |

An interface input that names no plugin is a **contract**: any node whose interface declares its
members binds it (`interface with state.rest, actions.sent`), so each instance of one plugin may use
another plugin's interface (each turn-actor instance its own bot's parser, §5). It has no default
edge: the graph binds it.

Each port type has a stable id, a description, and a shape and a colour for the drawing
(`PORT_TYPE_INFO`). An input may be `optional`: it may be left unbound, imposes no order and fails
nothing, and the plugin asks for it when it needs it (`ctx.useOptional`, undefined while unbound or
while its other end is not running), so that two plugins can each use the other without tying their
failures together. Every other input is required: it must be bound, the instance it binds starts
first, and its failure fails this one.

A manifest's `inputs` give each input its `bind`, the edge the default graph makes
(`{ node, reads, sends, commands }` for a chat; `{ node }` for an interface, by default the node of
the plugin's id; `{ nodes }` for events, by default every other node registering the namespace). The
manifest's older fields stay as shorthand, read as inputs: a `requires` that `reach` names is a
required chat input named after the connector, with the reach's chats and commands as its binding;
any other `requires`, and each plugin `uses` names, a required interface input named after it;
`games.consumes` an optional events input, `<namespace>-events`; a `reach` not required, an optional
chat input. A plugin's code names its inputs: `ctx.connector('channel')`, `ctx.outbox('channel')`,
`ctx.use('game')`.

**The graph** is `{ version: 1, nodes, edges }`:

```json
{
  "version": 1,
  "nodes": [
    { "id": "irc", "plugin": "irc", "config": { "host": "znc.example.net", "nick": "alice" } },
    { "id": "dice", "plugin": "dice" }
  ],
  "edges": [
    {
      "from": "irc.chat",
      "to": "dice.channel",
      "type": "chat",
      "reads": ["#lobby"],
      "sends": ["#lobby"]
    }
  ]
}
```

A node is a plugin instance: its id (a plugin id's form), the plugin it instantiates (one the image
or a module offers, registered with `core.register`), its configuration, and, for a connector, its
own `account` in place of the manifest's (of the same network). An edge goes from `node.port` (or
`node`, when one of its outputs fits) to `node.port`, with its type and, for a chat, what it
carries. The core checks it with zod and against the manifests at load, and fails the start naming
the node and the port: a plugin not in the image, a node twice, an edge between ports of two types
or to a port that is not there, an interface member not declared, a single input bound twice, a
connector account held twice, a required input unbound
(`node actor: input port channel (chat of irc) is not bound`), a cycle of required edges.

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
out. A changed graph takes effect at the next start (P8). Today's entry point (`src/main.ts`)
registers the connectors and runs an empty graph; from the next step the graph is read from the
volume (`/data/graph.json`, bot-os.md D50), and plugin instances get kept state apart from their
nodes.

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
  begins. **Stop** runs in the reverse order, at `SIGTERM`, each plugin's `stop` awaited for up to 5
  seconds (a stop that fails or takes longer is logged, and the next plugin stops).
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
  service?: unknown; // what a service connector makes from its secrets (§4.9)
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
  record(type: string, fields: object): void; // the event log, in its registered namespaces
  clock: Clock; // now(), and timers; virtual in tests and simulators
  store: Store; // §4.2
  scheduler: Scheduler; // §4.3
  bus: Bus; // §4.4
  config: Config; // validated (§2)
  settings: { kept(): Partial<Settings>; set(key, value): string | undefined }; // §2
  connector(port: string): ConnectorHandle; // §4.5, a chat input an edge binds (§2.1)
  outbox(port: string): Outbox; // §4.6, the account a chat input's edge binds
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

A connector's context also has `secrets.get(name)`, for the secrets it declared.

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

`/data/plugins/<id>/` (P6), one directory per plugin instance, under the data volume:

- `read(name)` and `write(name, value)` of JSON documents, by name (letters, digits, `-`, `_` and
  `.`: no path), written atomically (a temporary file, then a rename), so that a crash leaves the
  old document or the new one, never half of one.
- `version`: the schema version kept with the documents (`_meta.json`). At start the core runs the
  manifest's migrations from the kept version up to the manifest's, each one awaited; a failed one
  leaves the store as it was, and fails that plugin only (§3).
- `adopt(file, name, read?)`, for migrations only: moves a file of the data volume into the store,
  read as JSON, or by `read` from its bytes. No file of the stores (`plugins/…`) and nothing outside
  the volume can be adopted.

A plugin reaches nothing outside its own directory. Data of another plugin comes through that
plugin's interface (`use`), never its files.

As built (`packages/core/src/store.ts`): documents are `<name>.json`, written with mode 600 in a
directory of mode 700; the core keeps its own beside them (`_meta.json`, the version;
`_restore.json`, what `serialise` returned, handed back once; `_timers.json`; `_settings.json`).
Migrations run on a staged copy (`<id>.migrating/`) that replaces the directory only when every step
has succeeded, so a failed one leaves the store as it was, and a store newer than its plugin (an
image rolled back) fails that plugin rather than being read wrong. A crash between the two renames
of the commit is undone at the next start. A file adopted from the root is renamed `<file>.migrated`
once the migration has succeeded.

**Backups.** The whole data volume is the instance's state: the event log and the stores (and, from
the next step, the graph and the modules). Back up the volume as one, with the instance stopped for
the copy, so that no document is caught between writes. Restore it as one too: a store restored
without the event log, or the reverse, would replay a history the state does not match. A single
plugin's state can be restored on its own by putting back its directory, `plugins/<id>/`, while the
instance is stopped.

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
- Every event published is written to the event log, as `{ type, t, ...payload }`, one JSON line per
  record in a file per UTC day (`packages/core/src/event-log.ts`). The log may be given a table of
  older type names (`legacy`), under which old files are read back.

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
status for the implementations. `ctx.connector(port)` gives a handle only on a connector a chat
input of the plugin is bound to, and the handle hears only the chats that edge `reads` (compared
without case). The wiring reaches the full connector with `core.connector(id)`. The shell's
connectors are in §5.

### 4.6 The outbox

One per account; every send goes through it (bot-os.md §3). A plugin gets its handle with
`ctx.outbox(port)`, bound to its own id:

- **The mode (P10)** of the sending plugin: `read-only` refuses, `dry-run` logs as if sent, `live`
  sends. Every acting plugin has one, starts `read-only`, is changed only by the owner (a safety
  stop may only lower it), and keeps it across restarts, in the core's store
  (`/data/plugins/core/modes.json`).
- **The reach:** each edge to the account's connector lets it send to its `sends`, with its
  `commands`; a send outside them is refused.
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
for drift) and of what a plugin asks to say (`notify`): through the core, to the chat surface of the
connector the wiring names the owner's (`CoreOptions.owner`), waiting for it to start, or to
`CoreOptions.notify` without one, and never while the instance is off. The owner's controls are the
core's (§4.11).

### 4.9 Secrets

Secrets come in as Docker secrets, files under `/run/secrets` (P9), are given only to the connectors
that declared them, and are redacted (`[redacted]`) from every log line, record and error that
passes through the core.

As built (`packages/core/src/secrets.ts`): `Secrets` reads each file once (its trailing newline
dropped) and remembers every value read, for `redact` and `redactDeep` (values under 6 characters,
or only digits, are not redacted, to spare ordinary text); the core passes what it prints, records
and tells, and a failed plugin's reason, through them, and the entry point its `console` and its
event log. A connector's `ctx.secrets.get(name)` gives only the secrets its manifest declares; no
other kind of plugin has `ctx.secrets`; a declared secret not provided fails the load, naming it and
its file. `core.service(id)` gives the wiring what a service connector made from its secrets (an API
client), never the secret. `core.secretStore` keeps the core's own secrets (a login done later
through the UI), each in `/data/plugins/core/secrets/<name>.json` of mode 600: AES-256-GCM with a
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
  documents their stores start with (`documents`). An archived plugin runs on a kit only when the
  run says so (`allowArchived`). `start` refuses a setting refused and a run with a plugin failed;
  `runUntil(t)` runs the clock. The core is the instance's own, unchanged.
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
  (`/data/plugins/core/power.json`) across restarts, logged as `core.power`, and a plugin reads it
  with `ctx.off()`. The outbox does not refuse sends while off: a plugin's `off` stops it (D30).
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
action's input (400 for an input refused by its schema, 409 for the plugin's refusal). Ids and names
in a path may be URL-encoded.

### 4.12 The graph printed and drawn

`packages/core/src/graph-view.ts`: `graphText` prints the nodes and the edges
(`irc.chat → dice.channel (chat): reads #lobby; sends #lobby`); `graphMermaid` draws a Mermaid
flowchart, left to right, a box per node and an arrow per edge, coloured by its port type;
`writeGraphFile` writes a graph to `<dir>/graph.json` atomically, the one before kept as
`graph.previous.json` when it changed. `packages/core/tools/graph.ts [file] [--mermaid]` prints a
graph file.

**The graph view** (bot-os.md D47) is the web UI's home page (`packages/web/src/ui/graph/`), drawn
with React Flow. It reads `GET /graph/view`: the graph the instance runs (its secrets redacted), the
port types' looks (`PORT_TYPE_INFO`) and each node as `describeNodes` makes it from its plugin's
manifest: its version, description, kinds and account, its configuration, its input and output
ports, the reads, actions and commands its `interface` declares, and the JSON Schemas of its
`config`, its `settings` and its actions' inputs and outputs and reads' outputs (zod's
`toJSONSchema`). It polls `GET /status` and `GET /drift` for each node's live state, mode and drift.
A node selected shows its details, its config and settings in read-only forms made from those
schemas (the editor's to make editable); one or several selected can be killed, each by
`POST /plugins/<id>/kill`.

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

## 5. The shell's own plugins

| Plugin          | Kinds     | Package                       | What it is                                                                                   |
| --------------- | --------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| `irc`           | connector | `@megabottron1999/connectors` | An IRC account through a ZNC bouncer, with its flood limits and a health endpoint            |
| `telegram-bot`  | connector | `@megabottron1999/connectors` | A Telegram bot (grammY), and the owner's chat surface                                        |
| `telegram-user` | connector | `@megabottron1999/connectors` | A Telegram user account (GramJS), reading and sending in the chats of its configuration      |
| `anthropic`     | connector | `@megabottron1999/connectors` | The Claude API: `ask`, with structured output (§4.13)                                        |
| (service)       | connector | `@megabottron1999/connectors` | `ServiceConnector`: the connector of a plugin that holds secrets for an API client, no chat  |
| (turn parsers)  | parser    | `@megabottron1999/turns`      | `turnParserPlugin`: a parser of one game bot's answers to turns, from a grammar a game gives |
| `turn-actor`    | actor     | `@megabottron1999/turns`      | One game bot's turns, at a person's pace, run as one instance per bot                        |

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
  optionally a group (`owner`, `group`), it is the instance's chat surface (`telegram-surface.ts`):
  the switchboard on its bot (`telegram-switchboard.ts`, on grammy-switchboard), the plugins'
  commands answered in the group, the owner's chat and any other private chat
  (`telegram-commands.ts`), the menus kept registered, and the owner's notices carried in order
  (`telegram-notifier.ts`). Nothing hands its bot out (P9).
- **`telegram-user`** (`packages/connectors/src/plugins/telegram-user.ts`, on GramJS in
  `packages/connectors/src/transport/telegram-user.ts`): the owner's own account, from three secrets
  (`telegram_user_api_id`, `telegram_user_api_hash`, `telegram_user_session`). It reads only the
  chats of its configuration (`chats`: a group by its id, a private chat with a bot by the bot's
  `@username`, P3), since the account sees every chat of its owner. It starts without waiting,
  retries every minute, and tells the owner of the first failure; a message carries its id, the one
  it replies to, and `own` for the owner's own from any device. It sends only through the account's
  outbox (`deliver`, with the message's id); GramJS's flood waits become `FloodWait`.
- **`ServiceConnector`** (`packages/connectors/src/plugins/service.ts`): for a connector plugin that
  holds an account's secrets and makes an object from them for the wiring (`Instance.service`), but
  has no chat: it reads and sends nothing. The `anthropic` connector is one.
- **`anthropic`** (`packages/connectors/src/plugins/anthropic.ts`, on the Anthropic SDK): the Claude
  API's account (`anthropic:api`, or the name it is given), made from its `anthropic_api_key` secret
  at `create`, a `ServiceConnector`. Its configuration holds the defaults of `ask` (§4.13): `model`
  (`claude-opus-5-5`), `maxTokens` (16000) and `effort` (unset: the model's own). It offers `ask` as
  its interface's action, for the plugins an edge binds to it, and as its `service`
  (`core.service('anthropic')`), for the wiring. A system prompt is sent with a cache breakpoint
  (the API's default five minutes), so calls that share one pay for it once.
- **`turnParserPlugin`** (`packages/turns/src/turn-parser.ts`): one parser plugin per game bot, each
  made from its bot's grammar (`read`), which knows the game. Each reads, on the owner's account
  (`telegram-user`), the private chat with its bot and optionally a group, read only. It knows the
  owner's turns (a turn command of its configuration, `commands`, bare or addressed to its bot, sent
  by hand from any device; and those its actor sends, told through its action `sent`, since the
  account never sees its own sends come back), and which of its bot's messages answer one: a reply
  to it or, in the private chat, the first message within two minutes of it. What it reads it
  publishes as `<id>.turn` (`{ chat, outcome }`); a message it claims and cannot read goes to drift
  (§4.7) and is published as an `unknown` outcome. Its read `rest` says until when the bot rests,
  from its last answer. The tests play a made-up @QuestBot (`packages/turns/test/quest.ts`).
- **`turn-actor`** (`packages/turns/src/turn-actor.ts`): one plugin run as one instance per game bot
  (P3, P17), each with its own id, configuration, store, timer and mode. Its inputs: `chat`, a chat
  on `telegram`, bound to the private chat with its bot (read and sent to, its command only), and
  `parser`, a contract (`state.rest`, `actions.sent`) bound to its bot's parser, required, so that
  drift on the parser pauses it. Its configuration: `chat` (the bot's `@username`), `command` (the
  bot's turn command; `/play` when unset), `schedule` (changes to the planner's defaults:
  `packages/turns/src/schedule.ts`, 17–20 minutes between turns, some skipped, nights off in its
  `timeZone`), `nightSalt` (the instances with one salt sleep the same nights) and `seed`. It plans
  from the owner's last turn with the bot (kept in its store; a turn sent by hand counts too), as
  the durable timer `turn` (dropped if it came due more than 10 minutes before a start); when it is
  due, it asks its parser whether the bot rests and, if so, comes back a few minutes after; in
  `live` it waits for the account to be connected, sends through its outbox and tells its parser the
  message's id; a failed send is tried again two minutes later. It plays in `dry-run` and `live`
  only (a new instance starts `dry-run`, D33). It declares no chat command, since two instances
  would clash: the owner reaches each with `/plugins <id>` and its read `status`. Each step is
  published as `turn-actor.step`.

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
