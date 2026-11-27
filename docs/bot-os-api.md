# MegaBotTron1999: the plugin API

Documented as of 13 Nov 2026. The plugin model of MegaBotTron1999 ([bot-os.md](bot-os.md)): what a
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

| Field             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`              | Lower-case words and dashes (`dice-roller`), unique in the instance; the name of its store, its settings and its log lines. `core` is reserved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `version`         | Deprecated, ignored (bot-os.md D166): still accepted, no longer required. A plugin's version is its module's, or the release's for one of the image's own (§4.11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `kinds`           | One or more of `connector`, `parser`, `actor`, `stats` (stats and commands), `agent`, `simulator`, `view` (bot-os.md §1, D170)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `description`     | One line, for the UI and the agents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `archived`        | An archive (bot-os.md D32): built and tested, but refused in every instance's graph; only a run that says `allowArchived` (a test, the dev kit, a manual-test tool) runs it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `inputs`          | Its input ports, by name (§2.1): what it consumes, each of a port type, with the binding the default graph gives it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `outputs`         | Its declared output ports, by name (§2.1): its `chat-out`s, what it sends through a connector's account, with the binding the default graph gives each; a connector's `commands`, the plugins' chat commands it serves (bot-os.md D109). Its other outputs are derived, and so is a plugin's `commands` input, from its `interface.commands`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `requires`        | Shorthand (§2.1): the plugins it needs started first, by id, read as input ports. The load order follows them; a missing one or a cycle fails the start, naming it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `games`           | `registers`: the namespaces whose event types it defines (its game's, or its own id); `consumes`: those whose events it reads (P7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `events`          | The event types it registers, `<namespace>.<name>` → zod schema of the payload (§4.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `answers`         | Optional, a parser's: which of its own events answer which commands (bot-os.md D98), `[{ event, commands, when?, unless?, status, reason?, reasonFrom?, withinS? }]` (§4.6, Command answers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `uses`            | Shorthand (§2.1): the other plugins' interfaces it calls, by id and member (`{ dice: ['state.game'] }`): reviewed with both (P6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `config`          | A zod object: what is set at deploy. The core validates it at load; a bad value names the plugin and the key. Every default is in the schema, per field (`.default()`, nested ones included), never merged in code after parsing, and each field says what it is (`.describe()`): the editor shows both. Two more keys, through `.meta()`, shape its form (bot-os.md D127): `choices: { value: 'label' }` on an enum draws it as radio buttons by those labels, and `shownWhen: { key: value }` on a field shows it only while a sibling key has that value (its default counted), the field taken away when a change makes it not apply                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `settings`        | A zod object: what the owner changes at runtime, each key with its default and its help (`.describe()`). Kept in the plugin's store, offered to every control surface (P11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `secrets`         | The secrets it needs, by name (`znc_password`). Only a `connector` may declare any (P9); the manifest of any other kind that does is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `configSecrets`   | The keys of its `config` whose values name a secret (§4.9): a connector run as several nodes, each with a credential its node's config names. Only a `connector`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `configSensitive` | The keys of its `config` whose values are sensitive (§4.9, bot-os.md D124): sealed in the graph's file and its history under `bot_os_key`, opened for the running node only, never shown back by any view of the graph; the editor writes them and says whether they are set. Any kind of plugin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `login`           | A connector that logs in from its node (§4.5, bot-os.md D116, D118): its instance offers a `login` and keeps the credentials in its store, never in Docker secrets; the secrets it declares, if any, are required as any connector's. Only a `connector`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `model`           | A connector to a model that bills by the call (§4.5, bot-os.md D117): the editor marks its node with a `$`, and it logs each call with its cost. Only a `connector`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `chat`            | Whether a connector's account has a chat (§2.1, bot-os.md D148): by default `true`, its node a chat-in output and a chat-out input, both `chat`; `false` for a service connector (an API's account, as `anthropic`), which has neither and offers its interface alone, and serves no chat commands and monitors no chat. Only a `connector` says `false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `monitors`        | Optional, a connector's: which chats its node monitors, so that the check warns of a chat-in edge reading one it does not (§2.3, bot-os.md D89): `'all'`, every chat it hears; or `{ config: key }`, the key of its `config` holding the chat (a string) or the chats (a list), unset meaning every chat; chats compare without case. Undeclared: unknown, and nothing is warned of. `{ config: key, aliases: true }`: a chat may go by several names (an id, a `@username`, bot-os.md D90), which its running connector tells (`chatNames`, §4.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `notices`         | Optional, `true` for a plugin that hears the owner's notices (`ctx.notices`, §4.16, bot-os.md D91), as `owner-notice` does; false by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `summary`         | Optional, `true` for a plugin that adds lines to the owner's summary, or reads it (`ctx.summary`, §4.17, bot-os.md D92); false by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `state`           | `{ version, migrations }`: the schema version of its store and the steps from each older one (§4.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `drift`           | The parser's threshold for an unrecoverable rate of unread messages (§4.7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `interface`       | What it offers people, commands and agents (P11): `commands` (chat commands: name, help, arguments), `actions` (typed calls that change something: zod input and output) and `state` (typed reads, by name: zod output). The web UI, the chat commands and the agent interface are all made from these descriptions, and nothing else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `widget`          | Optional: its node's widget (bot-os.md D112), one section made from one of its reads, drawn in a line on each of its nodes' cards (below, Widgets and pages)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `page`            | Optional: its node's full page (bot-os.md D112), `{ title, sections }`, sections of the widget's kinds, opened from its node's panel (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `view`            | A view's (bot-os.md D170): `{ title, selector?, sections }`, each section a page's with the interface input it reads (`from`); served at `/v/<path>/` (below, Views)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `node`            | Optional: each node's own manifest, from its config and its id, for a plugin whose ports its node's config declares (below, bot-os.md D74)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `configInputs`    | Optional, with `node`: where its nodes declare their own inputs, `{ key, types }`: the key of its `config` holding a record of input ports by name, written as a manifest's, and the types it takes there (`events`, `interface`); the editor adds one there for an edge dropped on such a node (below, bot-os.md D80)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `configChats`     | Optional: the keys of its `config` that name a chat (bot-os.md D96), `[{ key, output?, input?, kinds?, template?, owner?, sender? }]`, so that the editor picks each in its chat picker from its connector's chats instead of having the owner type an id: the connector is its own node (a connector's, no port named), or the one at the other end of the edge from its chat-out `output` or to its chat-in `input`; a string or a list holds the chats as the connector names them (`Surface.id`), a number a chat by its numeric id; `kinds` the kinds it takes (`private`, `group`, `channel`, `bot`); `template`, a `{path}` template may stand for the chat instead; `owner`, a connector's key naming its account's owner's chat (`owner()`, §4.5); `sender`, a key naming people it recognises, not chats it sends to (bot-os.md D100): its picker says nothing of reaching them, and the editor writes them on no edge. A chat picked for a key with an `output` or an `input` (not a template) is **written on that edge too** (its `sends`, or its `reads` unless `"*"`), and replaced there when the pick changes, the chats added by hand kept (bot-os.md D97): the edge is what lets it send. `telegram-bot` declares its `owner` (a person, `owner: true`), `group` and `deny` (people and bots, `sender: true`), the reactor its `chat` (or a template) and `in`, `attention` its `listen` (D138) |
| `warns`           | Optional: what a node's config makes it do that its owner may not mean (bot-os.md D138), a function of the node's config as written (`{}` without one) returning lines, each a warning of the check (`node <id>: <line>`), which refuses nothing and the editor shows on the node: `attention` warns, neither scheduled nor following, that it never plays                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `botCommands`     | Optional, a game bot's readiness state's (bot-os.md D137, D140, D141): its bot's commands, in order, the turn first, each once with its other names, `[{ command, aliases?, turn?, cooldownMin?, resetsAt?: { times, timeZone }, unlock?: { pattern?, forMin? }, effects?: [{ command, clear?, shortenMin? }], interactive? }]` (§5, `statePlugin` writes it from its `readiness`: its parser's vocabulary and its game's mechanics; a name or an alias names one command only, never twice in any case), so that the editor knows them without the node running, for a player's checklist; carried into the plugin's view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `botUsername`     | Optional, a game bot's readiness state's (bot-os.md D139, D141): its bot's username, without `@` (`statePlugin` writes its parser's `bot`), so that the editor names a command addressed to it (`/play@QuestBot`); carried into the plugin's view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `configPlays`     | Optional, a player's (bot-os.md D137, D140, D141): `{ key, input, output }`, the key of its `config` that lists the commands it plays, its interface `input` whose edge binds the readiness state whose `botCommands` they are picked from, and its chat-out `output` whose edge the editor keeps allowing the forms it may send them as. The editor draws that key as a checklist (§4.16)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `audit`           | Optional: keys of its `config` whose every change a save or rollback of the graph records in the event log (`core.config`: who, when, the value's SHA-256, never the value; §2.3, bot-os.md D75)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

A connector's manifest also names its **account** (§4.5): its network, and the account it holds in
the programmatic wiring's default graph (a test's, the dev kit's); in a graph file each node is on
`<network>:<node id>` unless it names one (bot-os.md D119).

**A node's own manifest** (bot-os.md D74): a plugin whose ports its node's config declares (a script
node, §5) gives `node(config, id)`, which makes each node's manifest from its config (as the schema
makes it; as written when the schema refuses it, the load then saying why) and its id. What it
returns is checked as any manifest, and must be of the plugin's id; another id, or a manifest
refused, is the node's problem (`node look: bad manifest: inputs.heard…`), and the plugin's own
stands in for it. The node's ports, kinds, registered namespaces and event types are then its own
everywhere: the check and its edges, the bus, the drift, the queue, the log's reads, `GET /status`,
and the editor, which draws the node as `POST /graph/check`'s `views` say its draft config declares
it (§2.3). `core.available()` (`GET /available`) describes the plugin's own.

**Its inputs grown by the editor** (bot-os.md D80): such a plugin may say where its nodes declare
their inputs (`configInputs: { key, types }`, the script plugin's
`{ key: 'inputs', types: ['events', 'interface'] }`), which `GET /available` passes on. An edge the
owner drops on such a node, on its card rather than one of its ports, from an output of one of those
types, is bound to an input of the node that takes it (an events input of the output's namespace; an
interface input of the output's plugin, unbound); when several take it, to the one bound to that
output already, or else the only one not bound yet, and otherwise to none, the editor naming them
for the owner to drop it on the port of one (bot-os.md D84). With none, it is bound to a new one
written under that key: an events input of the namespace, or an interface input of the plugin with
no member, which the owner picks in the node's panel (the check says so until then); named after the
namespace or the plugin, with `-2`, `-3`… when taken. A manifest that declares it without `node`, or
on a key its config has not, is refused. Only inputs grow: an output the node declares (a script's
chat-out) is the owner's to add.

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
other is running. An action is called with its input and, as its second argument, who calls it
(`ActionCall`, bot-os.md D117), which the core adds and the caller neither passes nor forges:
`{ node }`, the node whose interface input the call came through, or `{}` for the owner's controls
(the panel's actions, `POST /plugins/<id>/actions/<name>`); a model connector logs each call by it.
A read may declare an `input`, a zod object whose fields are its arguments (bot-os.md D72): its
function is called with it (`state.get({ path: 'inventory.items' })`), the owner's controls parse it
against the schema, and the control API takes it from the query
(`GET /plugins/<id>/state/get?path=inventory.items`); a read without one is called with none.

**Widgets and pages** (bot-os.md P16, D11, D112; `packages/core/src/widgets.ts`; a node's page is
deprecated since D169, for view nodes, #87). A plugin may declare what the web UI draws of each of
its nodes, made from its own reads (`interface.state`), with no code of its own in the UI: a
**widget**, one section drawn in a line on its node's card in the graph editor (so keep it to what
the owner wants at a glance: the map is for the architecture), and a **page**, a title and its
sections, for what does not fit there, opened from its node's panel (`#/node/<id>`). They are its
nodes', not its plugin's: each node shows what its own instance's reads answer. A made-up game's
ledger, for one:

```ts
manifest: {
  // …
  interface: {
    state: {
      ledger: {
        help: 'Its gold, and what moved it',
        output: z.object({
          gold: z.number().describe('Gold'),
          cap: z.number().describe('Bank cap'),
          entries: z
            .array(z.object({ what: z.string().describe('What'), gold: z.number().describe('Gold') }))
            .describe('Entries'),
        }),
      },
    },
  },
  // On its card: `Gold: 40/100`, with a bar.
  widget: { show: 'progress', read: 'ledger', path: 'gold', of: 'cap' },
  // Opened from its panel.
  page: {
    title: 'Ledger',
    sections: [
      { show: 'counter', read: 'ledger', path: 'gold' },
      { show: 'table', read: 'ledger', path: 'entries', columns: ['what', 'gold'], max: 50 },
    ],
  },
},
```

A section, in full:

```text
{
  show: 'keyValue' | 'counter' | 'list' | 'table' | 'progress' | 'until',
  read: 'status',          // a read of its interface.state
  input?: { day: 3 },      // the read's input, for one that takes one, as its schema parses it
  path?: 'inventory.items', // where its value is in the read's output (dotted; none: all of it)
  label?: 'Items',         // none: the description of the output's schema there, else the last key
  // and, by kind:
  fields?: ['gold', { path: 'name', label: 'Who' }], // keyValue: the fields shown (none: every key)
  item?: 'name', max?: 20,                            // list: each item's path, at most so many
  columns: ['what', 'n'], max?: 20,                   // table: a column each, within each row
  //   a column may be a picture (D157): { path: 'picture', label?: 'Picture', show: 'image',
  //   from?: 'files' | 'media' }, or a list of them, one at a time (D163):
  //   { path: 'ads', label?: 'Ads', show: 'carousel', from?: 'files' | 'media' };
  //   and a table may have row actions (D157):
  //   actions?: [{ label: 'Re-roll', action: 'repaint', input?: { place: '$row.place', what: 'ad' },
  //                current?: { host: '$row.host' }, confirm?: 'Re-roll this picture?' }]
  of: 'cap' | 100,                                    // progress: the total, a path or a number
}
```

`keyValue` shows a value's fields, `label: value` each (or the value itself, a scalar); `counter` a
number, or how many items a list or a map holds; `list` a list's items (or a map's values); `table`
the same as rows; `progress` a number out of its total, as a bar; `until` a time (ms since the
epoch, or an ISO string) as how long until it, or since, and its UTC time on the page (a string that
is no time, as it is: an `attention` that plans no sittings says `follows your play`). On the card
each says one line: `Gold: 40 · Who: alice`, `12 Items`, `Bag: rope, lamp, map +1`, `4 rows`,
`Quest: 3/10` (with a bar), `Next turn: in 12m 5s`; it moves with the clock, and the card is a line
taller for it, whether the node runs or not. The manifest's check refuses a section whose read it
does not declare, an input the read's schema refuses (or any input to a read that takes none), a
path the read's output schema has not (a path into a value its schema leaves open, `z.unknown()`,
stands), and a value of a kind the section cannot show (a counter of a string, a list of a number, a
progress of no number, an `until` of a list):
`plugin ledger: bad manifest: widget.path: the read status has no silver`. Give the output's fields
a `.describe()`: it is their label. The core reads the widget's read for each running node with
`GET /status` (its `widget`, the read's output; none while its read throws), which the editor asks
every five seconds; the page asks each of its reads (once, however many sections show it) every five
seconds while it is open. The player's, for one (§5):
`widget: { show: 'until', read: 'status', path: 'next' }`, and a page **Plays** with its chat and
commands, its last play and its next.

**A table's pictures and row actions** (bot-os.md D157). A column `show: 'image'` shows its value as
a thumbnail that opens it whole, an empty value an empty cell: `from: 'files'` (the default), a file
name in the node's own files (§4.2, D149), served as `GET /plugins/<id>/files/<name>`;
`from: 'media'`, a `Media` as JSON carries it (its bytes shown as they are), or a kept one's
reference `{ id: 'sha256:<hex>', mime }`, whose file is `sha256-<hex>` (a collection's, D155). A
column `show: 'carousel'` (D163) takes a list of such values (an empty list, or none, an empty cell;
an item that is no picture, skipped) and shows one at a time, at an `image`'s size: its thumbnail,
which opens it whole, a previous and a next button that go round, and its place (`3 / 12`); a list
of one, its thumbnail alone. No autoplay. As the page reads again, each row's carousel keeps the
picture it shows (found again in its list, else at its place), even when the row is drawn anew for
holding something else (its key, what it holds: #79); it is the row's name, its first column's text,
that tells it, so two rows of one name share it. A table's `actions` give each row a button per
action, running the node's action of that name (`interface.actions`) through the control API, so its
schema checks the input as any call's: `input`'s keys are constants, or a row's values (a string
`'$row.<path>'`, `'$row'` the row itself); the action's other input fields are the owner's, in a
small form the button opens under the row, drawn by the same form builder as every action's and
setting's (`SchemaForm`), each key of `current` preselected with the row's value at its path. With
no field left the button runs at once. `confirm` is asked first. While it runs the button is busy;
then its answer, or why not, is said under it, and the page's reads are asked again. An action's
input field may take its **options from a read** of the node, since a manifest cannot list what
changes while it runs (a cast edited in a collection):
`.meta({ options: { read, path?, value?, label? } })` on a `z.string()`, the items at `path` of the
read's output (all of it for none, a list or a map), each option's value at `value` (the item itself
for none) and its label at `label` (its value for none). Every form that knows its node draws it as
a choice of them, the value it has (gone since) kept; the action still checks what it gets. A
made-up `postcard` that paints a card per place:

```ts
interface: {
  state: {
    cards: { help: 'Its cards', output: z.array(z.object({ place: z.string(), prompt: z.string(), picture: z.string().optional(), host: z.string().optional() })) },
    hosts: { help: 'Who may host', output: z.object({ hosts: z.array(z.object({ id: z.string(), name: z.string() })) }) },
  },
  actions: {
    repaint: { help: 'Paints a card again', input: z.strictObject({ place: z.string(), what: z.enum(['ad', 'scene']) }) },
    rehost: {
      help: 'Gives a card another host',
      input: z.strictObject({
        place: z.string(),
        host: z.string().meta({ options: { read: 'hosts', path: 'hosts', value: 'id', label: 'name' } }),
      }),
    },
  },
},
page: {
  title: 'Cards',
  sections: [{
    show: 'table', read: 'cards',
    columns: ['place', 'prompt', { path: 'picture', label: 'Picture', show: 'image' }],
    actions: [
      { label: 'Re-roll', action: 'repaint', input: { place: '$row.place', what: 'ad' }, confirm: 'Re-roll this picture?' },
      { label: 'Rehost', action: 'rehost', input: { place: '$row.place' }, current: { host: '$row.host' } },
    ],
  }],
},
```

The manifest's check refuses a picture column's path its rows have not (as any column's), a
carousel's whose schema is no list (`page.sections.0.columns.2: ads is not a list of pictures`), a
row action whose action it does not declare
(`page.sections.0.actions.0.action: fly is not among its actions (interface.actions)`), an `input`
key its action's object schema does not take, a constant its schema refuses, a row path its rows
have not (`its rows have no town`), a `current` key that `input` gives already, and options that
name a read it does not declare
(`interface.actions.rehost.input.host.options: people is not among its reads (interface.state)`), or
a path its output has not or that is no list. A script node declares neither: it offers no reads
(§5), its code running in a worker thread that a synchronous read could not ask.

**Views** (bot-os.md D170, #87; `packages/core/src/widgets.ts`, `packages/turns/src/view.ts`). A
view is a node of its own, of kind `view`, whose page shows the nodes wired to it: its interface
inputs are its edges to them, each by plugin or by contract, and its sections are a page's, each
naming the input it reads (`from`), its read, its row actions and its pictures then the bound
node's. It is served at `/v/<path>/`, behind the UI's login (D40): its node's `path` in the graph,
else its id; the check refuses two views of one path, and a path on a node that is no view. A module
ships a view as a plugin whose manifest declares `view`, so that a game's page comes with the game;
the owner adds its node and draws its edges. The image's generic `view` plugin takes the same from
its config, for the owner's own pages.

```ts
manifest: {
  id: 'ledger-view',
  kinds: ['view'],
  description: "The ledger's page",
  inputs: {
    // By plugin, or by contract (`members`, no plugin); optional: a view starts with none wired.
    ledger: { type: 'interface', plugin: 'ledger', optional: true },
  },
  view: {
    title: 'Ledger',
    // One choice on the page, its options a list read of a bound node; `?s=` keeps it.
    selector: { from: 'ledger', read: 'players', value: 'name', label: 'name', title: 'Player' },
    sections: [
      {
        show: 'table', from: 'ledger', read: 'players', columns: ['name', 'gold'],
        actions: [{ label: 'Pay', action: 'pay', input: { name: '$row.name', gold: 5 } }],
      },
      // `'$selector'`, in a read's input or a row action's: the value chosen.
      { show: 'keyValue', from: 'ledger', read: 'player', input: { name: '$selector' } },
    ],
  },
},
```

The members its sections use (`state.<read>`, `actions.<action>`) are added to the input they name,
so that an edge binds it only to a node that offers them; a contract input names at least one member
itself. **Checked twice:** the manifest refuses a section whose `from` is no interface input of its
own, a `view` on a plugin of another kind, and a `page` beside it (a view is its own page); the
graph's check refuses each section and the selector that the node bound to its input does not answer
as the node's own page would be refused (a read it has not, an input it refuses, a path its output
has not, an action its rows cannot run), a `'$selector'` key left out of its schema's check. An
input left unbound is checked once bound, and its sections say on the page that they wait for an
edge. The page (`ViewPage.tsx`) asks each read of a bound node once
(`GET /plugins/<node>/state/<read>`), again every five seconds and after a row's action, names the
nodes it shows, each a link to it in the editor, and keeps the choice in its address.
`GET /graph/view` gives a view node's `view`, its `served` (`{ path, bound }`, the node bound to
each input) and every node's `shownIn` (the views that show it).

**Its layout** (D170, phase 2; every element with an example in [views.md](views.md), the cookbook):
a section is a **leaf**, which shows a value, or a **layout**, which holds sections. `show` names
the kind of section and nothing else; `format` says how a value is drawn.

- **Layouts:** `tabs` (`{ title, count?, sections }` each; the open one in the address, `?tab=`, its
  title's slug; one level of tabs, no two of one slug; only the open tab's reads are asked), `grid`
  (`columns`, 1 to 6, one on a phone) and `card` (`title`, a box of sections).
- **Leaves:** a page's six kinds; `stat`, one value large (`format`, `unit`, `of`, `tone`, `tones`;
  a list or a map, how many it holds); `gallery`, a list's items as cards
  (`image: { path, source?, carousel? }`, `caption`, `badges`, `actions`, `search`, `pageSize`);
  `form`, several fields sent at once: an action's input (`action`, `input`, `fields`, `current` a
  read that presets them, `submit`, `confirm`) or the node's live settings (`settings`, their keys).
  Every leaf says what it says when empty (`empty`, else `Nothing yet`), says it is loading while
  its read is asked, and, when its read fails, says so in its own card, naming its input and its
  read.
- **A table** may be searched (`search: true`, every column, or the paths named), sorted
  (`sort: true`, by its headers; `defaultSort: { path, direction }`) and paged (`pageSize`); it
  scrolls sideways in its card. **A column** (and a drawer's field, a gallery's badge) is a path or
  `{ path, label?, format?, unit?, tones?, source? }`, `format` one of `text`, `number`, `percent`,
  `datetime`, `relative`, `badge` (coloured by `tones`, `'*'` any other value: `neutral`, `info`,
  `success`, `warning`, `danger`), `tags`, `image`, `carousel`; phase 1's `{ show, from }` of a
  picture column is still read, as `{ format, source }`.
- **A drawer** (`detail: { title?, fields?, actions?, sections? }`, on a table or a gallery): a row
  opens it at the side of the page, the whole screen on a phone; its key (`key`, a path of the rows,
  `id` by default) is in the address, `?row=`, so that a link opens it. Its `sections` are leaves
  read with the row's values (`'$row.<path>'` in a read's input), opening no drawer. A tab (or the
  page outside the tabs) has one leaf with a drawer at most.
- **The checks** walk the whole tree: the manifest's refuses a `from` that is no interface input,
  tabs within tabs, two tabs of one slug, two drawers on one tab, a `format`'s option given to
  another (`tones` but on a badge, `unit` but on a number, `source` but on a picture); the graph's
  checks each leaf against its bound node (a stat's or a column's format against its value's type, a
  list format on no list, a key, a search or a sort path the rows have not, a drawer's
  `'$row.<path>'`, a form's action, fields, preset and settings). Each error names its path into the
  manifest: `view sections.1.tabs.0.sections.0.columns.2: triggers is not a list of texts`. An
  unknown `show` lists the kinds there are.
- **Actions** say they are busy, then their answer or why they were refused, and the leaves read
  from that node are read again (the rest at their next five seconds).

A node page (`page`, above) keeps working as it is, and its table takes a table's search, sort,
paging, formats and a drawer of fields and actions too; it is deprecated for views (D169), and a
later release will offer to move each into a view.

**Chat commands (P11).** A command of `interface.commands` has its `help` (the owner's words: the
owner's menu, the UI, the agents), its `args`, its `aliases` (other names it answers to, in no menu;
a name, or a word in any alphabet with a lower-case first letter, such as `perché`: Telegram marks
as a command only Latin letters, digits and `_`, so `telegram-bot` reads an alias written otherwise
from a plain text that starts with `/alias` or `/alias@ThisBot` and then a space or nothing, in a
group only when the bot hears every message there, its privacy mode off or as an admin; bot-os.md
D162) and, for the users' menus, a description in their language (`menu`; a command without one is
answered but not listed there). The instance offers a handler for each (`commands`:
`run(answer, request)`, and `allow(asker)` for a command answered only to some; a command declared
and not offered fails the plugin at `create`), and two commands or aliases of one name fail the
load. **No edge, no chat command** (bot-os.md D109): a plugin with commands has a `commands` input
(§2.1), and a chat answers a command only where a commands edge from its connector serves it.
`core.commands()` lists the running plugins' commands, in load order, every one of them, for the
admin side; `core.served(node)` those the commands edges from a connector's node serve, each with
where (`where`: the edge's `chats` and `privateChats`, `inScope`), its `allow` the edge's `senders`
then the plugin's own, and its answers held by the edge, then the core's own. The surface registers
each in the menus of the chats it is served in, and answers it there alone, with the chat asked in
(`Request.chat`) (`packages/core/src/commands.ts`). The answer is the surface's (D29), within the
edge: the handler says what to answer (`Answer`: a text, plain, Markdown (`'markdown'`) or Telegram
HTML (`'html'`, §4.6, bot-os.md D164), `text(text, format?, options?)`, with buttons that each run a
command again and an expiry in a group; a photo, as a `Media` (§4.18) or by the network's id of one
sent before, with a caption under it if given, plain, Markdown or HTML as a text is,
`photo(photo, caption?, format?)`, as `answer.photo(photo, caption, 'html')`: a caption over
`CAPTION_MAX`, Telegram's 1024 characters (an HTML caption's, those of the text it shows), and bytes
no JPEG, PNG, GIF or WebP or not the type they say (`photoRefusal`, bot-os.md D153), are refused,
thrown and logged `refused`, before anything is sent, bot-os.md D150), and the surface sends it in
reply to the asker (`Asker`: the network's id and username, and whether it is the owner), in the
chat asked; each answer is recorded as a send (`core.send`, its `origin` `command /<name>`, `sent`
or `failed`), and a dry-run edge logs it (`dry-run`) and sends nothing. What a plugin sends on its
own goes through its outbox, within its chat-out edges, each sending for real or as a dry run
(§4.6). The surface is a connector's (`ChatSurface`): the core serves every running connector that
offers one its commands (`serve(core.served(node))`), once every plugin has started, the core's own
cards ending with that surface's way home (`home`, §4.11). A surface is the owner's interactive
control (commands, cards and their buttons), not a report channel: it tells the owner nothing on its
own (bot-os.md D94).

**The owner's commands.** A command may be the owner's (`owner: true`): the core answers it to the
owner only (`Asker.owner`), and the surface only in the owner's chat, never in a group; it needs a
commands edge that names the owner's chat, as any plugin command does (D109), which cannot widen it.
The core's own controls (§4.11) need none: they are answered in the owner's chat, which the
connector's config names (`owner`, bot-os.md D56). A command may be `hidden`: in no menu, the
owner's included, for the actions of buttons that may also be typed by hand. A button's action is a
command: as typed (`/report 8`), or in short, `name:args` or a bare name (`opt:fast:on`, `kill`;
`tapOf` reads both), which keeps the owner's buttons within Telegram's 64 bytes. A tap runs the
command again and redraws the message tapped with its answer, unless the answer says `keep`. The
core adds its own commands after the plugins' (§4.11); a plugin's command of one of their names
fails the load.

### 2.1 Ports and the graph

Composition is a typed graph (bot-os.md P17, D27): each plugin instance is a node, with input ports
(what it consumes, drawn on the left) and output ports (what it produces, on the right), each of a
port type the core defines (`packages/core/src/ports.ts`); an edge binds an input to an output of
its type. The instance's wiring is that graph, kept as data (`packages/core/src/graph.ts`), and the
edges are the permissions (P6): a plugin reads a chat, sends through an outbox, uses an interface or
hears a namespace's events only through a port an edge binds.

| Port type   | Output                                                                                                                          | Input                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-in`   | `chat`: a connector's account, of its network (derived)                                                                         | `{ type: 'chat-in', network?, when?, sameAs? }` (declared); its edge carries the chats it `reads` and its `senders`                                                                   |
| `chat-out`  | `{ type: 'chat-out', network?, many?, owner?, single?, photos? }` (declared in `outputs`); its edge carries what it `sends`     | `chat`: a connector's account (derived), bound to any number of senders; their edges carry the chats sent to and `commands`                                                           |
| `events`    | `events` (`<ns>-events` with more than one): each namespace it registers (derived)                                              | `{ type: 'events', namespace }`, bound to any number of instances; it hears only theirs; `namespace` may be `{ config: key }`, or `{ edge: true }`: its one edge's (below, D156)      |
| `interface` | `interface`: its declared reads and actions (every plugin has one, derived)                                                     | `{ type: 'interface', plugin, members }`; none for a plugin it only needs started first; no `plugin`: a contract                                                                      |
| `commands`  | `{ type: 'commands' }` (declared in `outputs`, a connector's alone, of its account's network); its edges carry what each serves | `commands`: a plugin's chat commands (derived from `interface.commands`), bound to any number of connectors; each edge carries `serves`, `chats`, `privateChats`, `senders`, `dryRun` |
| `attention` | `{ type: 'attention' }` (declared in `outputs`): a simulated person's attention, bound to any number of players                 | `{ type: 'attention', bind? }` (declared): the person whose sittings it plays in, one edge; it carries nothing                                                                        |

**Chats flow left to right** (bot-os.md D60): only parsers read chats, actors only send, and
everything else consumes events and interfaces. A chat-in edge runs from a connector's chat-in
output, `chat`, to a reader's chat-in input, on its left: the chats it hears (`reads`). A chat-out
edge runs from a sender's chat-out output, on its right, to the connector's chat-out input, `chat`:
the chats it may send to (`sends`) and the commands it may send there (`commands`, by first word;
none: any text), with, for its queued sends, the least seconds between two sends of a command in one
chat (`minIntervalS`, `{ "/inventory": 300 }`, by first word; a command not named, the connector's
`commandIntervalS`: §4.6, bot-os.md D73). **A photo** has no first word: an edge that names its
`commands` lets none through unless it says `photos: true`, or its output declares `photos: true`
(bot-os.md D150; an edge that names no command lets photos through as any text). A chat-out output
may **declare the commands it sends** (`commands`, by first word) and their spacing
(`minIntervalS`), as a script node's do (bot-os.md D74): the check refuses an edge from it that
allows another command, or any text
(`node look: output port chat sends only /look: its edge allows /buy too`); a new edge drawn from it
starts with them; and its queued sends are spaced by its declared intervals, its edge's own winning
for a command it names. A connector has both, as one node (one account, one session); the editor
draws it as two cards (§4.12). **A service connector** (bot-os.md D148), whose account has no chat
(an API's, as `anthropic`'s), says so in its manifest (`chat: false`) and has neither: no chat-in
output, no chat-out input, its `interface` (and its `events`, if any) its only outputs, drawn as one
card. An edge to or from a `chat` it does not have is a problem of the check, which says why
(`node llm: no input port chat: llm is a service connector, with no chat to read or send through (D148)`);
a saved graph with one is refused as any (§2.3), and the instance runs. A connector's chat-out input
takes any number of senders; a sender's chat-out output, one edge, required unless `optional` (the
connector starts first, and an unbound required one fails the start:
`node actor: output port chat (chat-out of irc) is not bound`). A port's `network` (`irc`,
`telegram`) is matched against the connector's account, as it was for a chat. `ctx.connector(port)`
hears through a chat-in input, and `ctx.outbox(port)` sends through a chat-out output (each also by
the connector's id or its account).

**A node whose edge is its only chat setting** (bot-os.md D97) says so on its ports, so that the
chat is named once, on the edge the outbox already requires. A chat-out output declared
**`many: true`** takes several edges, one per connector, and its node sends through each with
`ctx.outboxes(port)`, one handle per connector (`owner-notice` tells on Telegram and IRC at once).
One declared **`owner: true`** sends, through an edge that names no chat, to its connector's owner's
chat (`owner()`, §4.5: a `telegram-bot`'s `owner`), which the outbox then lets it reach; the editor
writes that chat on a new edge drawn from it, and says so on an edge left without one. One declared
**`single: { pattern?, expected? }`** has its edge name exactly one chat, matching `pattern` when
given
(`node quest-player: output port chat sends to one chat, its bot's @username, or a group's id: its edge names none`);
and a chat-in input declared **`sameAs: '<output>'`** has its edge read that one chat and no other
(`node look: input port chat reads @QuestBot, the chat its output chat sends to, and no other: its edge reads every chat`;
the turn actor had one until it stopped reading its chat, bot-os.md D99). A handle's `chats()` gives
the chats its edges let it send to (the owner's for an edge that names none from an `owner` output):
where such a node sends.

**What a chat-in edge reads** (bot-os.md D62) has two independent parts: `reads`, a list of chats or
`"*"`, any chat its connector monitors (§4.5); and `senders`, a list of senders, each an id or a
username (bot-os.md D167): an id is digits (a chat's with a leading `-`), matched against the
message's `senderId`; anything else is a username (`@QuestBot`, compared without case and without
the `@`), matched against its `senderUsername`. People are named by id, since a person may change
their username and another take it; a bot keeps its username, so it may stay named by it. `me` is
the account's own messages; without `senders`, anyone. An edge written before has no `senders`, so
it reads from anyone as it did: nothing converts. The edge field is `senders`, not `from`, since an
edge's `from` is its output end. _Any chat from anyone_ is allowed, and the editor flags it as
broad. Sending stays explicit: a chat-out edge lists its chats.

**A commands edge** (bot-os.md D109) runs from a connector's `commands` output to a plugin's
`commands` input, derived from its manifest's `interface.commands` (a port declared under that name
is refused; a plugin with no commands has none; the input is optional: unbound, no chat asks it
anything). It carries: `serves`, the commands it serves, by name (none: every one; the check refuses
one its plugin does not declare); `chats`, the chats it answers in, named as the connector names
them (`Surface.id`, picked in the chat picker), and `privateChats`, every private chat with the
account too (an edge with neither answers nowhere: the check warns of it); `senders`, who may ask,
by `@username` (without case) or id, `owner` for the connector's owner (none: anyone), before the
plugin's own `allow`; and `dryRun`, which logs each answer as sent and sends nothing (a new edge
drawn in the editor starts one, P10). A connector serves commands by declaring the output
(`{ type: 'commands', help? }`, only a connector may) and offering a chat surface (§4.5). One edge
per connector and plugin; a plugin served by two bots has two. These fields belong to it alone
(`only a commands edge carries serves, chats and privateChats`), as `senders` belongs to it and to a
chat-in. Its `serves` is not a chat-out's `commands`, the first words a plugin may send.

**An attention edge** (bot-os.md D133) runs from a node that holds a simulated person's attention
(the `attention` plugin, §5), its `attention` output, to each node that plays when that person sits
down (a `player`), their `attention` input: any number of edges leave the output (players attached
to one person share their sittings), one reaches an input (required unless `optional`, so the person
starts first and a person stopped makes its players inactive, D64). It carries nothing. At runtime
the core hands the player what the person's node offers it: the person's instance returns
`attention: (node) => …`, called with the asking node's id, and the player asks for it with
`ctx.attention(port?)` (`attention` by default), refused for an input it does not have, unbound, or
whose other end is not running; what passes between them is the two plugins' agreement, as an
interface's members are (the turns package's `AttentionHandle`).

A chat-in or an events input may say `when: { config: key }`, a key of its plugin's `config` schema:
the node has the port only while its config sets that key, to anything but `false` (the reactor
reads a chat only with a `match`, and hears events only with an `on`; an `attention` listens only
with `followsMyPlay` on, bot-os.md D138), resolved as an events input's namespace is (below). Once
there, the port is required unless it says `optional`: so the check refuses, naming the node, a
reactor on events whose events input no edge binds, which would never fire.

A chat is its two ports: module API 1's `{ type: 'chat' }` input and the `reach` shorthand, which
were read as both, are gone (bot-os.md D110), and a manifest that has either is refused. A plugin
that reads and sends through one account declares a chat-in input and a chat-out output under one
name: its `ctx.connector('channel')` and `ctx.outbox('channel')` name the two.

An interface input that names no plugin is a **contract**: any node whose interface declares its
members binds it (`interface with state.ready, actions.sent`), so each instance of one plugin may
use another plugin's interface (each player its own bot's readiness state, §5). It has no default
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
node (with the `config` key it came from), and the editor draws it as `POST /graph/check` resolves
it for the draft (its `inputs`, defaults included), reading the draft's config as written only for a
node the check has not seen yet (`GET /available` gives the key, `config`, and no `namespace`). A
node whose config leaves a required one unresolved is refused, naming the node
(`node r: input port events: its namespace comes from config on, which is not set`), and so is one
whose value names no namespace; an optional one whose key is not set is not there: the node has no
such port, and an edge to it is refused. `resolveInputs` (`packages/core/src/ports.ts`) resolves
them; `ResolvedNode.ports` holds a node's.

**An events input whose namespace is its edge's** (bot-os.md D156): a plugin that hears a node's own
events, in that node's id's namespace (a `collection`'s `<node>.changed`, §5; a script node's, D74),
cannot name it in its manifest, and should not ask the owner to type the node's id in its config. It
declares `{ type: 'events', namespace: { edge: true } }`, usually `optional`:

```ts
inputs: {
  cast: { type: 'interface', plugin: 'collection', members: ['state.list'] },
  'cast-events': {
    type: 'events',
    namespace: { edge: true },
    optional: true,
    help: 'The cast’s changes, to remake the cards at once',
  },
},
```

The port is always there, with nothing to configure, so the editor draws an edge to it from any
events output at once (`edge: true` in its view, no `namespace` until bound). It takes **one** edge
(a second is refused:
`input port cast-events takes one edge: its namespace is the node its edge comes from`), from an
events output of any namespace; the graph's check gives it that output's namespace
(`hosts.events → postcard.cast-events`: `hosts`), as `ResolvedNode.ports` holds it, and the bus,
`ctx.events.read` and the check then treat it as any events input of that namespace. Unbound, it
hears nothing, and a required one is refused as any unbound input is
(`input port cast-events (events of the node its edge comes from) is not bound`). Its code
subscribes relative to the port, and learns the namespace if it needs it (the node's id, for a
collection), from the bus or from each event's `type`:

```ts
const ns = ctx.bus.namespace('cast-events'); // 'hosts', or undefined with no edge
ctx.bus.subscribeTo('cast-events', 'changed', (e) => remake(e.type)); // e.type: 'hosts.changed'
```

The programmatic wiring (`defaultGraph`, the dev kit's default) binds it only where its manifest's
`bind: { nodes: [id] }` says, to that node's events output; a test binds it with the edge itself, in
the kit's `graph` (`edges: [{ from: 'hosts.events', to: 'postcard.cast-events' }]`).

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
fields stay as shorthand, read as ports: each plugin `requires` or `uses` names, a required
interface input named after it; `games.consumes` an optional events input, `<namespace>-events`. A
plugin's code names its ports: `ctx.connector('channel')`, `ctx.outbox('channel')`,
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
(§2.2; the node's id when it names none), its configuration, and, for a connector, its `account`:
`<network>:<node id>` when it names none (bot-os.md D119; node ids are unique, so accounts are), or
the one it names, of its plugin's network (a graph saved before D119 keeps its own; the editor
writes none). The programmatic wiring's default graph names the manifest's on each connector's node.
It may also give the `settings` (checked against its plugin's `settings`) its instance starts with:
they are put in force only while the instance keeps none of its own, so the owner's later changes
win. A node may be `"disabled": true` (absent: enabled), and a chat-out edge `"dryRun": true`
(absent: live): see **Node states** below. A node may name the `group` it is drawn in, a swimlane of
the editor (bot-os.md D69, §4.12): any name, not empty and without spaces at its ends
(`"group": "Quest"`; absent: none); the check accepts it, and nothing that runs reads it. A view
node may name its `path` (bot-os.md D170): it is served at `/v/<path>/`, its id when absent; only a
view has one, and no two views one. An edge goes from `node.port` (or `node`, when one of its
outputs fits) to `node.port`, with its type and, for a chat, what it carries: a chat-in its `reads`
and `senders`, a chat-out its `sends` and `commands` (each carries only its own). The core checks it
with zod and against the manifests at load, and fails the start naming the node and the port: a
plugin not in the image, a node twice, an instance named by two nodes or kept by another plugin
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
- **Stopped**, by exception: a safety stop (`ctx.stop`), drift (§4.7), the send-queue watchdog
  (§4.6, bot-os.md D93), the owner's kill in the editor or stop from Telegram's `/plugins` (§4.11).
  Kept in its instance (§2.2) as `_stop.json`,
  `{ "reason": "killed by the owner", "time": "2026-11-12T10:00:00.000Z", "source": "owner" }`
  (`source`: `safety`, `drift`, `stalled` or `owner`), so it survives restarts: the node is not
  started while it is there. The owner clears it in the editor, a change of the draft that Apply
  makes (`POST /plugins/<id>/clear-stop`, then the restart). A stop made while the node runs takes
  effect at once: its outbox refuses its sends (`stopped: <reason>`) and its `pause` hook is called;
  and every node it makes inactive (below) is shut down at once (bot-os.md D65).
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
starts a dry run, one the editor wires itself (a new node's required port that one port of the draft
alone serves, bot-os.md D135) included.

**Where the graph comes from.** `CoreOptions.graph` is the instance's graph; without it, the core
makes the default one from the plugins registered, in their order: a node per plugin, its id the
plugin's, each input bound as its `bind` says (`defaultGraph`), which tests and simulators use.
`CoreOptions.graph` may also be a function of the default graph:
`withInstances(graph, plugin, instances)` replaces the default node of a plugin meant for several
instances by its instances. `core.graph()` gives the graph the instance runs, every edge written
out. A changed graph takes effect at the next start (P8). The instance's entry point (`src/main.ts`)
registers the connectors, `attention` and the player, the reactor, the script node, `owner-notice`
and the modules' plugins (§7), and runs the graph saved in its volume (`CoreOptions.graphFile`,
§2.3).

### 2.2 Instances

A plugin's kept state belongs to an **instance**, apart from the node that runs on it (bot-os.md
D50): its store and the core's documents beside it (its timers, its settings, its stop, what it
serialised), in `/data/instances/<instance>/`. A node names its instance: an existing one of the
same plugin, whose state it takes up, or a fresh id, made at its first start. So a node can be
removed and added again, renamed, or replaced by another node of its plugin, without losing what it
kept; and one plugin can run as several nodes (the player, one per bot), each on its own instance.

As built (`packages/core/src/instance-registry.ts`): each instance keeps a record of itself,
`_instance.json`: its `plugin`, when it was `created` and when a node last `referenced` it (each a
time in ms). The load refuses a node on an instance of another plugin, and two nodes on one
instance. An instance that no node references, of the running graph or of the saved one (§2.3), for
7 days (`ORPHAN_MS`) is deleted, with its state: the core looks at start and then daily
(`core.sweepInstances`), touching the instances referenced, prints each one deleted and records it
(`core.instance`, `event: "deleted"`, with the `instance`; the same type's `started` and `stopped`
are the whole instance's, §3). While the saved graph does not read, nothing is deleted. A directory
without its record (put there by hand) is listed and left alone. `core.instances()`, and
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
    { "id": "quest-ready", "plugin": "quest-ready", "group": "Quest" },
    { "id": "alice", "plugin": "attention", "config": { "timeZone": "Europe/Rome" } },
    {
      "id": "quest-player",
      "plugin": "player",
      "instance": "quest-player",
      "config": { "commands": [{ "command": "/play" }, { "command": "/daily" }] },
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
    {
      "from": "quest-player.chat",
      "to": "tg.chat",
      "type": "chat-out",
      "sends": ["@QuestBot"],
      "commands": ["/play", "/daily"],
      "dryRun": true
    },
    { "from": "quest.events", "to": "quest-ready.events", "type": "events" },
    { "from": "quest.interface", "to": "quest-ready.parser", "type": "interface" },
    { "from": "quest-ready.interface", "to": "quest-player.state", "type": "interface" },
    { "from": "alice.attention", "to": "quest-player.attention", "type": "attention" },
    {
      "from": "bot.commands",
      "to": "quest-stats.commands",
      "type": "commands",
      "serves": ["map"],
      "chats": ["-1001000000001"],
      "senders": ["owner", "@alice"],
      "dryRun": true
    }
  ]
}
```

(The `bot` and `quest-stats` nodes, a `telegram-bot` and a plugin of a `/map` command, are left out
of `nodes` here.)

Here `quest-player` plays in `alice`'s sittings as a dry run, logged and not sent, until the owner
switches its edge to send for real, each command when `quest-ready`, the readiness state on the
parser's events, says it is ready (bot-os.md D141); a node `"disabled": true` would not start at all
(§2.1, Node states). The Quest nodes are drawn in the editor's Quest lane (`group`, bot-os.md D69);
the connector, whatever its group, outside every lane. A `group` is an addition to version 2, which
a release before it refuses (its nodes are strict): roll the image back past it only with the groups
taken out.

**Another version** of the file (version 1, with one `chat` edge for both the reads and the sends,
bot-os.md D60) is refused as any graph the check refuses (below), with why
(`graph: version: a graph of version 1, which this release does not read (it reads version 2)`):
nothing converts it any more (bot-os.md D110). Nor does anything convert what earlier releases
migrated as they loaded (a node's `mode`, D64; a chat a config held, D97; an edge to an input a
plugin dropped, D99): such a graph is refused for what it holds. Release 0.1.26 converts each of
them; an instance that never ran it starts it first.

**At start** (`packages/core/src/graph-file.ts`, `GraphFile`), the core reads it and checks it as
any graph (§2.1), against the plugins `core.available()` lists, their configuration and settings
schemas, their secrets and the instances kept. No file: an empty graph. A file that does not read
(not JSON), or that the check refuses, never stops the instance, which would only start again and
fail again: it starts with no nodes, the file is kept as it is, and why is printed, recorded
(`core.graph`, `event: "refused"`), raised as a `graph-refused` notice (§4.16, no node running to
tell it: the editor's events panel shows it), and reported by `GET /status` (`graph.refused`) and
`GET /graph/file` (`problems`), for the owner to fix.

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

`source` is `save`, `rollback` (which names the version it `restores`) or `found` (a file that no
version holds, written by hand or there before the history: kept at the next start, or before the
next write replaces it); `migrated`, which releases up to 0.1.26 wrote (the files the history
replaced, the first starts' migrations), is still read, and nothing writes it now. `summary` is what
changed from the version before (`diffSummary`): `+` added, `−` removed, `~` changed with the fields
that changed, nodes then edges, at most 8 named and the rest counted (`… 3 more`). `start` is how
the instance last started on it, set at each start once the graph is loaded (`GraphFile.started`):
`ran`, or `refused` with its `problems`; none if it never started on it. A write that leaves the
graph the same (its keys reordered) is no new version. Versions are kept 7 days, and never fewer
than the 5 latest; the others are pruned at each new one. A version kept by an older release, in a
format this one refuses, is listed and shown as any other (its `summary` was written when it was
kept), with the check's `problems`, and is never rolled back to. A `graph.previous.json` an older
release left is ignored.

**Audited config** (bot-os.md D75): a save or a rollback that changes a config key its node's
manifest audits (`audit`: a script node's `code`) records it in the event log, one record a key:

```json
{
  "type": "core.config",
  "t": 1794477600000,
  "event": "saved",
  "node": "examine",
  "plugin": "script",
  "key": "code",
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "by": "the web UI (session 1a2b3c4d)",
  "source": "save",
  "version": "2026-11-12T10-00-00.000Z"
}
```

`event` is `saved`, or `removed` (the node, or the key, gone; no hash); `by` is the web UI's
session, by the first 8 hex digits of its token's SHA-256, or `the control API (loopback)`; the
value itself is the history's (above). The web UI's server says who asks in a header of its own
(`x-megabottron-by`, `ACTOR_HEADER`), dropping the one a browser sends.

**A problem** (`GraphProblem`) is its words as the load says them (`text`) and, where it can be
told, the `node`, the `edge` (`{ from, to }`), the `port`, and the `config` or `setting` key it is
about, so that the editor marks it there. An edge between ports of two types is refused with why
(`node actor: input port score: chat-in of chat cannot bind interface of scorer (edge chat.chat → actor.score)`).

**A warning** (bot-os.md D89) has a problem's shape, and refuses nothing: a graph with warnings and
no problem checks `ok`, saves, applies and runs. The check gives them with its result, refused or
not (`GraphCheck.warnings`), and the load prints them (`core: the graph warns:`). One check warns
for now: **a chat-in edge that reads a chat its connector does not monitor**, which its node would
never hear, by the connector's manifest's `monitors` (§2) read from its node's config, without case
(`node quest: input port chat reads @DiceBot, which tg does not monitor (its chats: -1001000000001, @QuestBot) (edge tg.chat → quest.chat)`),
one warning per chat; an edge reading `'*'`, a connector monitoring every chat, or one whose
manifest does not say, warns of nothing. The built-in connectors declare theirs: `telegram-user` and
`telegram-bot` their `chats` (unset: every chat), with `aliases`, `irc` its `channel`. **A chat by
any of its names** (bot-os.md D90): where the manifest says a chat may go by several (`aliases`),
the check asks the node's running connector (`chatNames`, §4.5) every name of each chat read and
each chat monitored, and a chat read is heard if one of its names is one of a monitored chat's (a
private chat listed by its id, read as `@QuestBot`: heard). It warns of one it can tell is not: the
connector knows the chat read, or every chat monitored, and no name matches. What it cannot tell
(the connector not running, as at the load before it connects, or neither side known to it) it does
not warn of: unknown, not wrong. For a connector whose chats have one name each (`irc`), the names
as written decide. Other checks may add warnings in the same list.

**An edge to a port gone from its node** (bot-os.md D154) is dropped, with a warning: both its nodes
exist, and the node's manifest (its own, for a node whose config declares its ports) declares no
port of that name at all, neither input nor output, as when a module upgrade removed it. The check
leaves the edge out of the graph it holds and warns
(`edge telegram-user.interface → postcard.account dropped: postcard has no input port account`, or
`… dropped: <node> has no output port <port>`), located on that node, its port and the edge; the
load prints it and raises it as a `warning` notice (§4.16), and the rest runs. The load does not
write the file: the edge stays in `graph.json`, warned of at each start, until the next save (the
editor's, or `PUT /graph/file`), which writes the graph as the core holds it, without the edge, the
version before it kept in the history. Still problems: an edge to a node not in the graph, a node
whose plugin is missing, an edge on a service connector's `chat` (§2.1), a port declared the other
way round, an input declared but left out by its node's config (an events namespace from a config
key not set, a gated input off), and what the drop leaves unbound (a required input it fed).

**The control API's graph routes** (§4.11), the owner's alone:

- `GET /graph/file`: the saved file (`graph`, as written) and its `text` (`graphText`, §4.12),
  whether there is one (`exists`), why it does not read (`error`) or is refused (`problems`), its
  `warnings` if it has any, and whether it differs from the graph running (`differs`: a restart
  would change what runs).
- `POST /graph/check`, a graph as the body: checked as the load would, nothing saved: `ok`, its
  `problems`, its `warnings` (none: `[]`), its `text`, and its `diff` from the saved file: the nodes
  `added`, `removed` and `changed` (with the fields that changed), and the edges `added`, `removed`
  and `changed` (with the fields that changed), by their two ends; and `views`, each node whose
  ports its config declares (§2, bot-os.md D74) as the editor draws it (`describePlugin` of its own
  manifest), whether or not the graph checks; and `inputs`, each node's input ports by node, as the
  check resolves them from its config (§2.1: its schema's defaults included, a node's own manifest
  for such a node), which the editor draws rather than resolving them again (#6).
- `PUT /graph/file`, a graph as the body: checked, then saved as the core holds it (each edge's ends
  and type written out), and kept as a version of the history; `saved` (false when nothing changed),
  `restart` (whether it differs from what runs) and its `warnings` (saved all the same). A graph
  refused is not saved: 400, with its `problems`.
- `GET /graph/history`: the history, without the graphs: `versions`, newest first, each its `id`,
  `time`, `source`, `summary`, and `restores` and `start` if any; `current`, the id of the version
  that is the saved file, if one is; `lastGood`, the newest whose last start `ran`; and `keep`
  (`{ "days": 7, "latest": 5 }`).
- `GET /graph/history/<id>`: one version: its metadata, its `graph` (as written), whether it is the
  `current` one, the `diff` from the saved graph to it (as `POST /graph/check` gives it: what a
  rollback to it would change), its `text` and the saved graph's (`currentText`), their line diff
  (`lines`, `[{ "op": " " | "-" | "+", "text" }]`, §4.12), and its `problems` if the check refuses
  it now. 404 for a version not kept.
- `POST /graph/history/<id>/rollback`: that version written as the saved graph (as the check holds
  it), kept as a new version that `restores` it, so a rollback can be undone; the file it replaces
  is kept first if no version holds it. `{ "rolledBack": true, "version", "restores", "restart" }`.
  404 for a version not kept; 409 when it is the saved graph already, or when the check refuses it
  now (an older release's format, a plugin gone: `version <id> is refused by the check`, with its
  `problems`; nothing is written, bot-os.md D110). Nothing restarts: the UI then asks
  `POST /restart`.
- `POST /graph/rollback`: the same, to the version before the current one (the second newest, or the
  newest if the file was written by hand since), as the route of earlier releases did; a second goes
  forward again. 409 when there is none.
- `POST /restart`: applies it. The answer goes, then the instance ends as at `SIGTERM` (§3): the
  core stops, each plugin's state kept, and the process exits 0, so that Docker's
  `restart: unless-stopped` starts it again on the saved graph.

No agent grant ever includes these (P11): they are the control API's, which no agent is given.

## 3. The lifecycle

```text
loading ─ its plugin's package or module loads ─▶ registered
loading ─ it does not load ─▶ unloaded (with why), and the nodes requiring it inactive
registered ─ manifests, graph and config valid ─▶ starting ─ create(), start() ─▶ running
   running ─ every plugin started: ready() ─▶ running
   running ─ a safety stop, drift, the owner's kill or stop ─▶ stopped (kept in its instance)
   running, stopped ─ serialise(), stop() ─▶ stopping ─▶ stopped
   create(), start(), ready() or a migration fails, or does not settle within 60 s, or
   ctx.fail() ─▶ failed (with why), and so do the plugins requiring it
   at load: disabled in the graph, stopped in its instance, or inactive ─▶ never started
```

`packages/core/src/core.ts` runs it (`Core`: `register`, `load`, `start`, `stop`, `stopNode`,
`clearStop`, `status`); every change of state is logged as `core.plugin`, with the plugin, the state
and the reason, but those a start or a stop of the whole instance makes as expected (bot-os.md
D114). At a start (every start: after a restart, a `SIGTERM` or a crash alike) a node's `starting`
and `running`, and its being `disabled` or `inactive` at the load, are folded into one record once
every node has heard `ready`: `core.instance`, `event: "started"`, with the release (`version`,
`commit`), how long the start took (`ms`), and the nodes by state (`running`, and when there are
any, `disabled`, `inactive` as `{ id, reason }`, `stopped`, `failed`). At a stop of the instance
(`core.stop(why)`: `POST /restart`, `SIGTERM`, `SIGINT`, the only ways it stops; a crash logs
nothing) each node's `stopping` and `stopped` are folded into `core.instance`, `event: "stopped"`,
with `why` (`restart`, `SIGTERM`, `SIGINT`), `ms`, and the nodes `stopped`, in the order they
stopped. What goes wrong in them is still logged node by node: a node `failed` (at its start or its
`ready`), one `stopped` by a stop kept in its instance, and one whose `stop` failed or took too long
(`stopped`, its `reason` `stop failed: …`). A node's change at runtime (a stop, a cascade, a
failure, a cleared stop) is logged as it happens.

- **The start in the background** (bot-os.md D143, `packages/core/src/boot.ts`): the entry point
  serves first (the control API, the health endpoint and the web UI), then `bootstrap` imports each
  of the image's plugin packages on its own, side by side, then the modules (§7.3), then loads the
  graph and starts its nodes. Until the load, the saved graph's nodes are `loading` in
  `GET /status`, with `boot.phase: "loading"` (then `starting`, then `started`), and a graph is not
  checked (`POST /graph/check` says the plugins are still loading). A package whose import throws (a
  SyntaxError of Node's type stripping, a top-level error), does not settle within 30 s, or whose
  factory throws is a failure of that package alone, as a module's is of that module; each is told
  to the core (`core.failedToLoad`): printed, logged (`core.load`, `event: "failed"`, `source`,
  `error`) and raised as a `load-failed` notice (§4.16), and listed in `GET /status`'s
  `boot.failures` (`{ source, module?, error }`, `source` `package <specifier>` or `module <id>`).
  The nodes of a plugin not offered then are held out of the graph the core runs (`unloaded`, its
  `reason` naming the failure that took it, and `failures`), and so is each node a required port of
  which it binds (`inactive`, `needs dice (unloaded)`); the rest runs. Which failure took a plugin
  is read from where each plugin came from at the last start that loaded it (the core's
  `plugin-sources` document); a plugin never loaded names every failure. With nothing failed to
  load, a plugin not offered refuses the graph, as below.
- **Errors of the deployment** fail the whole graph at load, before any plugin runs, naming the
  plugin and what is wrong: a bad manifest, two plugins with one id, a bad graph, a cycle, a bad
  configuration value, a secret declared but not provided, an archived plugin in the graph (unless
  `CoreOptions.allowArchived`). The saved graph refused, no node runs and the owner is told (§2.3);
  the process serves on.
- **Errors at runtime** fail one plugin: `create` or `start` throws or does not settle within 60 s
  (`CoreOptions.startTimeoutMs`; what a late `create` makes is stopped), a migration fails, or the
  plugin fails its node itself (`ctx.fail(reason)`, for what it cannot run on: a script that hung or
  ran out of memory, bot-os.md D28; its events, messages and timers cut at once, its sends refused,
  then its `stop` called). That plugin is `failed`, with why; the plugins that require it (a
  required edge, §2.1) are `failed` too; every other plugin starts. A `failed` notice is raised
  (§4.16), for `owner-notice` to tell, and the failure is logged (`core.plugin`).
- **Start** runs in load order (requirements first), each plugin's `start` awaited before the next
  begins, for up to 60 s; a connector connects in the background, retrying, and its `start` does not
  wait for it (§4.5). An error nothing caught (an unhandled rejection, an uncaught exception) stops
  nothing: it is printed, logged (`core.uncaught`) and raised as an `uncaught` notice, naming the
  module or package its stack names (`guard`). **Stop** runs in the reverse order, at `SIGTERM` or
  the owner's restart (§2.3), each plugin's `stop` awaited for up to 5 seconds (a stop that fails or
  takes longer is logged, and the next plugin stops). The process exits 0 once the core has stopped,
  or after 30 seconds however far it got (`packages/core/src/shutdown.ts`).
- **Ready:** once every plugin has started, each running one hears `ready`, in load order, before
  the core's `start` resolves. It is for the work that needs the plugins that use this one in place
  (a parser replaying recent history to the plugins that listen to it). A `ready` that throws fails
  its plugin, which is stopped, and those that require it; so does one that does not settle within
  60 s.
- **Stopped** by exception is the core's (§2.1, Node states): a plugin stopped by its own safety
  stop, by drift (§4.7) or by the owner. Its sends are refused by the outbox from then on; its
  `pause` hook is called so that it can stop planning, and its stop is kept in its instance, so the
  next start does not start it. Only the owner clears it, in the editor, applied with a restart. The
  nodes the stop makes inactive are shut down at once (§2.1, Node states; bot-os.md D65).
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
  /** The owner changed settings; the new values are already in ctx.settings. */
  settingsChanged?(keys: string[]): void;
  off?(): void; // the owner turned the instance off (§4.11)
  on?(): string | undefined; // back on: what came of it
  kill?(): string | { text: string; buttons?: Buttons } | undefined; // its safety stop
  onTimer?(name: string, payload: unknown): void; // §4.3
  cost?(): OwnCost; // what it costs of its own: a script's worker (§4.11)
  settings?: { apply(key, value): void; read(key): SettingValue }; // its own in force (§2)
  interface?: {
    state?: Record<string, (input?) => unknown>; // a read's input, if it declares one (§2)
    actions?: Record<string, Function>;
  };
  attention?: (node: string) => unknown; // what its attention output offers each player (§2.1)
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
  outboxes(port: string): Outbox[]; // §4.6, one per connector an output of several edges binds (D97)
  use<T>(port: string): T; // the interface an input's edge binds (§2.1)
  useOptional<T>(port: string): T | undefined; // an optional input's, while bound and running
  attention<T>(port?: string): T; // what the person its attention input binds offers it (§2.1)
  drift: DriftReporter; // §4.7, parsers only
  notify(text: string, buttons?: Buttons): void; // a `told` notice for the owner (§4.8, §4.16)
  notice(kind: string, text: string, detail?: object): void; // for the owner's attention (§4.16)
  notices?: { subscribe(handler: (n: Notice) => void): () => void }; // with `notices: true` (§4.16)
  summary?: { contribute(lines); collect(window); instance() }; // with `summary: true` (§4.17)
  stop(reason: string): void; // its safety stop: its node stopped, kept (§2.1, Node states)
  fail(reason: string): void; // its node failed at runtime, not kept (§3)
  off(): boolean; // the instance is off (§4.11)
  restored?: unknown; // what serialise returned at the last stop (§3)
  render: Render; // §4.13: SVG to PNG
}
```

A plugin's safety stop is `ctx.stop(reason)`; how it sends, its outbox handle's `mode()` (§4.6).

A connector's context also has `secrets.get(name)`, for the secrets it declared or its config names
(§4.9), `secrets.has(name)`, whether one it declared is provided, `secrets.remember(value)`, a value
it holds marked secret (bot-os.md D116), `secrets.store`, its store's documents sealed at rest for
the credentials it keeps (§4.9, bot-os.md D123), `account`, its node's account (§4.5), on which it
makes its connector, and `readers()`, what each chat-in edge leaving its node reads
(`{ reads, senders? }`, §2.1), as the graph says, of the nodes that read now: about to start,
starting or running, not disabled, stopped, inactive or failed (bot-os.md D66). Asked again, it says
what holds then: the chats a catch-up fetches (§4.5).

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
- `files`: bytes by name, beside the documents (bot-os.md D149), below.
- `version`: the schema version kept with the documents (`_meta.json`). At start the core runs the
  manifest's migrations from the kept version up to the manifest's, each one awaited; a failed one
  leaves the store as it was, and fails that plugin only (§3).

A plugin reaches nothing outside its own directory. Data of another plugin comes through that
plugin's interface (`use`), never its files.

As built (`packages/core/src/store.ts`): documents are `<name>.json`, written with mode 600 in a
directory of mode 700; the core keeps its own beside them (`_meta.json`, the version;
`_restore.json`, what `serialise` returned, handed back once; `_timers.json`; `_settings.json`;
`_instance.json`, the instance's record, §2.2). Migrations run on a staged copy
(`<instance>.migrating/`) that replaces the directory only when every step has succeeded, so a
failed one leaves the store as it was, and a store newer than its plugin (an image rolled back)
fails that plugin rather than being read wrong. A crash between the two renames of the commit is
undone at the next start.

**Files** (bot-os.md D149, #66). A plugin that makes or receives files it must keep (pictures an
image service painted, to send again as photos; a document a bot sent) keeps them in its store, as
its documents, never as base64 in a document nor on a share mounted into the container:

```ts
interface StoreFiles {
  write(name: string, bytes: Uint8Array, options?: { type?: string }): void;
  read(name: string): Uint8Array | undefined;
  list(): { name: string; size: number; type: string; written: number }[]; // by name
  delete(name: string): void;
}
```

- **Names** are a document's (letters, digits, `-`, `_` and `.`, no path, none starting with `_`),
  of at most 200 characters; a bad one throws. `type` is a media type (`image/png`), lower-cased;
  none given, it is guessed from the name's extension (`png`, `jpg`/`jpeg`, `gif`, `webp`, `svg`,
  `pdf`, `txt`, `json`), else `application/octet-stream`. `written` is the core's clock, in
  milliseconds. What `read` returns is the plugin's to change: it is not the stored file.
- **On disk:** `<instance>/files/<name>`, mode 600 in a directory of mode 700, written atomically (a
  temporary file, flushed, then renamed), as a document is; its type and time are kept beside it
  (`files/.meta/<name>.json`), written just after its bytes, so a crash between the two leaves the
  new bytes with the previous file's type. A file put back by hand, with nothing kept of it, has its
  type from its name and its time from the disk. They are in the data volume, backed up and restored
  with the rest of the instance (Backups, below); `Stores.delete` deletes them with the store.
- **Limits:** a file may take 16 MB, and all of an instance's files 256 MB (`DEFAULT_FILE_LIMITS`);
  a write past either throws a `FileLimitError` that says why
  (`file card-42.png is 20.0 MB, over the 16.0 MB a file may be`;
  `file card-43.png (2.0 MB) would take the files to 257.0 MB, over the 256.0 MB an instance may keep`),
  a file replaced counted once. The deployment sets its own: `CoreOptions.fileLimits`
  (`{ file?, total? }`, in bytes), which the image's entry point sets from `FILE_MAX_MB` and
  `FILES_MAX_MB` in its environment (in MB; unset, the defaults).
- **Migrations** see the files (`MigrationStore` is a `Store`). The staged copy hard-links them
  rather than copying them (a copy where the file system refuses a link), as they may be large: a
  write replaces a file by a rename and a delete unlinks it, never a change in place, so the store's
  own files are as they were until the commit, and a failed migration leaves them, as the documents,
  untouched.
- **Read by the owner,** never deleted: `GET /plugins/<id>/files` and
  `GET /plugins/<id>/files/<name>` (§4.11), and the node's panel in the web UI. Deleting one is the
  plugin's (or an action it declares).
- A connector's sealed view (`ctx.secrets.store`, §4.9) has the store's files, unsealed.
- A file read back is a `Media` (`mediaOfFile(ctx.store.files, name)`, §4.18: its bytes and the type
  kept with it), which an answer's photo (`Answer.photo`, §2), an outbox's (§4.6) and `ask`'s images
  (§4.13) take as is. A `card-painter` plugin, for example, asks an image service for a card's
  picture, writes `card-42.png` with the picture's provenance in a document beside it, and answers
  `/card 42` with the photo read back, without asking the service again.

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
  (`player.step`); `core.*` is the core's.
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
- `bus.namespace(port)` is the namespace its events input `port` hears (bot-os.md D156): the
  manifest's, its config's, or, for one declared `{ edge: true }`, its edge's; undefined while no
  edge binds that one. `bus.subscribeTo(port, pattern, handler)` subscribes relative to it:
  `'changed'` is `<namespace>.changed`, `'*'` the whole namespace; each event still has its full
  `type`. An unbound input from its edge hears nothing, and its stop does nothing. Both throw for a
  port that is not one of its events inputs.
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
  have delivered them; so two instances of one plugin (a player per bot) never read each other's.
  `all: true` reads every instance's. A record with no `instance` (the core's own, or one written
  before records carried one) belongs to no instance, and every reader of its namespace reads it.

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

**History, not news** (bot-os.md D83): an event read from a message played back (`Inbound.playback`:
missed while the instance was down and delivered by a connector's catch-up more than its grace,
`liveGraceS`, 2 minutes by default, after it was said; or a bouncer's buffer) carries
`playback: true` in its payload, as a turn parser's `<id>.turn` does. It is applied like any (a
state keeps it), but nothing acts on it: a reaction skips it, a state plugin tells nothing of it in
its own events, and a script node should check it before it sends.

Two plugins registering one type is an error of the deployment; two instances of one plugin share
its types, and each subscriber hears only the instances its edges bind. A subscriber that throws is
logged and the others still get the event.

### 4.5 Accounts and connectors

An **account** is one identity on one network, with an id of the form `<network>:<name>`:
`irc:alice`, `telegram:alice` (a user), `telegram-bot:ExampleBot`. Each connector is bound to one
account, and holds its credentials; the plugins get a handle. A connector node's account is its own
id on its plugin's network (`telegram-bot:quest-bot` for the node `quest-bot`, bot-os.md D119;
`nodeAccount`), unless its graph node names another: nothing for the owner to type, unique as node
ids are. It is what the outbox, the event log and the errors name it by; whom it is logged in as is
the login's `as`, not the account.

```ts
interface Inbound {
  account: string; // which account saw it
  network: string; // 'irc', 'telegram', …
  chat: string; // '#lobby', a Telegram chat id or @username
  aliases?: readonly string[]; // the chat's other names (its @username, its id), bot-os.md D90
  private?: boolean; // a private chat (one user or bot), not a group, where the network says
  senderId?: string; // the sender's stable id: Telegram's, decimal (a chat's -100…); none on IRC (bot-os.md D167)
  senderUsername?: string; // the sender's username without @, an IRC nick; none without one (bot-os.md D167)
  senderName?: string; // the sender's display name, where the network has one (bot-os.md D159)
  senderBot?: boolean; // whether the sender is a bot, where the network says (bot-os.md D159)
  text: string;
  time: number;
  id?: string; // the network's message id, where it has one
  replyTo?: string;
  playback: boolean; // not news: ZNC's buffer at connection, or missed while down past its grace
  missed?: boolean; // said while the instance was down, delivered once by the connector
  own?: boolean; // sent by the account itself, from any of its devices
  document?: InboundDocument; // the file it carries; `text` is then its caption ('' without one)
  media?: InboundMedia; // what it carries besides text (D161); `text` is then its caption ('' without one)
  edited?: number; // an edit of message `id` (bot-os.md D144): when, ms; `text` its text now
  buttons?: readonly (readonly string[])[]; // its inline buttons' labels, by row; [] none; absent unknown (D145)
}

interface InboundDocument {
  name: string; // its file name, '' without one
  mime: string; // its media type, lower case, without parameters; '' if unknown
  size: number; // bytes
  text?: string; // its content, UTF-8 decoded: a text file of at most 256 KiB
  skipped?: 'type' | 'size' | 'encoding' | 'failed'; // why it has no text
}

interface InboundMedia {
  // described, never downloaded (D161); a file of any kind is in `document` as well
  kind:
    | 'photo'
    | 'sticker'
    | 'animation'
    | 'video'
    | 'round'
    | 'voice'
    | 'audio'
    | 'file'
    | 'poll'
    | 'location'
    | 'venue'
    | 'contact'
    | 'dice'
    | 'game'
    | 'story'
    | 'other';
  emoji?: string; // a sticker's, a die's
  title?: string; // a poll's question, an audio's performer and title, a venue's, a game's, a contact's name
  options?: readonly string[]; // a poll's answers
}

interface Surface {
  id: string; // as configs and edges name it: '-100…', '@QuestBot', '#lobby'
  title: string;
  kind: 'private' | 'group' | 'channel' | 'bot';
  lastActive?: number; // ms
}

interface Deletion {
  account: string;
  network: string;
  chat: string; // as its messages name it
  aliases?: readonly string[]; // the chat's other names (D90)
  ids: readonly string[]; // the messages deleted, as `Inbound.id` gave them
  time: number; // when the connector heard of it, ms: the network does not date a deletion
}

interface ConnectorHandle {
  account: string;
  status(): ConnectorStatus; // 'connecting' | 'connected' | 'closed', with the network's phase
  self(): string | undefined; // the account's own name on the network, once connected
  selfId(): string | undefined; // the account's own id, as senderId gives it, once connected; none on IRC (D167)
  onMessage(handler: (m: Inbound) => void): () => void;
  onStatus(handler: (s: ConnectorStatus) => void): () => void;
  onEdit?(handler: (m: Inbound) => void): () => void; // edits, opt-in (bot-os.md D144)
  onDelete?(handler: (d: Deletion) => void): () => void; // deletions, opt-in (bot-os.md D158)
  reads?(): readonly string[] | '*'; // the chats its edge reads (bot-os.md D139)
  isAdmin?(chat: string): Promise<boolean>; // where the network can say
  person?(idOrUsername: string): Person | undefined; // someone it has seen, by id or username (D167)
  onRename?(handler: (r: Rename) => void): () => void; // a known person seen under a new username (D167)
}

interface Person {
  id: string; // as Inbound.senderId gives it
  username?: string; // when last seen; none if they had none, or another took it since
  name?: string; // their display name when last seen
  bot?: boolean;
  seen: number; // when last seen, ms
}

interface Rename {
  id: string;
  from?: string; // the username they had; none if they had none
  to?: string; // the username they have now; none if they dropped it
  time: number;
}
```

**Who sent it** (bot-os.md D167): `senderId`, the network's stable id, is the key to remember a
person by; `senderUsername` is for display, and for a bot's texts that name people by it. A Telegram
id is given in the Bot API's decimal form, a user's or a bot's (`123456789`) or a chat's posting as
itself (`-1001234567890`); IRC has none, and gives the nick as `senderUsername`. A sender without a
username has none (not `''`). Changed in 0.1.69, which removed `sender`:

- **`Inbound.sender` is gone.** Code that read it no longer compiles. To key, allow or remember a
  person, read `senderId`; to show them, or to match a name a bot writes, read `senderUsername`.
- **No username is `undefined`, not `''`.** A test of `m.sender === ''` becomes
  `m.senderUsername === undefined`.
- **A connector handle has `selfId()`** beside `self()`; a hand-made connector or handle (a test's)
  adds it.
- **A reaction's payload** (§4.15) has `senderId` and `senderUsername` in place of `sender`: a
  reactor whose `when` or text named `sender` names `senderUsername` (or `senderId`).
- **Edges' `senders`** keep working: a username entry matches as before. Naming a person by id
  instead keeps them when they rename.

**The people directory** (bot-os.md D167, `packages/core/src/people.ts`): each Telegram connector
keeps everyone it reads a message of, live, edited or caught up, by id, with the username, display
name and kind they had when last seen, the latest 5000. A plugin finds one by id or by a username
they held when seen (`handle.person`), and hears a known person's new username (`handle.onRename`),
told before the message they were seen in: what a module needs to read a bot's text that names
people by username (`@alice, …`, `… from alice`), and to move what it keeps of a person from their
name to their id. A username is one person's at a time: seen on another id, it moves there, and the
one who had it keeps none until seen again. Nothing is looked up: a username never seen is unknown.
Each keeps its directory in its store (`people`), written when someone is new or changed or an hour
on (`telegram-bot`'s since D168, in memory only before). `irc`'s is always empty: a nick has no id.
A connector built on `ConnectorBase` keeps one by calling `keepPeople(store?)`;
`Connector.people(query)` lists it, most recently seen first, for the editor's picker.

**Edits** (bot-os.md D144): a message is heard once, as it was sent (`onMessage`). A plugin that
reads what a message becomes (a bot's menu, which its buttons edit in place) asks for edits as well:
`ctx.connector(port).onEdit(handler)` hears each edit, live, through the same edge (its chats and
senders), as the message it now reads: its `id`, its `replyTo`, its `text` now, `time` when it was
sent, `edited` when it was edited. Opt-in, so a plugin that never asks hears none: a command edited
after it was sent is not played again (the bots ignore edits too), and no answer is read twice.
`telegram-user` has them (GramJS's `EditedMessage`), once per edit; the others have none (`onEdit`
absent, or never called). Edits are not accounted for (D66): one made while the instance was down is
not caught up, the catch-up giving each message as it now reads. `FakeConnector.hearEdit(m)` says
one in a test. No answer is paired from an edit (D98).

**Deletions** (bot-os.md D158): a plugin that wants to know which of the messages it read were
deleted asks for them: `ctx.connector(port).onDelete(handler)` hears each deletion, live, through
the same edge, as a `Deletion`: the `chat` and the deleted `ids`, with `time` when the connector
heard of it. Its edge's chats filter it, not its senders: a deletion names none (nor who deleted,
nor what was said), so a plugin matches the ids against what it kept of the messages. Opt-in, as
edits are. `telegram-user` has them (GramJS's `DeletedMessage`) for a supergroup or a channel; a
basic group's or a private chat's carry ids alone and are not delivered; the others have none
(`onDelete` absent, or never called). Deletions are not accounted for (D66): one made while the
instance was down is lost. `FakeConnector.hearDelete({ chat, ids, time? })` says one in a test.

**Buttons** (bot-os.md D145): a bot's message with inline buttons gives their labels, row by row, as
its `buttons` (`[['◀️', '▶️']]`), and an edit gives them as they now are: a parser reads which
choices a menu offers, or whether a page is the first or the last (its ◀️ or ▶️ replaced). Labels
only: pressing one is not offered. `telegram-user` has them, `[]` for a message without any (a list
of one page); the others cannot tell, and leave `buttons` out.

**Files** (bot-os.md D82): a message that carries a file has its `document`. The Telegram connectors
download a text file (`text/*`, `application/json`, `application/xml`, `application/csv`, or no type
or `application/octet-stream` under a `.txt`, `.csv`, `.tsv`, `.json`, `.md` or `.log` name) of at
most `DOCUMENT_MAX_BYTES` (256 KiB, by the size Telegram states and by the bytes read), and decode
it as UTF-8, strictly, a byte-order mark taken off: its `text` is the content as is. Any other file
comes with its name, type and size only, and `skipped` says why: not text (`type`), too large
(`size`), not UTF-8 or holding a NUL (`encoding`), or a failed download (`failed`, warned of; the
message still goes). The core's `readDocument(file, download, warn?)` applies that rule for any
connector, and `isTextDocument(name, mime)` says which files it reads. The core keeps no message: a
file missed while the instance was down is downloaded again by the catch-up (`telegram-user`) or
Telegram's redelivery (`telegram-bot`), and each connector accounts for a message only once its file
is read. A bot never hears another bot, so a bot's export reaches `telegram-user` alone;
`telegram-bot` reads a file a person sends or forwards it.

**A chat by any of its names** (bot-os.md D90): a Telegram chat has an id and may have a
`@username`, and a config, an edge or a reaction may name it either way. The connector delivers a
message under one name (as its `chats` config names the chat, else as before: a group's id, a
private chat's `@username`) and gives the others as `aliases`; a chat-in edge's `reads` and a
reaction's `chats` match the name or any alias, without case (the core's `hears` and
`inChat(m, chat)`). `telegram-user` learns each chat's names from its dialogs (and a private chat's
from its first message), so it monitors, catches up on and sends to a chat its config names either
way; `telegram-bot` from the chats it has seen since it started. Since a private chat may so be
delivered under its id, both say whether a chat is private (`private`, as Telegram tells it): read
that, not whether the name starts with `@`. Each offers `chatNames(chat)`: every name it knows the
chat by, `chat` among them, or undefined for one it never saw, which the graph's check asks (§2.3).

A connector may also offer `chatTitle(chat)`, a chat's title by any of its names (both Telegram
connectors, from the chats they have seen), which a send the network refused names (§4.6, D95), and
`owner()`, the owner's own chat on the network (`telegram-bot`: its `owner`'s private chat), where
an edge naming no chat from an output declared `owner` sends (`owner-notice`'s, §2.1, §5, D97).

The connector itself also implements `send(chat, text)`, and, for a network whose sends answer later
(Telegram), `deliver(chat, text)`, which resolves with the message's id; and, for one that sends
photos (both Telegram connectors, bot-os.md D150),
`deliverPhoto(chat, photo, { caption?, format?, replyTo? })`, which resolves with the message's id
and the photo's (`photo`), to send it again by; only the outbox calls them: no plugin holds a way to
send that skips it. A connector without `deliverPhoto` (`irc`) cannot send photos, and the outbox
refuses them with why (§4.6).

**A message's photo** (bot-os.md D151): a connector may fetch the photo of a message on demand,
`photo(chat, message)` (both Telegram connectors), and its plugin then offers it as the action
`photo` of its node's interface (`photoAction` and `PHOTO_ACTION`,
`packages/core/src/message-photo.ts`), which a plugin reaches through an interface input bound to
the node, so that the edge is the permission (P6, P17); nothing is downloaded with a message (D82).
It answers a `MediaResult` (§4.18, bot-os.md D153), the photo its `media`:

```ts
inputs: { tg: { type: 'interface', plugin: 'telegram-user', members: ['actions.photo'] } },
// …
const { actions } = ctx.use<{ actions: { photo: FetchPhoto } }>('tg');
const r = await actions.photo({ chat: '-1001000000001', message: '4242' });
if (r.ok && r.media !== null) ctx.store.files.write('room-4242', r.media.data, { type: r.media.mime });
```

```ts
interface PhotoRequest {
  chat: string; // a chat the connector monitors, by any of its names
  message: string; // the network's id of the message (`Inbound.id`)
}
type FetchPhoto = (request: PhotoRequest) => Promise<MediaResult>;
// MediaResult (§4.18):
//   | { ok: true; media: Media | null } // null: the message has no photo
//   | { ok: false; error: string } // why not: not connected, not its chat, not found, too large…
// media: the largest size the network has; its mime read from the bytes (`sniffMime`),
// `image/jpeg` for a Telegram photo; its width and height in pixels, where the network says.
```

It never throws. A photo over `PHOTO_MAX_BYTES` (10 MiB, Telegram's own limit for a photo) is
refused with its size, before the download where the network states it, after it otherwise; a
request not of that shape, and a node that needs a login, are refused too. Each call is logged on
the connector's node: the caller, the chat, the message and the bytes' count, never the bytes.
`telegram-user` fetches the message by its id in its chat and downloads its photo's largest size; a
photo is one sent as such (a `MessageMediaPhoto`): a picture sent as a file is a document, a link's
preview the link's, and both answer `null`. `telegram-bot` cannot fetch a message by its id (the Bot
API has no such call), and never hears another bot: it keeps the `file_id` of the largest size of
the photos of the messages it hears and sends, the latest 1000, in its store (`photos`), and
downloads one with `getFile` when asked; a message it heard without a photo since it started answers
`null`, and any other is refused, saying so. `irc` offers no `photo`.

**Surfaces** (bot-os.md D63, D96): a connector may list the chats it can see,
`surfaces({ search?, limit? })`, most recently active first, for the owner to pick from (the control
API's `GET /accounts/<id>/surfaces`, §4.11), each a `Surface`: `id`, the name its config and edges
hold and the connector can send to; `title`; `kind` (`private`, a person; `bot`; `group`;
`channel`); `aliases`, its other names (a `@username` where `id` is an id, an id where it is a
`@username`), by any of which a search finds it; `lastActive`; and `unreachable`, why the connector
cannot send there, where it knows it cannot. `telegram-user` lists the dialogs of the account,
monitored or not (so that the owner can pick new ones), each named as its `chats` config would name
it: without a search, those whose latest message is at most 7 days old (by the core's clock), from
every folder but the archive (folder 1), and those its `chats` config lists whatever their activity,
latest first, at most 50 once filtered; a search, by title, username or id (any of its names), finds
any of them, archived and inactive ones too, of every kind. Both draw on the account's full list of
dialogs, every kind and both folders (the owner's own folders are filters over them), fetched once
for 30 s: a fetch with a limit returns the pinned dialogs first, however old, and filled the list
with them; the account's own chat (Saved Messages, whose peer is the account itself) is left out, as
no chat to monitor or pick; a basic group upgraded to a supergroup is left out (its supergroup is
listed), by the connector: GramJS's `ignoreMigrated` keeps those alone, and dropped every user, bot,
channel and supergroup; `telegram-bot` the chats it has seen in updates, kept in its store
(`surfaces`), each by its id (the one name the Bot API reaches a person by), its `@username` an
alias; its config's `owner`, asked of Telegram (`getChat`) before it has seen them, and listed
`unreachable` with why when Telegram does not give them (the owner never started the bot), asked
again at most every 10 minutes; and one searched by an id or a `@username` no chat seen has, asked
of Telegram and kept, since the Bot API cannot list a bot's chats and gives it only a chat it can
reach; and the people it has seen in its groups (the latest 200, in memory only), each `unreachable`
until they open the bot, for its lists of people (bot-os.md D100, D128); `irc` its channel. A chat a
`telegram-bot` config or edge names by the `@username` of a person it has seen goes to their id, so
a config saved so keeps working. A connector's `chats` config (the two Telegram ones) is what it
**monitors**: unset, every chat it has; each chat-in edge reads a subset (`reads`, `"*"` for all of
them). Its manifest says where its config names them (`monitors`, §2: `chats` for the two Telegram
ones, `channel` for `irc`), so that the check warns of an edge reading a chat its connector does not
monitor (§2.3, bot-os.md D89), a chat matched by any of its names (D90). A connector not running
lists nothing.

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
  while a gap below is open: what was heard live and what the account sent itself. In a private chat
  or a basic group, every message from the connection's first live id on is taken to come live; in a
  supergroup or a channel, only the ids seen (D147, below). A range that meets `last-seen` folds
  into it; at most 100 a chat, past which the lowest gap is given up (and warned of).

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

**A GramJS workaround: the updates not pushed, looked for** (bot-os.md D147; to revisit when GramJS
keeps update state). While connected, GramJS 2.26.22 keeps no update state either: an update
Telegram does not push to the session (it does not promise every one of a supergroup's) is lost
without a trace. A supergroup's or a channel's message ids (`-100…`) grow by one per message, so:

- **A gap, by id**: a live message more than one past the last id known of its chat (heard, sent,
  fetched, or the dialog's latest at connection) shows ids not pushed. A **look** follows a second
  later (`GAP_LOOK_MS`): one request for the chat's messages after the last id known before it, at
  most 100 (`LOOK_LIMIT`), each not yet delivered given oldest first, marked `missed` (news within
  its grace: `playback` only past it), the ids between accounted for when the page held them all (a
  deleted message is none). Looks planned in one chat are merged, from the lowest id asked.
- **After a send**: the answer to it may be its chat's last message, which no later one would show
  missing, so each send to such a chat is looked after, 4 and 15 seconds later
  (`LOOK_AFTER_SEND_MS`).
- **Only what was seen** is accounted for in those chats (a live id, a send, a look's), so a gap no
  look filled (a failed look is logged; a larger one than a page) is fetched at the next connection.

**The raw log** (D147, `packages/connectors/src/transport/raw-log.ts`): the last 8 hours of what the
connector heard live, fetched (a catch-up, a look), sent and found missing (a gap), each entry with
when (`at`), how (`via`), the chat and the message as delivered, in its store's `raw-log` document
(`/data/instances/<connector>/raw-log.json`), written at most 30 seconds after an entry and at a
stop, older entries dropped. Shown nowhere: for debugging on the volume. It holds the chats' text.

**A login from its node** (bot-os.md D116, `packages/core/src/login.ts`): a connector whose manifest
says `login` keeps its credentials in its own store (`login`, a document of mode 600 like the rest),
from a login the owner does in its node's panel, and reads them at `create`: their only place, no
Docker secret (bot-os.md D118). Without them it runs all the same, as a `LoginNeeded` connector:
`closed`, its phase `needs login` (which its card shows), hearing, sending and listing nothing, so
that a new connector is added, applied, logged in and restarted, and its chats ticked. Its instance
offers a `login`, `{ state(), act(action, values) }`: where it stands (`LoginState`: `status`
`needed`, `pending` or `done`; `source`, `store`; `as`, whom it is logged in as, the name the owner
recognises (`@ExampleBot`, an account's `@username` or first name), kept with the credentials so
that it is known before the connector connects, and shown on its card and in its panel through
`GET /accounts`'s `as` (bot-os.md D120); `restart`, its credentials changed since the start, which a
restart puts in force; a `note`; an `error`, why the last answer failed; the `step` it asks, with a
`title`, a how-to `text`, a `link`, a `qr` link to show as a QR code and when it `expires`, and its
`fields`, each a line of text, `secret` ones typed unseen; and the `actions` offered, buttons that
send the step's fields when they `submit`, ask first when they say `confirm`). The web UI draws it
generically, as it draws a form from a schema, knowing no network. A connector marks each value
typed and each credential it keeps secret (`ctx.secrets.remember`), so that the core redacts them
from what it prints, records and answers; the core records each action (`core.login`: the node, the
action, where it led and whom as, never a value). `telegram-bot` asks for its token (checked with
`getMe`, "as @ExampleBot") and forgets it on demand (revoking it is @BotFather's `/revoke`);
`telegram-user` asks for its API id and hash once (my.telegram.org), then logs in by QR code
(GramJS's `signInUserWithQrCode`, renewed as it expires) or by phone (the number, the code, the 2FA
password; at the code step, **Resend the code** (bot-os.md D126) has GramJS start its `signInUser`
again on the same number with `forceSMS`, a new `auth.SendCode` then `auth.ResendCode`, Telegram
picking the next way, an SMS or a call; the step says where the code went as far as GramJS tells,
the app or not, and a refused resend shows Telegram's error, offering the resend again and the
cancel), one login at a time, dropped after 5 minutes without an answer; its logout ends the session
on Telegram too (`auth.logOut`), and its sessions show in the account's Devices as the app
registered at my.telegram.org on the device `MegaBotTron1999`. **No credentials twice** (bot-os.md
D121): a bot or an account is one node's, since two connectors polling one bot's token conflict on
Telegram and one account's two sessions would each hear and send as it. `telegram-bot` refuses a
token whose bot (the id before its colon) another node of the plugin holds, before asking Telegram;
`telegram-user` refuses an account (its user id, kept with the login) another node is logged in as,
its new session ended at once (`auth.logOut`). The refusal names that node; forgetting the token or
logging out there frees it. The nodes compared are those loaded in this run, each from what its
store keeps.

As built (`packages/core/src/connector.ts`): a connector plugin's instance offers its `connector`,
whose account must be its node's (`ctx.account`; a test's fake connector, given an account of its
own, sits on a node that names it, as the dev kit's default graph does); `ConnectorBase` keeps the
listeners and the status for the implementations. `ctx.connector(port)` gives a handle only on a
connector a chat-in input of the plugin is bound to, and the handle hears only the chats that edge
`reads` (compared without case; any, for `"*"`) and the `senders` it names (anyone without; each an
id or a username, `sentBy`; `me`, the account's own, `own` or its own id or name), as
`hears(filter, message, { name, id })` matches them. A connector's node has a chat-in output,
`chat`, which the readers' edges leave, and a chat-out input, `chat`, which the senders' edges reach
(§2.1, bot-os.md D60); a service connector (`chat: false`, D148) has neither. The wiring reaches the
full connector with `core.connector(id)`. The shell's connectors are in §5.

**A model connector** (bot-os.md D117): a connector whose manifest says `model: true` spends money
on each call, so the editor marks its node with a `$`, and it accounts for its calls itself, since
the core tells each action who calls it (`ActionCall`, §2): one record per call in the event log,
`<plugin>.call`, with the calling node, the model, the tokens and the cost in USD (`null` for a
model it has no price for, never guessed); its last 24 hours in its `status` read, by calling node,
shown by its widget and page (§2, Widgets and pages); and their total in its `Instance.cost`
(`spend`, §4.11). The `anthropic` connector is one (§5; `packages/connectors/src/plugins/spend.ts`
does the accounting for any).

### 4.6 The outbox

One per account; every send goes through it (bot-os.md §3). A plugin gets its handle with
`ctx.outbox(port)`, bound to its own id, through a chat-out output an edge binds to the account's
connector (§2.1):

- **The reach:** each chat-out edge from it to the account's connector lets it send to its `sends`,
  with its `commands`; a send outside them is refused (but the connector's owner's chat through an
  edge naming none from an output declared `owner`, §2.1, D97). A chat-in edge sends nothing. The
  handle `ctx.outbox(port)` gives sends through that output's edge alone; named by the connector or
  the account, through every edge to it. `ctx.outboxes(port)` gives one handle per connector an
  output of several edges binds (`many`, D97), and a handle's `chats()` the chats it may send to.
- **A dry run** (bot-os.md D64): a send through a `dryRun` chat-out edge is logged as sent (outcome
  `dry-run`), counted in the account's rate, and never sent; through a live edge (one of several
  that let it send this, if any is live), it is sent. The handle's `mode()` says which: `dry-run`
  when every edge it sends through is a dry run, `live` otherwise.
- **The node's state** (§2.1, Node states): a stopped node's sends are refused
  (`stopped: <reason>`), and so are those of a node not running (`not running (<state>)`).
- **Pacing:** `send` sends now or is refused with why (too soon, the hourly limit), for actors that
  time their sends to the second; `enqueue` queues the send (below, bot-os.md D73) and spaces it
  within the account's limits (`connector.limits`) and its command's interval in its chat, and the
  network's waits (Telegram's `FLOOD_WAIT`) hold the account's queue.
- **Replies:** matchers pair a bot's answer with the send that caused it: `replyTo`, `mentioning`,
  `within` and `from`, combined with `all`, and `waitFor` waits on a connector handle for the first
  match (`packages/core/src/replies.ts`).
- Every attempt is logged (`core.send`), with its outcome.

**A photo** (bot-os.md D150): `send`, `enqueue` and `deliver` take a photo where they take a text,
`{ photo, caption?, replyTo? }` (`PhotoSend`): `photo` a `Media` (§4.18, bot-os.md D153; uploaded
named by its type, `photo.png`) or the network's id of one sent before (`CommandPhoto`, §2);
`caption`, the words under it, plain, or Markdown with `format: 'markdown'`, or Telegram HTML with
`format: 'html'`, as a text takes it (here in `send` and `enqueue` too); `replyTo`, the network's id
of a message in that chat it answers.

```ts
const r = await ctx
  .outbox('chat')
  .deliver(
    '#lobby',
    { photo: { data, mime: 'image/png' }, caption: 'A *rare* card', replyTo: m.id },
    { format: 'markdown' }
  );
// { text: '[photo image/png, 48213 bytes]', outcome: 'sent', id: '<message id>', photo: '<photo id>' }
await ctx.outbox('chat').deliver('#lobby', { photo: r.photo as string }); // again, by its id
// Telegram HTML the plugin writes (D164), a player's words escaped with `escapeHtml`:
await ctx.outbox('chat').deliver(
  '#lobby',
  {
    photo: r.photo as string,
    caption: `<u>Wanted:</u>\n<blockquote><b>${escapeHtml(name)}</b></blockquote>`,
  },
  { format: 'html' }
);
```

It runs every check a text does, in the same order, but a command's: the reach (its chat in the
edge's `sends`; an edge that names `commands` lets it through only with `photos: true`, on the edge
or its output, §2.1: `a photo is not among <node>'s commands: its edge or output must say photos`),
a dry run, the node's state, a flood wait, the rate and the connection. It is no command: no
watchdog (D93), no answer waited for (D98), no command's interval (D73), and a queued photo is never
coalesced. Refused at once, before anything is sent: a caption over `CAPTION_MAX` (1024 characters,
Telegram's, counted as written, an HTML caption's as Telegram counts it, by the text it shows (its
tags left out, an entity one character, D164):
`a caption of 1100 characters, over the 1024 a photo may carry`), bytes that are no photo
(`PHOTO_MIMES`: JPEG, PNG, GIF or WebP) or not the type they say (`photoRefusal`, D153:
`the photo: its bytes are image/jpeg, not the image/png it says`), and a connector that cannot send
photos (`<account> cannot send photos`: one with no `deliverPhoto`, such as `irc`). `deliver`
answers the network's id of the photo sent (`photo`), beside the message's (`id`), to send it again
by; a queued photo settles with it too (`QueuedResult.photo`). Its result's and its record's `text`
is its label, `[photo <mime>, <n> bytes]` (`[photo]` by an id); the record (`core.send`) has its
caption's length (`caption`), never its bytes nor its caption.

As built (`packages/core/src/outbox.ts`): the checks run in a fixed order, each refusal with its
reason: the caller's own refusal (`refuse`, for a game's grammar), the reach
(`… does not send to …`, `… is not among …'s commands`, by first word), whether it is a dry run, a
stop (`stopped: …`, or `not running (…)`), a flood wait (a connector throws `FloodWait`, which holds
the account), the rate (`too soon`, `hourly limit`, dry runs counted), and the connector
(`not connected`). **A queued send waits for the connection** (bot-os.md D108): while the account's
connector is about to start, starting, or running and (re)connecting (`connecting`, as at the start
of the instance or after a drop), a live send in the queue stays `waiting` and goes, through every
check above, once it connects; it expires at its deadline (`cancel`), and one with none is refused
after `CONNECT_WAIT_MS` (5 minutes) of waiting, `not connected: waited 5 min for the connection`. A
dry run does not wait. With no connector running (stopped, disabled, failed) it is refused
`not connected` when its turn comes, as before; `send` and `deliver`, which send now, are refused at
once. `deliver(chat, text)` runs the same checks, then awaits the connector's `deliver`: `sent` with
the network's id of the message, `refused`, or `failed` with why the network refused it; the rate
counts the send when it leaves. A send may say its text is Markdown (`format: 'markdown'`): a
connector of a network that formats sends it formatted, any other as written. Or that it is Telegram
HTML the plugin wrote (`format: 'html'`, bot-os.md D164), for what Markdown cannot say (an
underline, `<u>`; a quote, `<blockquote>`; Markdown's `__x__` stays bold): the plugin escapes `&`,
`<` and `>` in any words it did not write with `escapeHtml` (from `@megabottron1999/core`, beside
`TextFormat`), and a Telegram connector sends it as written, as HTML, and again as the text it shows
if Telegram cannot parse it; a connector that formats nothing (`irc`) sends that text,
`htmlToPlain(html)` (its tags removed, `&lt;`, `&gt;`, `&quot;` and `&amp;` unescaped), and so does
the outbox for a text sent without its format (`send`, `enqueue`). Every attempt's record
(`core.send`) has the `mode` it went in (`dry-run` or `live`).

**A send the network refuses** (bot-os.md D95): a live send, queued or not, goes through the
connector's `deliver` where it has one (both Telegram connectors and `irc`; its `send` otherwise),
so that the network's answer comes back to the outbox instead of the container's log alone. Its
refusal (a flood wait holds the account, as before) is recorded as `core.send-failed`
(`{ account, plugins, chat, title?, text, reason, hint }`: the nodes it went for, the chat's title
where the connector knows it, `Connector.chatTitle`, the network's words and
`unreachableHint(reason)`'s, what it means and what to do: a person who never started the bot, a
group it is not in, no right to post, the bot blocked, a chat it cannot find) and raised as an
`unreachable` notice per node (§4.16), **but for a node that tells the owner itself** (its manifest
declares `notices: true`, `owner-notice`), which would send its own failure again: its failures are
recorded and shown on its panel. A queued send then settles `failed`, with the reason (once the
network answers: its pacing is counted as it leaves). The summary counts it as `failed`. `irc`
refuses a chat other than its channel so (`it sends only to its channel #lobby, not alice`); the
replies an IRC server may send later (`404`, cannot send to channel) are not tied to a send.

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
const r = await q; // { text, outcome: 'sent' | 'dry-run' | 'refused' | 'failed' | 'cancelled' | 'expired', reason?, event? }
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
  `event` one of `queued`, `coalesced`, `sent`, `dry-run`, `refused`, `failed`, `cancelled`,
  `expired`); the queue as it stands is the connector's (`GET /plugins/<id>/queue`, §4.11), shown in
  its panel.
- **Merges seen:** a merge may say that two nodes duplicate a piece of logic, so while the queue is
  young they are easy to see without the log: the connector's panel marks a send several nodes share
  (`shared by 2 nodes`), and counts the sends coalesced since the start with the pairs of nodes that
  shared them (`3 sends coalesced since the start: a + b (2), a + c (1)`), which its card's line and
  `GET /status`'s `summary` carry too. The count lives in memory, as the queue does, and starts
  again at each start. Each merge is also raised as a `coalesced` notice (§4.16), for a node that
  tells the owner (`owner-notice`, §5).
- **The watchdog** (bot-os.md D93, #41): a parser that stops reading its bot's answers (a protocol
  change it does not know yet, before its drift passes the threshold) would leave a node queuing the
  same command at every interval, its cancels waiting for an event that never comes. So the outbox
  counts, for each node, chat and command (its first word, as the reach and the intervals name it),
  the **live sends that went with no event read from that chat before the next one**. Past the
  threshold, the next send is refused
  (`stopped: stalled: 10 sends of /inventory to @QuestBot went unanswered`), and the node is stopped
  as drift stops it (P5): `source` `stalled`, kept in its instance, the nodes that require it made
  inactive at once (D65), until the owner clears the stop in the editor and applies (§2.1, Node
  states); a `stalled` notice is raised (§4.16).
  - **Watched:** a node of kind `actor` (as drift stops only those), sending to a chat that a node
    up which registers events reads on the same account (a chat-in edge naming the chat, without
    case, or reading every chat): a chat no parser reads can give no answer, and a node that does
    not act (`owner-notice`, a stats node) is never counted.
  - **An answer:** an event a node publishes **while the core hands it a message** of that chat
    through its chat-in edge (`ctx.connector(port).onMessage`, synchronously, as the parsers do);
    the account's own messages and history (`playback`) are none; the chat matched by any of its
    names (`aliases`, D90), without case. Any event read from the chat starts every count of that
    chat again, whatever command it answers: the watchdog asks only whether the bot still speaks and
    is read, not whether this command was answered (that is #59's).
  - **Counted:** `send`, `deliver` and a queued send, as each goes live; **a dry run never** (D64),
    nor a refused send. A coalesced send (D73) counts for each of its live nodes, each on its own,
    and one at its threshold has its share refused while the others go.
  - **The threshold,** in the connector's config beside `commandIntervalS` (`irc`, `telegram-bot`,
    `telegram-user`): `unansweredAt`, 10 by default (`DEFAULT_UNANSWERED_AT`), and `unansweredAtBy`,
    per command (`{ "/inventory": 3 }`); 0 turns it off, for the account or for one command. Of a
    `Limits`: `unansweredAt`, `unansweredAtBy`.
  - **Resumed by hand only,** as after drift: the stop is the core's (kept across restarts, D64),
    and a node made inactive by it was shut down, so a parser heard again later starts nothing by
    itself. The counts live in memory and start again at each start.

**Command answers** (bot-os.md D98, #59; `packages/core/src/answers.ts`): the watchdog asks only
whether the bot still speaks; a node that sends a command also needs to learn what the game answered
to _its_ command (refused, and why), so that it adjusts its plan rather than retrying something the
game will not allow. Answers are in memory and best effort: nothing is kept across a restart, where
the node decides again from its state. **The outbox keeps no game's cooldown** (bot-os.md D142): an
answer holds nothing back; when a command may be played is a state's readiness (§5), which a player,
or a script that cares, binds to, and the outbox only does delivery hygiene (the limits, flood
waits, intervals, the guard and the watchdog).

- **A parser declares** which of its own events answer which commands, in its manifest:

  ```ts
  answers: [
    // The first that matches an event is its answer.
    { event: 'quest.give', commands: ['/give', '/throw'], when: { result: 'wait' },
      status: 'refused', reason: 'cooldown' },
    { event: 'quest.give', commands: ['/give', '/throw'], when: { result: 'no' },
      status: 'refused', reasonFrom: 'why' },
    { event: 'quest.give', commands: ['/give', '/throw'], unless: { result: 'unknown' },
      status: 'ok', withinS: 60 },
  ],
  ```

  `event` is one of its `events`; `commands`, by first word; `when` (as a cancel's: dotted paths, a
  list holding a value) and `unless` (every field holding: not this answer) choose by the payload;
  `status` is `ok` or `refused`; `reason` a fixed one (`cooldown`, `missing`, `invalid`, or a game's
  own) and `reasonFrom` a path of the payload holding one; `withinS` how long the bot takes to
  answer (120 by default). A wait the bot states, or an effect it announces, stays in the event's
  payload, for a state to reduce (D141), and is no field of the declaration (D142). A parser of
  another repository declares them the same way, in its `definePlugin` manifest; the turn parsers
  declare theirs (§5).

- **The answer** (`CommandAnswer`): `{ status: 'ok' | 'refused' | 'unanswered', reason?, event? }`,
  `event` the one that answered (`{ type, t, …payload }`: a wait the bot stated is there, under the
  parser's own field).
- **Paired by the core:** an event a node publishes while the core hands it a message of a chat
  (synchronously, as the watchdog hears an answer; the account's own messages and history, and a
  payload marked `playback`, are none, D83) that one of its declarations matches answers a live send
  of one of its commands to that chat (by any of its names, D90) that waits for an answer: the one
  the message replies to (`replyTo`, the network's id of the send), else the oldest. A send waits
  for an answer when a node up that reads its chat on that account declares one for its command, for
  the longest `withinS` of them; past it, `unanswered`, and the owner is told once with an
  `unanswered` notice (§4.16, D107) until a send of that command by that node to that chat is
  answered: a bot that ignores a command in a chat (a game's command it takes only in a group) is
  seen. A dry run waits for none. **A declaration names only the commands that can draw its event:**
  the core cannot tell which of its commands a message answers, so the oldest waiting send of any of
  them takes it, one the bot ignored included, and a declaration wider than its commands pairs an
  answer with the wrong send and feeds the guard the wrong refusals (D107). A parser that reads
  several chats with a bot that answers some commands in only some of them says so in the payload (a
  field of its own, such as `private`) and declares those commands `unless` it.
- **`await enqueue(…)`** settles, for such a send, once it is answered:
  `{ outcome: 'sent', answer }`; `status()` says `sent` meanwhile. Any other send settles as it
  goes, as before. `send` and `deliver` return at once as before, but their sends wait for an answer
  all the same, for the guard and the watchdog.
- **The retry-loop guard:** a node whose command keeps being refused for the same reason (any
  `refused`, a "too soon" included: D142) is held back from it in that chat once it reaches
  `GUARD_AT` (3) refusals in a row, for `GUARD_BASE_MS` (a minute), doubled at each refusal more, up
  to an hour: a back-off of its own, which models no game's cooldown. Queued, it waits it out (its
  `waitingUntil` says so); sent now (`send`, `deliver`), it is refused
  (`backed off: refused 3 times in a row (missing), 60 s more`, with `retryAt`, when it may go
  again). `ctx.outbox(port).held(chat, command)` says what holds a command back now,
  `{ until, reason }`: the guard, nothing else. An `ok` clears its count; a refusal for another
  reason starts it again. It is shown in `GET /status`, the node's `backoff`
  (`[{ account, chat, command, reason, count, until }]`, §4.11), and raised once, at the third, as a
  `backoff` notice (§4.16).
- **The watchdog** (D93): an answer paired with a send answers that node's count of its command at
  once; an answer that never came adds an unanswered send at the end of its window.

### 4.7 Drift

A parser sorts every message it sees into one of three (P5): **not its bot's**, **read** (events
published), or **claimed but unread** (its bot's, in a form it does not know). The parser reports
the third to `ctx.drift`, with the text; the core logs it (`core.drift`), counts it per parser, and
raises a `drift` notice (§4.16).

**Unrecoverable** (bot-os.md D21): more than 5 unread messages from one parser within 15 minutes, a
threshold each parser's manifest may change (`drift`: `unreadAt`, `windowMin`). Then the core stops
every running plugin of kind `actor` that requires that parser, directly or through other plugins
(`source` `drift`, kept in its instance: §2.1, Node states), until the owner clears its stop in the
editor, and the nodes those stops make inactive are shut down at once (D65); the other plugins keep
running and reporting. Nothing stops before the threshold is passed: the unread messages under it
are only reported.

As built (`packages/core/src/drift.ts`): a parser reports through `ctx.drift` (`read`, `unread` with
the text and the lines it did not know); the contract's type is `Reading`. Each unread message is
logged (`event: "unread"`) and raised as a `drift` notice (`detail`: `unread`, the text, and `more`,
those since the last), the first at once and then at most once an hour. Past the threshold the core
stops the actors once until the rate falls back, logs it (`event: "pause"`, with the plugins
stopped) and raises a `drift` notice (§4.16, `detail.paused`); `core.drift()` gives the counts. Each
record carries the `version` the parser runs (`GET /status`'s, §4.11), so that the web UI's Drift
page shows a parser's reports of the version it runs now, and folds those an upgrade left behind
under one line (bot-os.md D113); records written before had none, and are shown as current, as are
those of a parser whose version is not known (a test, the dev kit; D166).

### 4.8 The owner

The owner of the instance (D19) is **told only through the graph** (bot-os.md D94): the core sends
no chat anything on its own. What the core does on its own (a plugin failed, a drift, a refused
saved graph) and what a plugin asks to say (`ctx.notify(text, buttons?)`) are raised as notices
(§4.16): recorded in the event log (`core.notice`), which the editor's events panel shows (filter
`core.notice`), and heard by an `owner-notice` node (§5), the one node that reports to a chat.
`ctx.notify` raises a `told` notice about its node, its buttons in `detail.buttons`; `owner-notice`
sends it at once, one message each, with its buttons when its chat edge goes to a `telegram-bot`'s
owner's chat (through the bot's chat surface, so that a tap runs the owner's command as a card's
does), text alone anywhere else (IRC, another chat), and none while the instance is off. **With no
`owner-notice` in the graph, nothing is sent anywhere**: the events panel alone shows them; the
setup wizard (#45) wires one first. The owner's chat surface (bot-os.md D56) is the interactive
control, not a report channel: a `telegram-bot` node configured with its `owner` (the owner's
Telegram user id: the owner's private chat with the bot, §5) answers the owner's commands, cards and
buttons there; a plugin's commands are answered only where a commands edge from it serves them
(§2.1, bot-os.md D109). Only the owner's chat may use the owner's commands and their buttons: the
surface answers them to the owner alone (`Asker.owner`), never in a group. The owner's controls are
the core's (§4.11).

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
provided, never their values, for the editor's choice); the editor's node panel lists a connector's
secrets (those it declares and those its config names), each by name, whether it is provided (from
those names), and where it comes from, a Docker secret, never its value; no other kind of plugin has
`ctx.secrets`; a secret declared or named and not provided, or a value that is no secret's name,
fails the load (and the graph's check), naming it and its file, a connector that logs in from its
node (`login`, §4.5) included. `secrets.remember(value)` marks a value the connector holds as
secret, to be redacted as the Docker secrets are: a credential it keeps in its store, a value typed
in its login. `core.secretStore` keeps the core's own secrets (a login done later through the UI),
each in `/data/core/secrets/<name>.json` of mode 600: AES-256-GCM with a random IV and the secret's
name as additional data, under a key derived (HKDF-SHA256) from the `bot_os_key` Docker secret;
without that secret it stores nothing.

**Credentials sealed at rest** (bot-os.md D123, `Sealer`, `SealedStore`): a connector keeps what a
login gives it through `ctx.secrets.store`, a view of its own store whose documents are written
sealed: `{ "$sealed": 1, "iv", "tag", "data" }`, the document's JSON under AES-256-GCM, its key
derived (HKDF-SHA256) from `bot_os_key`, the instance and document's name (`tg/login`) its
additional data, its IV derived from that and the value (an HMAC, as SIV does: the same value seals
the same way). Every string opened is remembered as a secret, for redaction. **Without
`bot_os_key`** they are written in clear (mode 600), so that a fresh install still logs in, and the
login's state says so (`atRest: "clear"`, a warning in the node's panel: provide the key); with it,
`atRest: "sealed"`, and a document kept in clear is sealed as soon as it is read (the next start).
**A changed or missing key:** a sealed document that does not open reads as none, so the connector
runs needing a login, its login's `error` saying why (`its kept login does not open: …`) until it
logs in again; nothing crashes.

**Sensitive config fields** (bot-os.md D124, `packages/core/src/sensitive.ts`): a plugin marks the
keys of its config whose values must never be shown back in its manifest's `configSensitive` (a
password, an API key typed into a node rather than kept as a Docker secret):

```ts
manifest: {
  config: z.object({ apiKey: z.string().optional(), model: z.string() }),
  configSensitive: ['apiKey'],
}
```

Its node gets the value in `ctx.config` as typed; everywhere else it is protected. **In the graph's
file** (`graph.json`, and each version of `graph-history/`) it is sealed as a connector's
credentials are (`{ "$sealed": 1, … }`, under `bot_os_key`, its config key as additional data, so
that a node renamed keeps it); without the key it is written as typed, as the rest of the file.
**Shown nowhere:** every view of a graph that leaves the core goes through one function,
`hideSensitive`, which shows a value set, in any form, as `{ "$sensitive": "set" }`:
`GET /graph/file`, `GET /graph` and `/graph/view` (the node views' `config` too),
`POST /graph/check`'s diff and text, the history's versions, their texts and line diffs, a
rollback's answer, and the audit records of a save (`core.config`); a graph's text prints it as
`[sensitive]`, whatever its form; and every value opened is remembered as a secret, so the core
redacts it from what it prints, records and answers (errors and notices included). **From the
editor:** the field says `set` or `not set`, and offers **Replace** (typed unseen) and **Clear**; a
draft that leaves it as it was sends `{ "$sensitive": "set" }` back, which the check and the save
take from the saved file (by node id and key: a node renamed in the draft has it set again, a
warning saying so). **Existing graphs:** a value saved in clear before D124 is sealed at the next
save (a version of the history that holds it in clear stays so until it ages out, 7 days and 5
versions, shown hidden meanwhile; restoring it writes it sealed). **A missing or changed key:** a
value that does not open is left out of the node's config, the check and the load warning
`node <id>: config <key>: its sealed value does not open (…)`, so the node runs without it, or fails
as its schema says if it is required; set it again. No first-party plugin marks a key yet: their
credentials are Docker secrets or logins.

**Backups and secrets.** The Docker secrets are not in the data volume: back them up where the
deployment keeps them. The credentials a connector keeps from a login in its node (bot-os.md D116: a
bot's token, an account's API pair and session) are in its store, in the volume, sealed under
`bot_os_key` (D123; in clear, mode 600, without the key). The secrets the core stores itself are in
the volume, encrypted too: a backup of the volume holds them only as ciphertext, readable with
`bot_os_key`, which is not in it. Restoring the volume elsewhere therefore needs the same
`bot_os_key`; with another key, those secrets are lost and must be stored again.

### 4.10 The dev kit

What any plugin runs against outside an instance, in tests and in simulators (P15), from the core's
public API (`packages/core/src/devkit.ts`):

- **`FakeConnector`**, and `fakeConnectorPlugin(id, connector)`, the connector plugin on it: a
  connector of any network (the account's prefix), whose messages the test or the simulator says
  (`hear`, live unless `playback`) and whose status it sets (`open`, `connecting`, `close`), and
  whose sends go to its `onSend` (and are kept, `sent`), with the account's `limits` and the chats
  it administers (`admins`), its own name and id (`self`, `selfId`, bot-os.md D167), and, with
  `people`, a people directory in memory, as a Telegram connector keeps one (D167). It sends photos
  (`deliverPhoto`, bot-os.md D150; none with `noPhotos`, as `irc`), kept in `sent` too (`FakeSent`):
  `text` the caption (`''` without one), `photo` as sent, `format`, `replyTo`, and `id`, the photo's
  id it answers (`photo-<n>` for bytes, the id it was sent by otherwise); the message's id is
  `m<n>`. Given the photos of its messages (`photos`: `{ chat, message, photo }`, `photo` a `Media`
  or a string, the why of a refusal; more with `givePhoto(chat, message, photo)`), it fetches them
  (`photo`, bot-os.md D151), a message not given one answering `null`, and `fakeConnectorPlugin`
  then offers the action `photo` on its interface, as a Telegram connector's does (§4.5): a plugin
  bound to `fakeConnectorPlugin('telegram-user', fake)` with members `actions.photo` asks it as it
  would live. The plugins read it through their handles and send through their outboxes, as they do
  live.
- **`fakeMedia(mime?, { size?, width?, height? })`** and **`assertMedia(value, limits?)`** (§4.18,
  bot-os.md D153): a `Media` made up for a test (a PNG by default), its first bytes those of its
  type where `sniffMime` reads it, padded to `size` (64 bytes by default): bytes that pass
  `mediaMismatch`, not a picture a decoder would draw; and a value checked to be a `Media` within
  `limits` (`mediaRefusal`), returned as one, or thrown with why (`not a media: …`).
- **`DevKit`**: a core on a `VirtualClock` (§4.1) whose stores are in memory, with the plugins of
  the run, the run's graph (`graph`; by default one instance of each, bound as the manifests say,
  each connector's node on its manifest's account: a graph given names a fake connector's account on
  its node, which is otherwise `<network>:<node id>`) and, set before it starts, keyed by plugin
  instance: their configuration (`config`), the owner's kept settings (`settings`), the documents
  their stores start with (`documents`) and their files (`files`, each a `Media`, its bytes and its
  type; bot-os.md D155: a collection's pictures, made with `collectionSeed`, §5), and the event log
  before the run (`history`), which the plugins read with `ctx.events`; `kit.log` is that log in
  memory, every record of the run added (`MemoryEventLog`). The stores' files (`ctx.store.files`,
  §4.2) are in memory too, their times on the virtual clock, within the core's limits or the run's
  (`fileLimits`). An archived plugin runs on a kit only when the run says so (`allowArchived`).
  `start` refuses a setting refused and a run with a plugin failed; `runUntil(t)` runs the clock.
  The core is the instance's own, unchanged.
- **Script nodes** (§5, bot-os.md D76) run on a kit in the main thread
  (`scriptPlugin({ isolation: 'in-process' })`), on its virtual clock, so that a test of one stays
  deterministic.
- **`defineSimulator({ manifest, run })`**: a simulator plugin (bot-os.md D13), a model of a game
  that runs other plugins on a kit. It is not registered in an instance: its manifest (kind
  `simulator`) names it, the game it plays (`games.consumes`) and the plugins it runs (`requires`),
  and `run(run, options)` plays one run.
- **Telegram exports** (`@megabottron1999/telegram-export`, bot-os.md D130): Telegram Desktop's chat
  exports, HTML and JSON, read into one shape of message (`readExportPaths`, or the pure
  `readHtmlExport`, `readJsonExport` and `mergeExports`), and turned into the `Inbound`s the owner's
  account (`telegram-user`) would have delivered (`toInbounds`, by a per-replay mapping of the
  owner, the chats and the senders), for a replay through real plugins; a command line prints either
  as JSON Lines. The format: [telegram-export.md](telegram-export.md).
- **Replay** (`replay` of `@megabottron1999/telegram-export`, bot-os.md D131, #49's history): those
  `Inbound`s fed to a module's plugins, or to a graph file in the live format, on a kit whose
  `telegram-user` nodes are fake connectors (their config's `chats` filter and name what they
  deliver, as live), in time order on the virtual clock, its timers run on the way, live or as
  history (`playback`); out come the event log, drift, and the plugins' state and actions, read as
  the owner's controls read them.

### 4.11 The owner's controls

What the owner sees and changes of the instance, built from what each plugin declares (P11) and
nothing else, so that every surface offers the same: the chat surface's owner commands, the HTTP
control API, the web UI and later the agents, whose grants will be subsets of it. As built
(`packages/core/src/controls.ts`, `core.controls`):

- **Each plugin:** the `version` it runs (its module's, as loaded, `GET /modules`; the release's,
  `GET /instance`, for one of the image's own; none when neither is known, as in a test; bot-os.md
  D113, D166), its state (bot-os.md D64, §2.1: `running`; `disabled`; `stopped`, with its `stop`,
  `{ reason, time, source }`; `inactive`, its `reason` the node it needs, `needs tg (disabled)`;
  `failed` with why; bot-os.md D143: `loading` while the plugins load, and `unloaded` for a node
  whose plugin did not load, its `reason` and its `failures` naming each package or module and its
  error, after the nodes the core runs), its settings with the values in force, the names of the
  reads and actions its `interface` declares, its own account of itself if it declares a read named
  `status`, the output of the read its widget names (`widget`, bot-os.md D112), for its card, and,
  if it keeps a state (its instance's `view`, bot-os.md D72), one line of it (`summary`), for its
  card; a connector whose queue coalesced sends since the start says so there too
  (`2 sends coalesced: a + b (2)`, D73).
- **What holds a node back** (bot-os.md D98), its `backoff` in `GET /status`, while there is any:
  each command the retry-loop guard holds back (§4.6, Command answers),
  `{ account, chat, command, reason, count, until }`.
- **What each node costs** (bot-os.md D77), its `cost` in `GET /status`, since the start:
  `dispatch`, its handlers' `calls`, their time (`ms`) and the longest (`maxMs`), timed where the
  core hands it a bus event, a message or a timer (the synchronous part, real time); and `own`, what
  its instance says (`Instance.cost`): a script's `runs` (`worker` or `in-process`), its handlers'
  `calls`, `errors`, `ms` and `maxMs` from each call to its end, and its worker's `cpuMs`, the CPU
  its script's own runs spent (its first run, and each event, call's answer or send's outcome until
  the thread is idle again; the thread's start and idle time left out, bot-os.md D87), and
  `heapBytes`, both as the worker last said when it got idle: nothing is polled; and a model
  connector's `spend` (bot-os.md D117), its money over the last 24 hours: `usd`, `calls`, and
  `unpriced`, the calls of a model with no price, whose cost is unknown. Each node's panel in the
  editor says its own, and the editor's **Costs** side sheet (`#/resources` opens it, bot-os.md
  D111) lists the nodes by cost, a worker's CPU or else its handlers' time, most first, sortable by
  any column (a model's spend one of them), the top three marked with their share. The timing costs
  about 0.16 µs a handler call.
- **The owner's changes:** a declared read (`read`) and a declared action (`act`), whose input is
  checked against the action's schema (an error names the field) and which the plugin refuses by
  throwing, with why; a node's stop cleared (`clearStop`), for the next start. No control raises a
  state at runtime: a node is enabled, disabled or cleared of its stop, and an edge sent for real,
  in the editor, applied with a restart.
- **The off switch,** instance-wide, unchanged: off, every running plugin hears `off` and stops what
  it does, the owner is told nothing; `on` lets each plugin take up what it did and say what. It is
  kept in the core's store (`/data/core/power.json`) across restarts, logged as `core.power`, and a
  plugin reads it with `ctx.off()`. The outbox does not refuse sends while off: a plugin's `off`
  stops it (D30).
- **The accounts and drift:** each connector instance with its account, its connection's status, and
  whom its login says it is (`as`, D120) (`accounts`), and each parser's drift (`drift`).
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
card ends with the way back to the owner's main card: the one its chat surface's connector names in
its config (`ChatSurface.home`, a `telegram-bot`'s `home`, bot-os.md D105), else the wiring's
(`CoreOptions.home`; the image's names none), else none.

**The HTTP control API** (`packages/core/src/control-server.ts`), one request handler
(`controlHandler`) that the entry point serves twice: on the container's loopback (`CONTROL_PORT`,
8081), and under `/api/` on the web UI's listener, only behind its login. `GET /status` (with
`boot`, `{ phase, failures }`: where the start is, and what failed to load, D143); `GET /instance`
(off or on, the release it runs as `version` and the commit its image was built from as `commit`,
absent when unknown, the process's uptime, Node's version and memory, the plugins and the accounts
counted by state); `GET /accounts`; `GET /accounts/<id>/surfaces?search=&limit=50&peers=1` (a
connector's surfaces, §4.5: `{ running, listed, surfaces, peers? }`, `running` false until it runs,
`listed` false for a connector that cannot list its chats, 409 with why when it cannot tell now,
such as not connected, 404 for a node that is not a connector; with `peers=1`, `peers`: for each
other running connector of its network, the chats it lists for the same query that this one does not
by any name, nor its own account's chat (a chat with itself), bot-os.md D96);
`GET /accounts/<id>/people?search=&limit=200` (the people its directory knows, §4.5, bot-os.md D167:
`{ running, people }`, most recently seen first, a search matching an id, or a part of a username or
a name; none from a connector that keeps no directory; 404 for a node that is not a connector);
`GET /drift`; `GET /events?limit=100&type=<prefix>&hours=24` (the event log's latest records, newest
first); `POST /off`, `/on`, `/kill`; `GET` and `POST /settings`; `GET /graph` and `GET /graph/view`
(§4.12); `POST /plugins/<id>/kill` and `POST /plugins/<id>/clear-stop` (409 with why when refused,
such as `actor is not stopped`); `GET /plugins/<id>/state/<name>?<field>=<value>` (a read, its input
the query's fields, §2); `GET /plugins/<id>/queue` (what waits in a connector's queue, D73:
`{ account, entries: [{ chat, text, command, queuedAt, waitingUntil, intervalS, nodes }], coalesced }`,
each node with its `origin` and its `cancel`, `{ on?, when?, test?, deadline? }`, and `coalesced`
the sends merged since the start, `{ count, pairs: [{ nodes: [a, b], count }] }`; 404 for a node
that is not a connector); `GET /plugins/<id>/view` (the state a node keeps, read only, D72:
`{ schema, state, updatedAt?, freshness?, pin? }`, its schema a JSON Schema, offered by the state
nodes and `owner-notice`, §4.16; 404 for a node that keeps none, 409 for one not running);
`GET /plugins/<id>/files` (a node's files, §4.2, D149, read from its instance's store whatever the
node's state: `{ files: [{ name, size, type, written }], used, limits: { file, total } }`; 404 for
no node) and `GET /plugins/<id>/files/<name>` (one file's bytes, its `content-type` its type,
`inline` for a raster image, PNG, JPEG, GIF or WebP, an `attachment` otherwise, always with
`content-security-policy: default-src 'none'; sandbox` and `nosniff`, so that a file a plugin wrote
never runs in the web UI's origin; 404 for no node or no such file, 400 for a name no file has);
`POST /plugins/<id>/actions/<name>`, the body the action's input (400 for an input refused by its
schema, 409 for the plugin's refusal; bytes in it, a `Media`'s, as `{ "$bytes": "<base64>" }`,
§4.18, within the body's limit, `MAX_UPLOAD`, 64 MiB of JSON, so about 48 MiB of bytes; every answer
of the control API writes bytes so too, bot-os.md D155); `GET /plugins/<id>/login` (a connector's
login, §4.5, bot-os.md D116: its `LoginState`) and `POST /plugins/<id>/login`,
`{ "action", "values"? }`, its answer, which says where it stands next, an answer it refused in its
`error` (404 for a node that offers no login, 409 for one not running or an action it does not offer
now, 400 for a body that is no answer); `GET /instances` (§2.2); `GET /graph/file`,
`POST /graph/check`, `PUT /graph/file`, `GET /graph/history`, `GET /graph/history/<id>`,
`POST /graph/history/<id>/rollback`, `POST /graph/rollback` and `POST /restart` (§2.3);
`GET /available`, `GET /modules`, `POST /modules`, `POST /modules/plan`, `POST /modules/link` (or
`POST /modules/github`), `POST /modules/updates`, `GET /modules/hosts`, `POST /modules/hosts`,
`DELETE /modules/hosts/<host>`, `POST /modules/<id>/rollback` and `DELETE /modules/<id>` (§7.4);
`GET /secrets`, the names of the Docker secrets provided, never their values, for a connector's
config to name (§4.9; the wiring leaves out `web_ui_password`, `bot_os_key` and `github_token`, the
shell's own, and the secrets named for a self-hosted Git server's token, §7.4). Ids and names in a
path may be URL-encoded. The control API is the owner's alone: no agent is ever given it (P11), so
no agent installs a module (P1).

**The health endpoint** (`packages/core/src/health.ts`), for a container's healthcheck, apart from
the control API: on `HEALTH_PORT` (every interface; off unless set, and the image sets 8080; an irc
connector's `healthPort` must be another), `GET /health` (or `HEAD`) answers 200 as soon as the
process serves, before any plugin has loaded (bot-os.md D143: a proxy that leaves unhealthy
containers out would take away the web UI, the only place the owner fixes what is wrong from), with
`{ ok, uptimeS, on, phase, connected, connectors: [{ id, plugin, status, counted }] }`: `ok` always
true, `on` the owner's switch, `phase` where the start is (`loading`, `starting`, `started`),
`connected` whether every counted connector is connected, each connector's `status` its connection's
(`connected`, `connecting`, `closed`), `needs login` for one waiting for its login, or, without one,
its node's (`failed`), and `counted` false for one the owner disabled or stopped, or waiting for its
login (D125). What it says of the graph and the connectors is detail, never a failure. It reveals no
config, account, chat or secret. The image's `HEALTHCHECK` probes it (every 30 s, after a start
period of 15 s).

**The web UI's login** (`packages/web/src/server/auth.ts`, bot-os.md D45) is meant for a trusted
network: behind it the owner installs modules and edits script nodes (§5), code that runs with the
bot's accounts, so a UI exposed to the internet needs another layer of authentication in front of
it, such as a reverse proxy with two-factor authentication. One password, the `web_ui_password`
secret; a session is a random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` over HTTPS)
that lasts 30 days from its login, the cookie's `Max-Age` to match. The sessions outlive a restart,
kept in the core's own store as `<data>/core/web-sessions.json`, written atomically:
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
state changed, and its commands' spacing (`spaced /inventory 300s`, D73), a commands edge's
`serves`, its chats (`in …`), `in private chats` and its senders (`from …`) (D109); nodes sorted by
id, edges by their text, so the same graph prints the same:

```text
nodes:
  quest (quest-parser), group Quest
  quest-player (player), instance quest-player-old, disabled, group Quest
    config.commands: [{"command":"/play"}]
  quest-ready (quest-ready), group Quest
  tg (telegram-user), account telegram:alice
    config.chats: ["@QuestBot"]
edges:
  quest-player.chat → tg.chat (chat-out): sends @QuestBot; commands /play; dry-run
  quest-ready.interface → quest-player.state (interface)
  quest.events → quest-ready.events (events)
  quest.interface → quest-ready.parser (interface)
  tg.chat → quest.chat (chat-in): reads @QuestBot
```

`lineDiff` gives two printouts' line diff, their longest common subsequence of lines kept and the
rest removed (`-`) or added (`+`), with no dependency (two texts of over 4 million line pairs give
every line removed, then every one added). `graphMermaid` draws a Mermaid flowchart, left to right,
a box per node (and a second, `<id> · out`, for a connector that chat-out edges reach, so that the
sends flow left to right too) and an arrow per edge, coloured by its port type; `writeGraphFile`
writes a graph to `<dir>/graph.json` atomically (the versions before it are the history's, §2.3).
`packages/core/tools/graph.ts [file] [--mermaid]` prints a graph file.

**The graph editor** (bot-os.md D47, D55) is the web UI's home page (`packages/web/src/ui/graph/`),
drawn with React Flow. It edits a draft of the saved graph (`GET /graph/file`), each node drawn from
its plugin as `GET /available` describes it (a node whose ports its config declares, as the last
check's `views` describe it, bot-os.md D74) (`describePlugin`: its description, kinds and account
and network, its input and output ports, the reads, actions and commands its `interface` declares,
and the JSON Schemas of its `config`, its `settings` and its actions' inputs and outputs and reads'
outputs, zod's `toJSONSchema`), with the node's own id, account (`nodeAccount`, D119) and config;
the port types' looks come from `GET /graph/view` (`PORT_TYPE_INFO`). It polls `GET /status`,
`GET /drift` and `GET /accounts` for each node's live state, drift and connection. An edge dragged
over a port that cannot take it (another type, network or namespace, or an interface missing a
member) is drawn refused and its drop refused, the status saying why (bot-os.md D101). Each change
of the draft is checked (`POST /graph/check`) and every problem shown where it is located (§2.3);
every warning too (bot-os.md D89), in amber, dashed, on its edge, its port and its node, listed in
their panels and in the review, and counted in the map's bar beside the problems (`N warnings`),
without keeping Apply from the draft. A node's config starts filled with its schema's defaults
(nested objects within), written to the draft as if typed; a node opened shows the defaults of the
fields its config leaves unset filled in, unmarked, and writes them with its first change, so that
merely opening a node changes nothing. A field's description is its help. A connector's fields that
every connector shares (`commandIntervalS`, `unansweredAt`, `unansweredAtBy`, `liveGraceS`) are
drawn last, folded under **Tuning** (bot-os.md D122); a connector that logs in says, above its
config while it is not logged in, to log in first, its chats being picked from those it sees once
connected. A node selected shows its forms, editable, a key of `configSecrets` as a choice of
`GET /secrets`, a list of strings or numbers as rows of plain fields (add, remove; an empty row
written nowhere), a record of plain values as rows of a key and a value (its type picked where the
schema allows several), **a player's commands as a checklist** (bot-os.md D137, D141, `configPlays`,
`PlaysField.tsx`): a row per command of the readiness state its `state` edge binds (its
`botCommands`, in its order), with a box (played or not; by default every command but an interactive
one, and the config left unset while they stay so), a sentence saying what the player will do with
it, composed from its mechanics and its policy (`plays.ts`: "a turn: played whenever the bot's rest
is over", "played if /play is cooling down; ends its cool-down", "activated by “A chest appears!”,
for 30 minutes: played while active", "played whenever ready, then cooling down for 24 hours",
"needs you to answer: not played by default"), and, when played, its policy to pick: whenever ready,
or if another command is cooling down; and its forms (bot-os.md D139, D140), one row per command
whatever its aliases: each of its names (its own, then its `aliases`) bare (`/play`, which every bot
in the group that declares it takes), then, where its edge sends to a group, each of them addressed
to its bot in the same order (`/play@QuestBot`, its state's `botUsername`), each with its tick, all
ticked by default (the entry's `forms` unset), the last one ticked kept, an unticked one never sent;
a single form is not listed, and in its bot's private chat no addressed form is (but one its entry
allows already). The sentence says how the form is chosen ("sent as the form that plays the most
ready turns at once"; "sent as /play@QuestBot, which only @QuestBot takes"; "sent as /play, which
every bot in the group that declares it takes"), with a note of what bare means in a group. Without
a state edge, or a state that declares none, the list is typed as JSON, as it can be under **Edit as
JSON**; and its chat-out edge follows it: each change of the draft sets that edge's `commands` to
the forms it may send, in order, which its panel shows rather than a list of its own. JSON only for
what these do not draw, and what each of its outputs carries, not its type, which the graph draws
(bot-os.md D71): an events output, the event types its plugin registers in that namespace (`types`
of its port in `GET /available`), each with its schema's description (§4.4) and its payload's JSON
Schema (`schema`); a chat-out output that declares its commands, each with its spacing (bot-os.md
D74); an interface output, its members' names, folded, opening on each one's signature (from its
schemas: `actions.sent({ chat: string, id?: string, t: number })`, `state.bot() → string`) and help;
another output, its port in words. An events edge, and the events input of the node it enters, show
what it carries (#3): each event type with its payload's fields by dotted path and type
(`outcome.item?: string`), from its schema (`types[].schema`), so that a reaction's `when` and
`send` paths are written against it, narrowed in the node's panel to the type its config names (the
reactor's `on`); the edge's rhombus says it in its title, a line per type. An edge selected, what it
carries: a chat-in edge its `reads` alone, a chat-out edge its `sends` and `commands`, with each
command's spacing for its queued sends (`minIntervalS`, empty for the connector's default, D73); a
commands edge (bot-os.md D109) the plugin's commands it answers as checkboxes (`serves`, every one
while all are ticked), its `chats` in the chat picker, a box for every private chat, who may ask
(`senders`: anyone, or a list with _the owner_) and its dry run; a plugin's panel lists, under its
commands, which connector serves each, in which chats by name and to whom, or that no edge does, and
its card's `commands` port says it in its title; a connector's panel, which plugins' commands it
serves. A commands edge drawn starts a dry run in its connector's owner's chat; dragged, a
connector's commands output binds a plugin's commands input and no other port (`bindProblem`). A
running connector's panel lists its queue. **A node's widget and page** (bot-os.md D112, §2, Widgets
and pages): a node whose plugin declares a widget shows it in a line on its card while it runs
(`WidgetLine`, `widget-text.ts`), from `GET /status`'s `widget`; one that declares a page has, in
its panel while it runs, **Open its page**, which leads to `#/node/<id>` (`NodePage.tsx`, in no
menu): the page's sections drawn in full (`WidgetSection`) from its reads, asked every five seconds.
**What the Admin page showed of a node is on it** (bot-os.md D111): a connector's panel says as whom
it runs, and its connection's state and step (`GET /accounts`), and its cards its connection's
state; its account is nothing to type, shown read-only under **Advanced** at the panel's foot
without the network its plugin implies (bot-os.md D119), with **Use its node's id** for a node whose
graph names another; a node's panel, what it costs (its `cost`, its share of the whole, the top
three marked), and while it runs its status (its `status`, not offered again among the reads), its
settings in force, each set at once (`POST /settings`), and its reads and actions, called from forms
made from their input schemas (`GET /plugins/<id>/state/<name>?<field>=<value>`,
`POST /plugins/<id>/actions/<name>`), each answer or refusal under it. The map's bar heads with the
instance's switches: on or off (`POST /off`, asking first, and `POST /on`) and **Kill all**
(`POST /kill`, asking first); the bottom bar says the instance's release, how long it has run and
its memory (`GET /instance`). **States and dry runs** (bot-os.md D64, §2.1): a node is drawn greyed
while disabled in the draft (its panel's **Enabled** switch), in red tones with a warning icon and
its reason while stopped, greyed with the node it needs while inactive (from `GET /status`); a
stopped node's panel says why, when and by what, with **Clear stop**. A node added starts disabled,
each of its required ports (an input, or a chat-out output, not optional) that exactly one port of
another node serves wired to it (bot-os.md D135; with none or several, left for the owner), and a
chat-out or a commands edge drawn, or so wired, starts a dry run: its rhombus hollow and its part
from the rhombus to the connector greyed and dashed, its panel's **Dry-run / Send for real** switch
setting `dryRun`. All of these are changes of the draft, listed in the review (a stop cleared as
"Stops cleared") and made by Apply. A connector is drawn as two cards (`cards.ts`, bot-os.md D60),
one node in the graph all the same (a service connector, with no chat, D148, as one card, as any
other node): its **in** card (`telegram-user · in`) at the left, with its chat-in output and its
other ports, and its **out** card (`telegram-user · out`) in a column of its own at the right, with
its chat-out input, where the senders' edges end. Each card is placed on its own; selecting either
selects the node and opens its panel (the other card shows itself selected too); removing it removes
both, after a confirmation that names them. The split lives in the editor's view alone: the graph
file holds one node. Each edge has a rhombus at its midpoint in its port type's colour
(`PortEdge.tsx`, React Flow's `EdgeLabelRenderer`), a button named after the edge
(`edge irc.chat → dice.channel`) that selects it and opens its panel, by a click or the keyboard.
Its review shows the diff and two actions: Apply, `PUT /graph/file`, then
`POST /plugins/<id>/clear-stop` for each stop cleared, then `POST /restart` (none if the core
refuses the graph, which the review says, nor if the saved graph is what runs already and no stop
was cleared), and Revert, the draft back to the saved graph; a banner offers Apply (`POST /restart`)
when the saved file differs from what runs (`differs`). After a restart the page waits on
`GET /session` for the new process (another `boot` id), and comes back to the page, still logged in.
One or several running nodes selected can be killed, each by `POST /plugins/<id>/kill`: stopped,
until their stops are cleared. Its **Text** tab shows the draft printed (the check's `text`),
read-only, with a copy button (`#/graph-text` opens it), and its **Costs** tab the nodes by cost.
The rollback is not the editor's: it is the **History** page's (`#/admin`, once Admin;
`#/graph-history` leads there too), the one thing that page keeps, having no node (bot-os.md D111),
which lists the versions newest first (time, summary, start, the last that ran marked "last good"),
shows one opened in two tabs, **Changes** (the review's diff from the saved graph to it) and **As
text** (the line diff), and rolls back to it after a confirmation repeating the diff, then restarts
as Apply does.

**A script node** (bot-os.md D76, D78, §5) has its ports in a form in its panel (its events inputs,
their namespace picked in a list of those offered or typed, a new one with none until picked, its
interface inputs, their plugin picked the same way, with their members picked from what it offers,
its chat-out outputs with their commands and spacing, its own events, its limits), each change a
change of the draft, drawn as the check's `views` say (a port renamed takes its edges with it, in
the same change: `movePort` in `draft.ts`; a port removed with its row's **Remove** takes its edges
away, in the same change and after a confirmation naming them: `removePort`, bot-os.md D84); it may
have several ports of a kind, each told apart by its name (D84); an edge dropped on its card from an
output it has no input for adds one (§2, bot-os.md D80). **Edit script** opens its code in Monaco
(`monaco-editor`, bundled by Vite in a chunk loaded only then), its TypeScript checked against
ES2022 and a `.d.ts` made for the node from its ports (`script/types.ts`: the members' and the event
types' JSON Schemas as TypeScript, each with its help), beside a panel listing its API; **Keep**
writes the code to the draft, refused while it does not parse. **Export as plugin** (bot-os.md D79)
shows and downloads the node as a module's plugin, `<id>.ts` (`script/export.ts`: a `definePlugin`
of the node's id, its manifest built from its ports and own events, its `create` the script as typed
on the script API given from the context, typed as the editor typed it) and a `module.json` for it.

**Swimlanes** (bot-os.md D69): a draft whose nodes name groups is drawn in lanes (`layout.ts`'s
`swimlanes`, `lanes.ts`, `LaneNode.tsx`). The columns stay global, as above, so a stage lines up
across lanes; each group is a horizontal band across them, a tinted rounded box with its name at its
top left, ordered by its first node in the graph's order, and the ungrouped nodes have an unlabelled
band last. The connectors (the nodes drawn as two cards) stay outside every band, their in cards
stacked in the leftmost column and their out cards in the rightmost; a connector's group is kept and
ignored, as its panel says. An ungrouped node with no input port (as its card draws them, those a
`when` gates while on, wired or not), that no edge feeds and whose every edge (one at least) reaches
a node in a lane, such as a person's `attention` shared by the players of several lanes (bot-os.md
D136), is no band's either: it is stacked under the in cards, in the leftmost column. A band is a
React Flow group node and its cards its children, kept inside it: a card cannot be dragged into
another lane. A node's panel sets its **Group**: none, one of the draft's, or **new group…**, named
and set; a change of the draft, applied with Apply. A lane's label zooms to fit it; resting on a
node dims what it does not reach, and resting on a lane's label dims everything outside it but the
edges its cards are at and the connectors those reach; the minimap tints each lane in its colour. A
lane's colour is the one of a fixed palette its name hashes to, or the next free one when a lane
before it has it, so that no two lanes share one while the palette's eight last. A draft with no
group is drawn with no lane.

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
  images?: Media[]; // shown before the prompt's text (bot-os.md D152, D153); width and height unsent
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
(`API error 429 …`) are failed answers, so that a plugin's loop survives them. **Images** (bot-os.md
D152): `images`, each a `Media` (§4.18, D153), go as base64 image blocks before the prompt's text,
in the user's turn; `mime` is `image/jpeg`, `image/png`, `image/gif` or `image/webp`, and the bytes
must be of that type (`mediaRefusal`). Checked before the call against the Messages API's limits, as
Anthropic's vision guide states them (`IMAGES_MAX`, `IMAGE_MAX_BASE64`, `REQUEST_MAX` in the code,
each the lowest that holds for every model): at most 100 images, each at most 10 MB base64-encoded
(about 7.5 MB of bytes), the request at most 128 MB; a request that breaks one is a failed answer
saying which (`image 2: image/bmp is not a type taken here (…)`,
`101 images, more than the 100 a request may carry`), and no call is made. An image too large in
pixels (over 8000 by 8000, or over a stricter limit, which its error states, in a request of more
than 20) the API refuses, its error the answer. The model pays for an image by its pixels: a plugin
resizes what it need not show whole. The owner may call it too, as the action `ask` of the control
API (without a schema, which JSON cannot carry). Every call, failed ones included, is logged by the
connector with its caller and its cost (§5, bot-os.md D117): a plugin need not count what it asks.

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
  maxAgeMs?: number; // how old an event may be and still be reacted to: no limit by default (D88)
  observe?: (trace: ReactionTrace) => void; // told each trace as it is recorded (#7)
}
```

- **On an event:** `on` is an event type (`quest.turn`) or a namespace on the bus, one its events
  inputs consume or its own (§4.4), heard from the nodes its edges bind. Its payload is the event as
  published, `{ type, t, instance, ...payload }`. An event played back (`playback: true`, D83) is
  skipped, and recorded, whatever its age, so that history is not acted on again (D88: news is told
  by its mark, not its age). With `maxAgeMs`, an event older than that is skipped and recorded too:
  a backstop for a plugin whose replays (at `ready`, say) are not marked.
- **On a message:** `on` is `{ port, chats, match }`: the messages read on the chat-in input `port`
  (`chat` by default), in `chats` (compared without case; every chat its edge reads without), whose
  text contains `match` (a string) or matches it (a `RegExp`). Messages played back and the
  account's own are never reacted to. Its payload is
  `{ chat, senderId?, senderUsername?, text, time, id?, replyTo?, document? }` (bot-os.md D167),
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
  `refused`, with why) or `skipped`; the same trace (`ReactionTrace`) is told to `observe`, if
  given, so that a plugin shows its reactions without reading the log back (the reactor's `status`).

`react` throws, as the context does, for a namespace no events input of the plugin consumes, an
event type nobody registers, and a message trigger on a chat-in input no edge binds. `valueAt`,
`matches` and `fill` (the dotted paths, `when` and the templates) are exported beside it.

### 4.16 The owner's notices

What needs the owner's attention is **raised as a notice** (bot-os.md D91,
`packages/core/src/notices.ts`), where it happens, so that a node can tell the owner without reading
the log: `{ kind, t, level, node?, text, detail? }`, its `text` one owner-facing line naming nodes
by id, its `detail` the fields a listener groups by. **The core raises** `failed` (a node failed: at
its start, at `ready`, at runtime through `ctx.fail`, such as a script killed as hung, D81, D85,
D87, or because a node it requires failed; `detail.reason`), `cascade` (each node a runtime stop
makes inactive, D65; `detail.reason`, `needs actor (stopped)`), `drift` (a parser past its
threshold, §4.7, about the parser; `detail.paused`, the actors stopped; or a message it could not
read, at most once an hour, `detail.unread`, `detail.more`), `coalesced` (a queued send that joined
another node's same text for the same chat, D73, about the node that joined; `detail`: `account`,
`chat`, `text`, `with`, the other nodes), `stalled` (a node the send-queue watchdog stopped, §4.6,
D93, about that node; `detail`: `account`, `chat`, `command`, `count`, `reason`), `unreachable` (a
send the network refused, §4.6, D95, about each node it went for but one that tells the owner
itself; its text names the chat by its title and says what to do; `detail`: `account`, `chat`,
`reason`), `warning` (each warning of the graph's check at the load, D89, D90, about its node if it
names one), `backoff` (a node the retry-loop guard holds back, its command refused for the same
reason three times in a row, §4.6, D98, about that node; `detail`: `account`, `chat`, `command`,
`reason`, `count`; told by `owner-notice` among its `other` kinds), `unanswered` (a command no
answer came for in its window, once until that node's command is answered in that chat, §4.6, D107,
about that node; `detail`: `account`, `chat`, `command`, `withinS`; told among the `other` kinds),
`graph-refused` (the saved graph refused at the load, so that no node runs, D94; `detail.problems`;
no node hears it, the events panel shows it), `load-failed` (a package or module that failed to
load, before the load, D143; `detail`: `source`, `module`, `error`; told among the `other` kinds),
`uncaught` (an error nothing caught, the process going on, D143; `detail`: `error`, `from`, the
module or package its stack names; told among the `other` kinds). **A plugin raises** its own
through `ctx.notice(kind, text, detail?)`, about its node: a state node raises `refused` for each
event it refuses (D72; `detail`: `event`, `at`, `reason`); and `told` through
`ctx.notify(text, buttons?)` (§4.8, D94; `detail.buttons`, which `buttonsOf(notice)` reads). A kind
is lower-case words and dashes; raising one sends nothing.

**Every notice has a level** (bot-os.md D171), lowest first: `debug` (for a look while diagnosing),
`info` (a line in the owner's daily digest), `warning` (a message soon), `error` (a message now).
The shell's kinds have theirs (`DEFAULT_LEVELS`): `error` for `failed`, `stalled`, `cascade`,
`uncaught`, `load-failed` and `graph-refused`; `warning` for `drift`, `unreachable`, `backoff`,
`unanswered`, `refused` and `warning`; `debug` for `coalesced`. A plugin gives its own with
`ctx.notice(kind, text, detail?, { level })` and `ctx.notify(text, buttons?, { level })`; a notice
it raises without one is its kind's, and a plugin's own kind or a `told` message is a `warning`.
`levelOf(notice)` reads it, `atLeast(level, threshold)` compares two. Levels decide only what a node
that tells the owner sends: every notice is recorded and listed whatever its level.

```ts
ctx.notice('quota', 'quest-bot used 80% of its quota', { used: 0.8 }, { level: 'info' });
ctx.notify('A new picture waits for your review', buttons); // a warning: it asks the owner to act
```

**A plugin whose manifest declares `notices: true`** gets `ctx.notices`: `subscribe(handler)` hears
the notices raised since the instance started first (the newest `NOTICES_KEPT`, 200), so that the
load's warnings and a node failed at its start reach a node started after them, then each as it is
raised, while its node is up; the time its handler takes is its node's (D77). The notices live in
memory (`core.notices()` lists them), and **each is recorded** as it is raised (`core.notice`:
`kind`, `level`, `node?`, `text`, `detail?`), so that the editor's events panel shows every notice
whether a node tells it or not (D94), beside the records it was raised with (`core.plugin`,
`core.drift`, `core.queue`, `<id>.refused`).

`owner-notice` (§5) tells a kind it does not name as `other`, at once or in its digest by level. Its
view (`GET /plugins/<id>/view`, D72) shows its levels (at once, in the digest, the next digest), the
overrides per node, the recent notices of every level (the latest 100, newest first, each with what
became of it: `sent`, `digest` or `dropped`), the notices waiting by kind with when each is due,
when each kind was last told, whether the start notice is waiting, sent or off, the digest's waiting
count and times, the graph's warnings at this start, and its last message the network refused to
each chat (`notSent`: when, the account, the chat, why; D95, per chat since D97), pinned first; its
card's line says the last (`not sent to …: …`, or how many chats) and counts the notices waiting.

### 4.17 The owner's summary

What happened over a window of time, in a few lines, for a node that tells the owner on a cadence
(`owner-notice`, §5), and what the instance runs as it starts (bot-os.md D92,
`packages/core/src/summary.ts`). **A plugin whose manifest declares `summary: true`** gets
`ctx.summary`:

```ts
interface SummaryHandle {
  // Its lines for a window: what it did from `since` (included) to `until` (excluded), in ms;
  // none ([] or undefined) when it did nothing. A line is a text (info) or { text, level }
  // (bot-os.md D171). Returns the way to stop.
  contribute(
    lines: (window: {
      since: number;
      until: number;
    }) => readonly (string | { text: string; level?: Level })[] | undefined
  ): () => void;
  // Every contributor's lines for a window, the core's first, then the nodes' in load order;
  // only those with something to say: { title, node?, lines: { text, level }[] }.
  collect(window: SummaryWindow): SummarySection[];
  // The release and commit (CoreOptions.build, as GET /instance says), when the core started,
  // and each node with its plugin, state and why ({ id, plugin, state, reason? }), in load order.
  instance(): InstanceSummary;
}
```

**A contributor** says what it did in the window in short owner-facing lines, naming nodes by id,
without its own id (the summary titles its lines with it): `40 events applied, 2 refused`. It counts
as things happen with a **`Tally`** (`new Tally(ctx.clock)`; `add(key, n?)`; `count(key, window)`;
`counts(window)`, each key with its count, in the order first added), which keeps 7 days back
(`TALLY_KEPT_MS`) and at most `TALLY_MAX` (100 000) times per key; `counted(n, 'event')` words
`1 event`, `2 events`. Its function is called when a summary is made; one that throws is logged and
left out. **Each line has a level** (D171): a bare text is `info`, a line for the owner's daily
digest (`12 items bought`); a count of plain activity is `debug` (`{ text, level: 'debug' }`, or
`activity(lines)` for a list), shown only for a node the owner asked to see in detail (`/verbose`,
§5); a line that matters more says so. The counts live in memory: a window reaches back to the start
at most. A game's module adds its own lines the same way (its turns, what it bought):

```ts
manifest: { /* … */ summary: true },
create: (ctx) => {
  const bought = new Tally(ctx.clock);
  ctx.summary?.contribute((w) => {
    const n = bought.count('item', w);
    return n === 0 ? [] : [`${counted(n, 'item')} bought`];
  });
  // … bought.add('item') at each purchase
}
```

**The core's own lines** come first: `Sends`, each node's sends in the window by outcome (`sent`,
`dry-run`, `refused`, `failed`, and a queued send `cancelled` or `expired`, D73; a coalesced send
counts for each node it went for), but those of the nodes that tell the owner (`notices: true`),
whose sends are the summaries and notices themselves; and `Notices`, the notices raised (§4.16),
counted by kind (`1 cascade, 1 stalled`), both `debug`. **The shell's plugins contribute**, at
`debug`, as activity: a state node its events heard live, `applied` and `refused` (D72); a turn
parser the answers to turns it read live, by their outcome's kind (`unknown` for one it could not
read); an `attention` node its sittings (those that followed the owner's play counted apart), and
those the owner played by hand; a `player` its commands, `sent` and `in a dry run` by command, and
`failed`. `core.summary(window)` gives what `collect` gives, for tests.

### 4.18 Media

Bytes and their media type (bot-os.md D153, `packages/core/src/media.ts`): the one shape every
plugin that passes a picture uses, and later a video, a sound or a document, so that the same bytes
go from a connector's `photo` (§4.5) to a plugin's state, its outbox (§4.6) and `ask` (§4.13) as
they are, wherever they came from.

```ts
interface Media {
  data: Uint8Array;
  mime: string; // `type/subtype`, lower case: `image/png`
  width?: number; // in pixels, where whoever made it knows
  height?: number;
}
type MediaKind = 'image' | 'video' | 'audio' | 'document'; // MEDIA_KINDS
type MediaResult = { ok: true; media: Media | null } | { ok: false; error: string };
interface MediaLimits {
  kinds?: readonly MediaKind[];
  mimes?: readonly string[];
  maxBytes?: number;
}
```

- **`mediaSchema`** and **`mediaResultSchema`**: their zod schemas, for a manifest's action that
  takes or answers media (`bytesSchema`, bytes alone).
- **`mediaKind(mime)`**: `image/*`, `video/*` and `audio/*` are theirs; any other type a `document`.
- **`sniffMime(data)`**: the type the first bytes say, of `SNIFFED_MIMES` (JPEG, PNG, GIF, WebP,
  PDF); undefined for any other.
- **`mediaMismatch(media)`**: why the bytes are not the type they say, where it can be told (bytes
  `sniffMime` reads, or a type it reads); undefined when they are, or when it cannot tell.
- **`mediaRefusal(value, limits?)`**: why a value cannot go where `limits` say: no `Media` (its
  schema), a kind or a type not taken, bytes of another type (`mediaMismatch`), more bytes than
  `maxBytes`; undefined when it can. The outbox's photos (`photoRefusal`, `PHOTO_MIMES`) and `ask`'s
  images check with it.
- **`mediaOfFile(files, name)`**: a file of the plugin's store (§4.2) as a `Media`, its type the one
  kept with it; undefined when there is none.
- **`mediaField(limits?)`** (bot-os.md D155): a `Media` within `limits`, as a schema: refused with
  `mediaRefusal`'s why past them, its JSON Schema saying `media: { kinds?, mimes?, maxBytes? }`.
  `mediaSchema`'s says `media: {}`. The editor's forms draw a property whose schema says `media` as
  a file's picker (choose, preview, replace, remove, refused past its limits before it is sent),
  wherever it is: an action's input, a config (whose media would sit in the graph file as base64: a
  picture belongs in a collection, §5).
- **Bytes as JSON** (D155): `{ "$bytes": "<base64>" }`, the one key (`BYTES_KEY`; `isJsonBytes`).
  `bytesSchema`, and so `mediaSchema`, reads that form as bytes, so that the owner's panel sends a
  file in an action's input (§4.11); `bytesJson`, a replacer for `JSON.stringify`, writes bytes so,
  as every answer of the control API does: `JSON.stringify(value, bytesJson)`.

**An action that answers media** answers a `MediaResult`: the media, `null` for none, or why not,
never thrown; its manifest's `output` is `mediaResultSchema`. A plugin that keeps pictures answers
them as a connector answers a message's photo, and its reader cannot tell which it asks:

```ts
// quest-state: the picture of each room, fetched once through telegram-user's photo
interface: { actions: { room: { help: 'A room’s picture', input: z.object({ room: z.string() }), output: mediaResultSchema } } },
// …
room: ({ room }) => {
  const media = mediaOfFile(ctx.store.files, `room-${room}`);
  return { ok: true, media: media ?? null };
},
// postcard: shows it to ask, then sends it
const r = await ctx.use<{ actions: { room: (q: { room: string }) => Promise<MediaResult> } }>('quest').actions.room({ room: '7' });
if (r.ok && r.media !== null) {
  await llm.actions.ask({ prompt: 'Describe this room in one line.', images: [r.media] });
  await ctx.outbox('chat').deliver('#lobby', { photo: r.media, caption: 'Room 7' });
}
```

Bytes only: passing a reference to media (a plugin's file, by its hash) between nodes in place of
its bytes is for later.

## 5. The shell's own plugins

| Plugin          | Kinds        | Package                       | What it is                                                                                                                                                                 |
| --------------- | ------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `irc`           | connector    | `@megabottron1999/connectors` | An IRC account through a ZNC bouncer, with its flood limits and a health endpoint                                                                                          |
| `telegram-bot`  | connector    | `@megabottron1999/connectors` | A Telegram bot (grammY), and the owner's chat surface                                                                                                                      |
| `telegram-user` | connector    | `@megabottron1999/connectors` | A Telegram user account (GramJS), reading and sending in the chats it monitors                                                                                             |
| `anthropic`     | connector    | `@megabottron1999/connectors` | The Claude API: `ask`, with structured output (§4.13)                                                                                                                      |
| (service)       | connector    | `@megabottron1999/connectors` | `ServiceConnector`: the connector of a plugin that holds secrets for an API client, no chat                                                                                |
| (turn parsers)  | parser       | `@megabottron1999/turns`      | `turnParserPlugin`: a parser of one game bot's answers to turns, from a grammar a game gives                                                                               |
| `attention`     | actor        | `@megabottron1999/turns`      | A simulated person: when they sit down to play and how fast they act, one node per person, for the players bound to it                                                     |
| `player`        | actor        | `@megabottron1999/turns`      | One game bot's commands, each when ready, in its person's sittings, run as one node per bot                                                                                |
| `reactor`       | actor        | `@megabottron1999/turns`      | One reaction (§4.15) from its config: a command sent when an event is heard or a message matches                                                                           |
| `script`        | actor, stats | `@megabottron1999/turns`      | TypeScript typed in the editor, on the ports its config declares, in a worker thread of its own                                                                            |
| `collection`    | stats        | `@megabottron1999/turns`      | Records of a schema its config gives, media included, edited in its panel and read through its interface (D155)                                                            |
| `view`          | view         | `@megabottron1999/turns`      | A page of the owner's own at `/v/<path>/`, its sections from its config, each read from a node wired to its inputs (D170)                                                  |
| `owner-notice`  | stats        | `@megabottron1999/turns`      | Tells the owner what needs attention (§4.16) at once or in a daily digest by level (§4.17), and a notice at each start, through a chat-out edge                            |
| (states)        | stats        | `@megabottron1999/turns`      | `statePlugin`: a game's player state, kept from its parsers' events, from a spec a game gives, with its commands' readiness; `readinessPlugin`: the readiness alone (D141) |

- **`irc`** (`packages/connectors/src/plugins/irc.ts`, on the IRC client of
  `packages/connectors/src/transport/irc-client.ts`): one IRC account through ZNC, its configuration
  the ZNC login (`host`, `port`, `tls`, `zncUser`, `zncNetwork`), the `nick`, the `channel` and the
  rate limiter (`minIntervalS`, `maxPerHour`), its queue's default interval between two sends of a
  command (`commandIntervalS`, D73) and its watchdog's threshold (`unansweredAt`, `unansweredAtBy`,
  §4.6, D93); its password is the `znc_password` secret. It opens one connection however often it is
  started (networks' clone limits). It logs each line of the channel, played back or live, as
  `irc.line`, and each step of the connection as `irc.status`. It formats nothing: a Markdown text
  goes as written, an HTML one as the text it shows (`htmlToPlain`, D164). With `healthPort` it
  serves `GET /health`: 200 while it is in the channel, 503 when not; kept for the configs that set
  it, though the shell's own health endpoint (§4.11) covers every connector.
- **`telegram-bot`** (`packages/connectors/src/plugins/telegram-bot.ts`, on grammY in
  `packages/connectors/src/transport/telegram-bot.ts`): a bot, made at `create` (with auto-retry)
  from the token pasted in its node's panel (§4.5, D116: `bot-login.ts`, checked with `getMe`, kept
  in its store, no Docker secret, D118), else needing a login, connected and polling at `start` with
  retries (a backoff capped at ten minutes). Its status is `connecting` until `getMe` answers,
  `connected` while it polls; its own name is the bot's username. It hears every message Telegram
  delivers the bot and sends through the account's outbox (`deliver`, to a chat id or an
  `@username`; a 429 longer than auto-retry waits out becomes `FloodWait`); a photo with `sendPhoto`
  (D150: its `caption`, Markdown as Telegram HTML and HTML as written (D164), plain if Telegram
  cannot parse it (HTML as the text it shows), `reply_parameters` sent all the same if the message
  answered is gone), answering the `file_id` of its largest size; its interface's action `photo`
  (§4.5, D151) fetches the photo of a message it heard or sent, the latest 1000 kept by their
  `file_id` in its store (`photos`), any other refused with why (the Bot API fetches no message by
  its id); `commandIntervalS` in its config is its queue's default interval between two sends of a
  command (D73), and `unansweredAt`, `unansweredAtBy` its watchdog's threshold (§4.6, D93). With
  `chats` in its config (picked among its chats, D96) it monitors only those for the plugins; its
  surfaces are the chats it has seen and its owner (§4.5), and the updates Telegram kept while it
  was down come marked `missed` (and `playback` once older than its config's `liveGraceS`, 120 s by
  default, D83). Configured with its owner (`owner`, in its node's config, picked among its chats
  and kept by id, D96), it is the instance's chat surface, the owner's interactive control (§4.8,
  bot-os.md D56) (`telegram-surface.ts`): the switchboard on its bot (`telegram-switchboard.ts`, on
  grammy-switchboard), the owner's controls answered in the owner's chat, and the plugins' commands
  that the commands edges from its `commands` output serve (D109), each answered only in the chats
  its edge names (a group, the owner's chat, every private chat with `privateChats`) and listed in
  those chats' menus alone (the switchboard's, the owner's chat; every private chat's; Telegram's
  `chat` scope for each other chat, a group's included, but a group its gate refuses)
  (`telegram-commands.ts`), the menus kept registered, a refused one retried and one set again when
  the bot joins its chat; in any group, one answer per user every 2 s and one a second (D160), each
  group its own throttles, and an answer deleted when its handler asks (`deleteInGroupAfterMs`).
  Without an `owner` it is no surface, and its commands edges answer nothing. It tells the owner
  nothing on its own (D94): a send with buttons (`SendOptions.buttons`, an `owner-notice` telling a
  `told` notice) to the owner's chat goes through the surface's switchboard, whose taps run the
  owner's commands as a card's do; to any other chat, the text alone. Nothing hands its bot out
  (P9). Its gate (D128, `telegram-gate.ts`), each list picked among its chats: `groups`, `any` group
  it is added to (default; `blockGroups` the ones it ignores even so) or `only` the groups in
  `onlyGroups`; `people`, `anyone` (default; `blockPeople`, never its owner) or `only` the people
  and bots in `onlyPeople`, its owner always allowed, listed or not; a list of the choice not made
  is refused by its check. In a group it does not work in, nothing goes further: no message reaches
  a reader, no command an edge or its surface. A command (or a tap on a button) of a person it does
  not work for, in any chat, goes no further either, what they say still reaching the readers. Each
  command dropped is recorded (`telegram-bot.denied`: `chat`, `chatTitle`, `sender`, `by` `group` or
  `person`, `command`, `replied`; on the Events page) and counted in its node's view and on its
  card; silent unless `denyReply` sets one line to answer a person with, at most once in 10 minutes
  per person. Its `home` (D105) is the command of the owner's main card, as typed (`/menu`,
  `/menu main`) or short (`menu`, `menu:main`), at most 64 bytes: the core's own cards on its
  surface (`/plugins`, `/settings`) end with a button that runs it, labelled `homeLabel` (`🏠 Home`
  by default); unset, they have none.
- **`telegram-user`** (`packages/connectors/src/plugins/telegram-user.ts`, on GramJS in
  `packages/connectors/src/transport/telegram-user.ts`): the owner's own account, from a login in
  its node's panel (§4.5, D116: `user-login.ts`, the API pair once, then a QR code or the phone,
  whose code step offers to resend the code, D126; the session kept in its store, its logout ending
  it on Telegram too; no Docker secret, D118), else needing a login. It monitors the chats of its
  configuration (`chats`, picked among its chats, D96: a group by its id, a private chat by the
  other's `@username`, or their id when they have none), or every chat of the account when `chats`
  is unset (a new connection), each edge reading a subset (§2.1); it lists its dialogs, monitored or
  not, as its surfaces (§4.5: those active this week by default, any by a search), and catches up at
  each connection on what its readers' chats said while it was down, each message once (§4.5, D62,
  D66), marked `missed`, and `playback` too once older than its config's `liveGraceS` (120 s by
  default, from the message's time to its delivery, D83): a message missed by a quick restart is
  news. It starts without waiting, retries every minute, and raises a `told` notice of the first
  failure (`ctx.notify`, §4.8); a message carries its id, the one it replies to, and `own` for the
  owner's own from any device. It sends only through the account's outbox (`deliver`, with the
  message's id; a photo with GramJS's `sendFile`, D150, its bytes uploaded as a photo, named by its
  type, its caption Markdown as Telegram HTML, HTML as written (D164) or plain, in reply to
  `replyTo`; a text in HTML parsed as HTML; the photo's id it answers is
  `<id>:<access hash>:<file reference>`, by which it sends it again, a Bot API `file_id` refused
  with why; Telegram's file reference may expire, and a send by it then fails
  `FILE_REFERENCE_EXPIRED`, the bytes to send again), its queue's default interval between two sends
  of a command its config's `commandIntervalS` (D73), its watchdog's threshold `unansweredAt` and
  `unansweredAtBy` (§4.6, D93); GramJS's flood waits become `FloodWait`. Its interface's action
  `photo` (§4.5, D151) fetches a message by its id in a chat it monitors and downloads its photo's
  largest size.
- **`ServiceConnector`** (`packages/connectors/src/plugins/service.ts`): for a connector plugin that
  holds an account's secrets and offers what it makes from them through its declared interface, but
  has no chat: it reads and sends nothing. Its manifest says `chat: false` (§2.1, bot-os.md D148),
  so its node has no chat ports, its `interface` alone, one card in the editor. The `anthropic`
  connector is one.
- **`anthropic`** (`packages/connectors/src/plugins/anthropic.ts`, on the Anthropic SDK): the Claude
  API's account (`anthropic:api`, or the name it is given), made from its `anthropic_api_key` secret
  at `create`, a `ServiceConnector`. Its configuration holds the defaults of `ask` (§4.13): `model`
  (`claude-opus-5-5`), `maxTokens` (16000), `effort` (unset: the model's own) and `cacheTtl`. It
  offers `ask` as its interface's action, for the plugins an edge binds to it. A system prompt is
  sent with a cache breakpoint, so calls that share one pay for it once; `cacheTtl` says how long it
  stays cached: `5m` (the API's default) or `1h`, for calls more than five minutes apart (writing it
  costs more, reading it the same), and a request may ask its own. **A model connector**
  (`model: true`, §4.5, bot-os.md D117): it logs each call, whoever asked, as an `anthropic.call`
  record,
  `{ node, model, ok, error?, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, usd, images?, imageBytes? }`
  (`node` the calling node, `(owner)` for the panel; `images` and `imageBytes`, the count and the
  bytes of the images it showed, D152; never the prompt, the images or the answer), its cost from
  its price table, `PRICES` in its code (not its config, so that a release updates it): USD per
  million tokens by model id, `{ input, output, cacheWrite5m, cacheWrite1h, cacheRead, over? }`
  (`over`, `{ promptTokens, …the same }`, the prices of a prompt longer than that), a dated snapshot
  (`<id>-20251001`) priced as its id, the cache writes priced by the call's `cacheTtl`. The table is
  Anthropic's published pricing for its own API on 2026-11-03 (`PRICES_AS_OF`): Claude Fable 5.2 and
  Mythos 5.2 at 8/40 (input/output; cache reads 0.20), Fable 5.1 and Mythos 5.1 at 10/50 (0.25),
  Fable 5 and Mythos 5 at 10/50 (1), Opus 5.5 at 4/20 (0.20), Opus 5, 4.8, 4.7 and 4.6 at 5/25
  (0.50), Sonnet 5.5 at 2/10 (0.10), Sonnet 5 at 2/10 (0.20), Sonnet 4.6 at 3/15 (0.30), Haiku 5.5
  at 0.10/0.50 (0.01), and 0.50/2.50 for a prompt over 100K tokens, and Haiku 4.5 at 1/5 (0.10); a
  5-minute cache write at 1.25 times the input, an hour's at twice. The cache reads of Opus 5 and
  4.x, Sonnet 5 and 4.6, and both Haiku are not published per model and are derived from the
  published rule (about a tenth of the input), as the code marks them. A config saved when the
  prices were its (`prices`) still loads: its schema drops a key it does not know. A model it has no
  price for is logged with `usd: null`, counted as unpriced, and warned of once a run
  (`no price for the model …`). Its last 24 hours are kept in its store (`spend`, by the hour, by
  node and model; the hours that overlap the last 24), so a restart keeps them: its `status` read
  gives `{ calls, cost, usd, unpriced, since, byNode, byModel }` and the four token counts (`cost`
  in words, `$0.42 + 2 unpriced`), its widget shows `Last 24 h — Cost: $0.42 · Calls: 14` on its
  card, its panel's Status breaks it down by calling node, its page **Spend** has a table by node
  and one by model, and its `Instance.cost` gives the costs its `spend` (§4.11).
- **`turnParserPlugin`** (`packages/turns/src/turn-parser.ts`): one parser plugin per game bot, each
  made from its bot's grammar (`read`), which knows the game. **It turns its bot's messages into
  events, and nothing else** (bot-os.md D141): when a command may be played again is a state's
  (`statePlugin`'s readiness, below). Each reads, on the owner's account (`telegram-user`), the
  private chat with its bot and, when its edge also reads it, the game's group: a `chat-in` input
  only, with no way to send; its default edge reads from its bot and the owner
  (`senders: ["@<bot>", "me"]`). Its game gives it a spec (`TurnParserSpec`): its `id`, its
  `description`, its grammar (`read`, given each of its bot's messages as a `BotMessage`: `text`,
  `private`, `answers`, `command`, `replies`, `self` and `selfId` (the owner's username and id, the
  id the key to the owner by, bot-os.md D167), and `document`, the file it carries with its text
  when it has one, such as the bot's export of the player's state, beside the caption in `text`,
  D82), and its bot's **vocabulary** (`BotVocabulary`, which its readiness state is given too): its
  `bot`; its `turnCommands`, the bot's turn by first word, its name first and its aliases after
  (`["/play"]`, or `["/play", "/quest"]`: one turn, bot-os.md D140), a fact of the game, so it has
  no config (bot-os.md D70); and its other commands (`commands`, bot-os.md D132), each with its
  `aliases` (D140) and, for one the bot announces, `announcedBy`, a regular expression on the text
  of a message of the bot's (in private, or answering the owner) that announces it unlocked:
  `{ "/daily": {}, "/chest": { announcedBy: "A chest appears!" }, "/boost": { aliases: ["/b"] } }`.
  **One command, its aliases** (D140): any of a command's names, bare or addressed to its bot, sent
  or heard, is that command, named by its name in every event and in `BotMessage.command`; a name or
  an alias names one command only, in any case (`vocabularyProblem`, the spec refused otherwise).
  **What it publishes:** `<id>.sent` (`{ chat, command, byHand, id?, playback? }`), each send of one
  of its commands from the owner's account it counts: by hand from any device, or a player's, told
  through its action `sent` (since the account never sees its own sends come back); `<id>.turn`
  (`{ chat, outcome, retryAt?, unlocks?, effects?, answer?, playback? }`), what it reads of a
  message that answers a turn, or reads as one in private; `<id>.answer` (the same, with its
  `command`), what it reads of the answer to another command (declared only for a spec with other
  commands); and `<id>.reply` (`{ chat, command?, answer?, unlocks?, playback? }`), a message its
  grammar leaves that answers a send or announces an unlock. `retryAt` is the wait the message
  states (the bot's rest after a turn, a "too soon"'s wait), `unlocks` the commands it announces
  (`announcedBy`, or a reading's `unlocks`), `effects` what it announces of other commands' holds (a
  reading's `effects`: `clear`, or `shortenMin`), each by its command's name; `answer`
  (`{ length }`, in characters) says that it answers a send; `playback: true` marks a message played
  back (D83). Which of its bot's messages answer a send: a reply to it or, in the private chat, the
  first message within two minutes of it (a chat is private as its connector says,
  `Inbound.private`, so that one configured by id counts; from a connector that does not say, a chat
  named by `@username`). A message it claims and cannot read goes to drift (§4.7) and is published
  with an `unknown` outcome. **Its answers** (§4.6, Command answers, bot-os.md D98): its `<id>.turn`
  answers its turn's every form, `refused` with `cooldown` for a "too soon" (`kind: nothing`,
  `reason: cooldown`), `ok` (`rest`) for any other outcome read, not an `unknown` one, within two
  minutes; its `<id>.answer` each of its other commands the same way (`when: { command }`), so that
  a send queued by any node settles with the bot's answer. Its answers name each command by each of
  its names, bare and addressed to its bot (`/play`, `/quest`, `/play@QuestBot`, `/quest@QuestBot`),
  so that a send of any form is paired. They hold nothing back in the outbox (bot-os.md D142): the
  wait a message states (`retryAt`) and the effects it announces are its event's, which a readiness
  state reduces. **A send it is told of** (its action `sent`, bot-os.md D139, D140, through a
  player's readiness state) is a player's, or another player's of the same account, as sent
  (`command`: `/play`, or `/play@QuestBot`; a turn when none): it counts it only if it reaches its
  bot, bare or addressed to it (`commandOf`; addressed to another bot, not), in its bot's private
  chat or a chat its edge reads (`ConnectorHandle.reads()`; another bot's private chat never), so
  that a bare turn one player sent in a group, which every bot there that sees it takes, is each
  parser's turn, matched to its bot's reply. That action is its whole interface: it offers no read.
  It resumes from what it parsed (D62): the owner's recent sends, to pair a late answer with, and
  the waits it told the outbox, kept in its store (`parsed`) as they change and read back at its
  start; it never re-reads the chat, and reads missed messages as any other. A node saved while it
  had a config (`"config": { "commands": [...] }`) still loads and runs: a plugin with no config
  schema ignores its node's config. It adds to the owner's summary the answers to turns it read
  live, by their outcome's kind (§4.17, D92). The tests play a made-up @QuestBot
  (`packages/turns/test/quest.ts`).
- **`attention`** (`packages/turns/src/attention.ts`, bot-os.md D134): a simulated person, one node
  per person (or account), for the players its `attention` output binds (§2.1, D133: any number; the
  players of one person share their sittings, so gameplay comes in bursts). **Two behaviours**, each
  on its own, at the top of its configuration (bot-os.md D138): `scheduled` (default `true`), its
  own sittings, planned from the schedule below; and `followsMyPlay` (default `false`), a sitting
  for the owner's own play (below). Both may be on; both off is allowed, and the check warns that it
  never plays (`warns`, §2). Its configuration then holds once what each turn actor held on its own,
  the schedule, which applies only while `scheduled` (the editor hides it otherwise, and checks it
  only then): when the person comes back, `minGapMin` and `maxGapMin` between two sittings (17 and
  20 by default, 1 at least), `skipChance` (a sitting forgotten), the nights, `wake` and `bedtime`
  on the clock of `timeZone` with their `jitterMin` and `wakeDelayMaxMin` (`DEFAULT_SCHEDULE` of
  `packages/turns/src/sittings.ts`, its nights drawn from their date and the node's id, so that a
  restart keeps them), `seed`; and `reaction`, how fast they act within a sitting (`minS` to `maxS`
  seconds, plus `perCharMs` per character of the answer read, `readMaxS` at most (4 by default,
  D146: a long story is skimmed), and with `longChance` up to `longMaxS` more). A player asks it
  with `react({ length?, after? })`: the moment the person acts, from now, or from `after` if later
  (a moment awaited, D146), each reservation after the last. It starts each **sitting** at its
  durable timer `sitting` (dropped if it came due more than 10 minutes before a start), planned a
  gap after the last (kept in its store, `state`), for every player at once. **The owner's own play
  counts as a sitting** by the real person: when a sitting is due, and once every node has started,
  it asks each player for the owner's latest play by hand its parser read (any command, from any
  device: `ready`'s sends marked `byHand`); one newer than its last sitting is kept as its last
  (`seen`), and the next simulated sitting is planned a gap after it, so the bot plays only once the
  owner has been away longer than their pace. A sitting due while the person is still busy (a
  reaction reserved past now) waits a gap after that (`busy`). Not `scheduled`, it plans none, and
  drops one kept from before. **Following the owner's play** (`followsMyPlay`, D138): `listen`, the
  chats it listens to (picked in the editor among the chats of the account its `listen` edge reads,
  a `configChats` key written on that edge's `reads`, D96, D97), and `followDelayS` (3 by default),
  both shown only while it follows. Its `listen` input, a chat-in of network `telegram` (as a
  player's chat-out), so from the owner's own account (a `telegram-user`; the check refuses a
  `telegram-bot`'s edge, whose account never hears a message of the owner's own), is there only
  while `followsMyPlay` is on (`when`, §2.1, a key set to `false` setting nothing), and then
  required; the config refuses `followsMyPlay` without `listen`, and `listen` without it. **Any
  message of the owner's own** (`own`, or sent by the account's id or name, D167), live, in a chat
  it listens to, command or not, starts a sitting `followDelayS` seconds later (the timer `follow`),
  so that the owner's own typing wins a race; one more message while it is pending starts no other.
  A message during a sitting (a player still in it, `AttentionPlayer.inSitting`) starts none either:
  its players in it look again (`again`). A sitting that follows the owner is marked `follow` and
  counts as the owner's own sitting (`byHand` in its status), so while `scheduled` the next planned
  one comes a full gap after it. A player asks it, through `ctx.attention`, for the person's next
  reaction (`AttentionHandle.react({ length? })`), which it reserves, so that the players of one
  person act one after the other. It plays while its node runs and the instance is on; its safety
  stop (`kill`) stops its node, and its players are inactive with it. Its read `status` gives its
  behaviours (`mode`: `scheduled`, `follows your play`, both, or `never plays`), its players, its
  last sitting (and whether by hand) and its next (a time; not scheduled, `follows your play`, or
  `never: …`), which its node's widget (its next sitting) and page (**Sittings**) show (D112). Each
  step is published as `attention.step` (`planned`, `sitting`, `seen`, `busy`, `heard`, `stopped`);
  its sittings (those that followed the owner counted apart: `3 sittings (1 following you)`), and
  those by hand, go in the owner's summary (§4.17).
- **`player`** (`packages/turns/src/player.ts`, bot-os.md D134): one plugin run as one node per game
  bot (P3, P17), in place of the turn actor, each with its own id, configuration, store, timer and
  state. Its ports: `chat`, a chat-out output on `telegram`, which sends to the private chat with
  its bot or to a group; `state`, a contract (`state.ready`, `state.commands`, `state.bot`,
  `actions.sent`, `READINESS_MEMBERS`, bot-os.md D141) bound to its bot's readiness state (the
  generic `readinessPlugin`, or a game's state plugin that keeps a readiness, below), required, so
  that drift on the parser that state requires stops it; and `attention`, its person (§2.1, D133),
  required. **It only sends** (bot-os.md D99): it reads no chat, and an edge to a chat-in of it is
  refused. **Its one chat is its edge's alone** (bot-os.md D97): its chat-out edge names exactly one
  chat (`single`), the bot's `@username` or, as the owner prefers (bot-os.md D139), a group's id
  (`-100…`), a group its bot is in and its bot's parser's edge reads; and it allows the forms it may
  send (the editor keeps it so, D137, D140). Its configuration: `commands`, the commands it plays in
  order, each `{ command, whileHeld?, whenReady?, forms? }` (`command` and `whileHeld` by name or
  alias, resolved to the name; `forms`, the forms it may send it as, in order, D140: unset, every
  one, all its names bare, then, in a group, all of them addressed to its bot, `/play@QuestBot`, its
  state's `bot`, so that on a tie a bot's own bare alias goes before an addressed form); **unset,
  the defaults** (bot-os.md D137), every form: every command its state declares (its read
  `commands`) but an interactive one, in its order; `settleS` (10 by default, below); and `marginS`
  (5 by default, D146): it sends a command no sooner than that many seconds after it became ready (a
  bot's answers are dated to the whole second, and its clock may run behind), and a wait for a
  command due ends in its person's reaction from that moment (`react({ after })`). Each command's
  policy comes from its mechanics: a turn, whenever ready (the bot's rest over); a command whose
  success clears another's hold (a reset), only while that other is held (cooling down); any other,
  whenever ready. An entry overrides it: `whileHeld`, only while that command is held; `whenReady`,
  whenever ready (not both). The editor draws `commands` as a checklist of its state's
  (`configPlays`, §4.16). **No schedule of its own:** given a sitting, it plays, one at a time, each
  of its commands that is ready (its state's `state.ready`), allowed by its policy (D142: its state
  alone decides readiness; the outbox holds back no game's cooldown), each after its person's
  reaction time (a glance first, then the answer read, scaled to its length); after each live send
  it waits for the answer its state reads (looking every 5 seconds, up to two minutes; one dated in
  the second of the send counts, a message's date being the whole second), then looks again, so that
  a command an answer unlocks, or one a reset makes ready again, is taken in the same sitting. **The
  form, by reach** (bot-os.md D140, `chat-group.ts`): the players of one `playerPlugin` registration
  whose chat-out edges send to the same chat from the same account are a group (a registry in
  memory, each joining at its start under its outbox's `account` and its chat). A form reaches the
  players of the group whose bot takes it (`commandOf` on its state's `commands`: bare, every one
  whose bot declares that name; addressed, its bot's alone) and is allowed only if every one of them
  would play its command now: in a sitting of its own person, the command ticked and its policy
  allowing it, ready (and not sent in the sitting unless ready again), not covered by another's
  claim, and the form one its config allows. Of its forms allowed, it sends the one of widest reach,
  the first in its order on a tie (`pickForm`); none allowed, the command waits. **Settling first:**
  while a player its widest form reaches has a send its state read no answer to, younger than two
  minutes, or will have that command ready within `settleS` seconds, it waits (until then, or 5
  seconds for an answer; at most two minutes in all, then it picks with what it knows); and with
  nothing ready, a command of its own due within `settleS` keeps it in the sitting until then. It
  picks and claims the players its form reaches (covered for their command, until its hand-off or
  two minutes) in the same tick it sends, so no other sends an overlapping form. **In a sitting that
  follows the owner's play** (D138), or one they wrote during, or one in which another player of its
  account sent a command (D139, D140), it first waits, the same way, for the answer to the last send
  its state knows of and has read no answer to (sent less than two minutes before), so that what
  that answer unlocks or holds is known (a bare turn another sent in the group, its bot's turn
  taken, is not sent again); then it plays its whole checklist, the turn included. A command it sent
  in the sitting goes again only if it became ready again since (its readiness `since` after the
  send), at most 20 sends a sitting; when nothing is left, it sleeps until the next sitting. Its
  next step is the durable timer `play`, and the sitting it is in is kept in its store (`state`), so
  a restart takes the sitting up where it was (one whose step came due more than 10 minutes before
  is dropped). Through a live chat-out edge it sends through its outbox (refused `not connected`, it
  waits for the account, trying each minute) and tells its state each command sent, with its
  message's id, which hands it to its parser to pair the bot's answer (D141), and hands it off to
  every other player of its account, whatever its chat, each telling its own state (D139, D140), its
  claim then ending; through a dry-run edge (bot-os.md D64, as a new one is drawn) it logs each
  command (`sent`, `/play (dry run)`) and sends nothing, each command once a sitting since no answer
  comes; a send refused or failed is not tried again in that sitting, and a command its state
  declares none of is never played (said once). It plays while its node runs and the instance is on;
  its safety stop (`kill`) stops its node (`ctx.stop`), which drops its sitting until the owner
  clears the stop in the editor. It declares no chat command, since two nodes would clash: the owner
  reaches each with `/plugins <id>` and its read `status` (its chat, its commands, its last play and
  its next: its next step in a sitting, else its person's next sitting, or `follows your play`),
  which its node's widget and page (**Plays**) show (D112). Each step is published as `player.step`
  (`sitting`, `sent`, `read`, `done`, `waiting`, `failed`, `stopped`); its commands sent, by
  command, go in the owner's summary (§4.17, D92). The image offers both (`src/main.ts`): the editor
  adds one `attention` node per person and one player per bot, each on its own instance, its `chat`
  edge to the owner's `telegram-user` node, its `state` edge from its bot's readiness state and its
  `attention` edge from its person. The turn parsers and the readiness states are not the image's:
  each is made from a game's grammar and mechanics, so a game's module offers them. **A game's
  module declares its commands' mechanics** on its state's side (`ReadinessSpec.mechanics`, D132,
  D141): a cooldown (`{ "/daily": { cooldownMin: 1440 } }`), a reset at set wall-clock times
  (`{ "/market": { resetsAt: { times: ["00:00"], timeZone: "Europe/Rome" } } }`, D165), an announced
  unlock (`{ "/chest": { unlock: { forMin: 30 } } }`, the announcement its parser's `announcedBy` or
  a reading's `unlocks`) and a reset
  (`{ "/coffee": { effects: [{ command: "/play", clear: true }] } }`), and marks a command that
  needs the person `interactive`; the player needs nothing more. A reset ends the command's hold in
  the state, which alone holds it (D142: the outbox keeps no cooldown); a grammar reads a reset's
  answer with its `effects` only where the state needs them, for an effect the mechanics do not
  declare.
- **`owner-notice`** (`packages/turns/src/owner-notice.ts`, bot-os.md D91, D94, D171): the one node
  that reports to a chat; without one, nothing is (the editor's events panel shows the notices,
  §4.16). It tells the owner what needs attention, from the notices (§4.16), through its `chat`
  output (chat-out, on any network). **Its edges are its only chat setting** (bot-os.md D97): it
  sends each message to every chat every edge of that output names (`many`: one edge per connector,
  so an edge to a `telegram-bot` and one to `irc` tell both, `ctx.outboxes`); an edge that names no
  chat sends to its connector's owner's private chat (`owner`: `Connector.owner()`, a
  `telegram-bot`'s `owner`), which the editor writes on the edge as it is drawn; to a connector with
  no owner, it sends nowhere and its panel says why. Its sends are queued as any node's (`enqueue`,
  D73), so a dry-run edge (as a new one is drawn, D64) logs each as `core.send` with outcome
  `dry-run` and sends nothing. Its configuration (`ownerNoticeConfig`): `report`, each kind on or
  off (`refused`, `coalesced`, `drift`, `cascade`, `failed`, `stalled`, `unreachable`, `warning`,
  `other` for every kind it does not name, and `told`, the plugins' messages), all on by default;
  `pace`, per kind but `told`, `gatherS`, how long the kind's first notice waits for others of its
  kind, and `everyMin`, the least minutes between two of its messages, what comes meanwhile going in
  the next (`DEFAULT_PACE`: `failed`, `drift`, `cascade` and `stalled` 10 s and 5 min; `unreachable`
  30 s and 10 min; `refused` 60 s and 10 min; `coalesced` 60 s and 30 min; `warning` 30 s and 60
  min; `other` 60 s and 10 min; a field left out keeps its default); `maxLines`, the most items a
  message lists (5), the rest counted; `level`, `digest`, `sources`, `verboseEveryMin` and
  `startNotice`, below. **What it sends at once, by level** (D171, §4.16): a notice at or above
  `level` (`warning` by default) is told at once, at its kind's pace; one below it and at or above
  `digest.level` (`info`) waits for the digest; one below both is dropped (recorded all the same,
  `core.notice`, and listed in its view). So by default a failure, a stop or a cascade (`error`) and
  a drift or a refusal (`warning`) are told at once, a start notice (`info`) waits for the digest,
  and a coalesced send (`debug`) is told nowhere. `sources` sets one node's two thresholds at once,
  both its level (`{ "quest-state": { "level": "error" } }`; with `until`, an ISO time, for that
  long); the `/verbose` command, below, sets one too, and wins. A kind's message is plain text: one
  notice is its own line (`script-1 failed: its script hung: …`); several, a title with their count
  and, past a minute, how long they took, then an item each, alike ones counted once
  (`inventory refused 5 events in the last 10 min:` and `- quest.gain: … (×3)`), grouped by node for
  `refused` and `coalesced`. It tells nothing of itself (a notice about its node, or a send it
  shared), so its own sends cannot feed it. The load's warnings it has told are kept in its store
  (`warned`), and the next start tells only new ones. Each message is recorded as
  `owner-notice.told` once per chat it goes to (`kind`, `count`, `chat`, `text`; `kind` `digest`,
  `verbose` and `start` for those below). One the network refuses (D95) is never told (its own
  failure, sent the same way, would loop): its view keeps the last failure per chat (`notSent`, a
  list of `{ t, account, chat, reason }`, the chat's next message that goes clearing it), and its
  card the last. What waits in a kind is dropped when its node stops. **The plugins' messages**
  (`told`, `ctx.notify`, §4.8, D94) are neither grouped nor paced, since a plugin's prompt waits for
  nothing: each is sent at once as its own message, with its buttons (`buttonsOf`) handed to the
  outbox (`SendOptions.buttons`), which a `telegram-bot` sends to the owner's chat through its
  surface, so that a tap runs the owner's command, and any other connector drops; none while the
  instance is off. Those heard as the instance starts wait for the start notice's wait
  (`START_WAIT_MS`, its connector connected by then) and follow it; a plugin's message is a
  `warning` unless it gives a level (`ctx.notify(text, buttons, { level })`), and goes to the digest
  or nowhere below `level`. **A digest** (bot-os.md D92, D171; `digest`): once a day at `at`
  (`09:00` by default, HH:MM) in `timeZone` (an IANA zone, `UTC` by default; the times its messages
  name are in it too), or every `everyMin` minutes instead; `enabled: false`, none. It holds the
  notices that waited for it, grouped by kind (a kind's several as its paced message words them, the
  start notices folded into `Started 3 times, last: …`), the lines for the nodes whose `/verbose`
  ended (`quest-state back to warning`), `And 12 older notices not kept` past the 500 it keeps
  (`DIGEST_KEPT`), then the summary lines (`collect`, §4.17) at or above `digest.level` for the time
  since the last digest sent (or since the start, when that came later), each section titled by its
  node, one line on its title's, several listed, at most `maxLines`. So the core's counts of sends
  and notices and the shell's activity counts (`debug`) are in none by default. **None when nothing
  qualifies**, and the next then covers the time since the last one sent. Kept in its store
  (`digest`): what waits (`waiting`, `dropped`) and when it last sent one (`sentAt`) and last looked
  (`checkedAt`), so that a restart neither loses what waits nor sends a digest again, the next due
  at the next time after the last look (in a minute, when that is past). A graph saved before D171
  has `summaryEveryMin` (deprecated; `digestOf` reads it): `60`, which 0.1.72 wrote as its default,
  counts as unset (the daily digest); another number of minutes is the digest's `everyMin`; `0`
  turns the digest off. **The owner's commands** (`owner: true`, §2; they need a commands edge from
  a connector's `commands` output to its `commands` input that names the owner's chat, D109, as a
  new edge starts as a dry run): `/notices` shows its levels, each node's own with its expiry and
  who set it (`/verbose` or the graph's `sources`), and when the next digest goes;
  `/verbose <node> [level] [for <duration>]` tells that node's notices at once from `level` (`debug`
  by default) and above, until `/quiet` or for the duration (`30m`, `2h`, `1d`, `1h30m`), replying
  with the exact time it ends in `timeZone`; `/quiet <node>` ends it. The overrides live in its
  store (`overrides`, a setting being a number, a flag or text, §2), so they survive a restart and
  not a fresh store; one past its end is removed, and the digest says so. **While a node is told
  below `digest.level`** (`/verbose quest-state debug`), every `verboseEveryMin` minutes (60 by
  default) it sends that node's summary lines alone, its activity counts included
  (`Detail of quest-state, the last 60 min:`), none when they are empty, until the override ends.
  **A start notice** at each start (`startNotice`, on by default; `info`, so in the digest, or
  `error`, so at once, when an enabled node failed to start or load), 10 s after every node has
  started (`START_WAIT_MS`), so that a node that fails as it starts is in it: the release and
  commit, the nodes running (at most `maxLines` named, the rest counted), those not running with
  their state and why, and the graph's warnings (those new listed, those told at an earlier start
  counted, with `warning` on). The failures and warnings heard before it are its news, not messages
  of their own, each node not running named with why; the core tells no start of its own (it tells
  no chat anything, D94). A node the send-queue watchdog stopped (`stalled`, §4.6, D93) is told as
  its notice says
  (`quest-actor sent /inventory to @QuestBot 10 times with no answer read from it; stopped until you clear the stop in the editor`),
  several as `2 nodes stopped: their commands went unanswered:` and an item each
  (`- quest-actor: /inventory to @QuestBot, 10 times`).
- **`reactor`** (`packages/turns/src/reactor.ts`): one reaction (`react`, §4.15) made from its
  node's config, with no code, run as one instance per reaction. An actor: whether it sends for real
  is its chat-out edge's (a dry run as the editor draws it, D64). Its configuration
  (`reactorConfig`): `on`, the event type it reacts to (or a namespace), or `match`, a regular
  expression the messages read on its chat-in input must match (its named groups in the payload),
  with `in` (the chats whose messages it reads, a list picked among its chat-in connector's, D96,
  #7; one chat as a string, as 0.1.20 saved it, is refused since D110; every chat its edge reads
  without) and `ignoreCase`; exactly one of `on` and `match`. Then `when` (dotted paths of the
  payload, each equal to its value), `chat` (picked among its chat-out connector's chats, or a
  `{path}` template, D96) and `send` (a `{path}` template of the payload), the chat picked for
  `chat` and `in` written by the editor on its edge's `sends` and `reads` too, and replaced there
  when the pick changes (D97: a template names no chat ahead, so a `{chat}` reaction's edge lists by
  hand the chats it may answer in), and `maxAgeS` (how old an event may be, unset by default: any
  age, an event played back skipped by its mark, D88). Its ports: `chat`, a chat-out output, the
  account it sends through (on any network), whose edge carries the chat it sends to and its
  commands; `chat`, a chat-in input there only with `match` (`when: { config: 'match' }`, §2.1), the
  chats it reads; and `events`, whose namespace is the one of its `on` (§2.1): there only with `on`
  (`when: { config: 'on' }`) and then required, bound to the nodes whose events it hears (the check
  refuses a reactor on events that no edge binds), and not a port at all of a reactor on messages.
  So a reactor on events only sends. Each reaction is recorded as `reactor.reaction`, and each send
  logged as `core.send` with the node's id as its origin. Its `status` read (#7) gives its last
  reaction (`at`, an ISO time, `outcome`, and `reason`, `chat` and `text` when it has them), its
  reactions by outcome (`counts`) and when it first reacted (`since`, likewise), kept in its
  instance's store across restarts (through `react`'s `observe`); its node panel shows it (its
  `view`, the last pinned) and its card a line of the counts (`2 sent, 1 skipped`). The image offers
  it (`src/main.ts`); a node that examines what a game's parser reads, in the graph file:

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

- **`collection`** (`packages/turns/src/collection.ts`, bot-os.md D155): records of a schema its
  config gives, media included, edited by the owner in its node's panel and read by other nodes
  through its interface: data kept apart from the logic that uses it (a writer's cast, a list of
  sentences, a list of pictures). One node per collection; its node's manifest is its own (§2, D74):
  its actions' inputs are made from its fields, and its event type is in its node's namespace. Its
  config, `postcard`'s cast:

  ```json
  {
    "fields": [
      { "name": "name", "type": "text", "required": true, "unique": true },
      { "name": "role", "type": "choice", "options": ["seller", "character"] },
      { "name": "behaviour", "type": "text", "long": true, "help": "How they act" },
      { "name": "setting", "type": "text", "long": true },
      { "name": "face", "type": "media", "kinds": ["image"], "maxBytes": 10485760 }
    ],
    "title": "name"
  }
  ```

  Each field: `name` (a word), `type` (`text`, `number`, `boolean`, `choice`, `list` of texts,
  `media`), `help`, `required`, `unique` (a text, a number or a choice; a text trimmed and compared
  without case); a text's `long` (several lines); a choice's `options`; a media's `kinds` (`image`,
  `video`, `audio`, `document`), `mimes` and `maxBytes` (§4.18's limits). `title`, the text field
  that names a record in lists, the first text field by default. The check refuses a choice without
  options, a key of another type's, a name twice, a title that is no text field.

  ```ts
  interface CollectionRecord {
    id: string; // `r1`, `r2`, …: stable, never reused
    position: number; // its place in the order, from 0
    values: Record<string, string | number | boolean | string[] | MediaRef>;
    incomplete?: string[]; // why, when it is: `face is required`
  }
  interface MediaRef {
    id: string; // `sha256:<hex>`, its bytes' SHA-256
    mime: string;
    width?: number;
    height?: number;
  }
  ```

  - **Reads**, through an interface input
    `{ type: 'interface', plugin: 'collection', members: ['state.list', 'state.media'] }`: `list()`,
    the records in order; `get({ id })`, one, `null` for none; `schema()`, `{ fields, title? }`, its
    fields with their defaults; `media({ id })`, a `MediaResult` (§4.18): the bytes of a media its
    records hold, its type, width and height the record's, `{ ok: true, media: null }` for an id no
    record holds, `{ ok: false, error }` for an id that is none (`sha256:<64 hex>`) or a file gone.
  - **Actions**, each checked against its schema, then by the collection (a required field given, a
    unique value no other record has, a media within its field's limits and of the type it says),
    refused with why (thrown through an interface; a 400 or a 409 from the panel):
    `add({ values, position? })`, last by default; `update({ id, values, unset? })`, the values
    given put in, the fields of `unset` cleared (a required one refused); `remove({ id })`;
    `reorder({ id, position })`. A media field's value is a `Media`
    (`{ data, mime, width?, height? }`; from the panel, its bytes as `{ "$bytes": "<base64>" }`).
    Each answers the record (`reorder`, the list), and announces it: **`<node>.changed`**,
    `{ change: 'added' | 'updated' | 'removed' | 'reordered', id }`.
  - **Its store:** the records are its document `records` (`{ next, records: [{ id, values }] }`); a
    media's bytes are its file `sha256-<hex>` (a file's name takes no colon), kept once whatever the
    records that hold them, written before the record that refers to them; a file so named that no
    record refers to is deleted after each change and at the start.
  - **A schema changed** keeps the records and starts all the same: a field gone is dropped from
    them at the start, kept so, with a warning in its log; a value its field no longer takes is kept
    but left out of `values`, and the record is `incomplete`, saying why, as is one missing a
    required field or repeating a unique value an earlier record has. An update that fixes it
    completes it; one that changes another field is not refused for it.
  - **Its panel**, while it runs (`Collection.tsx` of the web UI): its records, each named by its
    title field, its values in a line, its pictures as thumbnails, why it is incomplete; **Add a
    record** and **Edit** open a form made from its `add` action's `values`, a media field a file's
    picker; an edit sends what changed and what was cleared; ↑ and ↓ move one; **Remove** asks
    first.
  - **The dev kit:** `collectionSeed(records)`, records whose media fields are `Media`, gives the
    document and the files of its store, ids `r1`, `r2`, … in order:
    `new DevKit({ documents: { cast: seed.documents }, files: { cast: seed.files }, … })` (§4.10).

  Out of scope: adding records from chat, and passing media by reference between nodes.

- **`script`** (`packages/turns/src/script-plugin.ts`, bot-os.md D76): a node whose code the owner
  types in the editor, on the ports its config declares; its node's manifest is made from them (§2,
  D74). Its config:

  ```json
  {
    "inputs": {
      "state-events": { "type": "events", "namespace": "quest-state" },
      "state": { "type": "interface", "plugin": "quest-state", "members": ["state.count"] }
    },
    "outputs": {
      "chat": { "type": "chat-out", "commands": ["/look"], "minIntervalS": { "/look": 30 } }
    },
    "events": { "looked": { "help": "An item looked at", "fields": { "item": "string" } } },
    "code": "on('quest-state.changed', async (e) => { … });",
    "limits": { "callMs": 1000, "memoryMb": 64 }
  }
  ```

  `inputs` are events inputs (a `namespace`) and interface inputs (a `plugin`, or none for a
  contract, and the `members` used), each `optional` or required; `outputs`, chat-out outputs, each
  with the `commands` it sends (by first word: its edge may allow only those, §2.1) and their
  spacing; `events`, its own event types, published as `<its id>.<name>`, each with its `help` and
  its fields' types (`string`, `number`, `boolean`, `unknown`). An `actor` when it has an output,
  else `stats`. Its `code` is audited (§2.3): each save records its hash. **Its code** is
  TypeScript, its types stripped (`stripTypeScriptTypes`, as Node strips the sources: only erasable
  syntax), run as the body of an async function (it may `await` at its top level) in a `vm` context
  that holds the script API alone and allows no code from text:

  ```ts
  on(type: string, fn: (event) => void | Promise<void>): void; // while it loads; ctx.bus.subscribe
  use(port).state.<read>(input?): Promise<output>; // ctx.use(port), the members its input uses
  use(port).actions.<action>(input): Promise<output>;
  outbox(port).enqueue(chat, text, { cancel? }): QueuedSend; // ctx.outbox(port).enqueue
  enqueue(port, chat, text, { cancel? }): QueuedSend; // the same, shorter
  outbox(port).held(chat, command): Promise<{ until, reason } | undefined>; // ctx.outbox(port).held
  publish(type, payload): void; // its own events: ctx.bus.publish
  store.read(name); store.write(name, value); store.remove(name); store.names(); // ctx.store
  clock.now(): number; // ctx.clock; `Date.now()` and `new Date()` read it too
  at(time: number | Date, fn: () => unknown): { cancel(): boolean }; // once, at a time (D106)
  every(ms: number, fn: () => unknown): { cancel(): boolean }; // on each multiple of ms since 1970
  log(...values); log.info(...); log.warn(...); log.error(...); // ctx.log; `console` too
  ```

  **Its timers** (bot-os.md D106) run on its node's clock (`ctx.clock`: the dev kit's virtual one in
  tests, each beat fired at its own time as it leaps). `at(time, fn)` runs `fn` once at `time` (ms
  since the epoch, or a `Date`); a time past fires as soon as it can. `every(ms, fn)` runs `fn` on
  each whole multiple of `ms` since the epoch (`every(60_000, fn)` at second :00 of each minute,
  `every(3_600_000, fn)` on the hour, UTC), from the next one on; a beat missed while the host was
  stalled is skipped, not made up for. Both may be called at any time, in its first run or in a
  handler or a timer (unlike `on`), and give a handle whose `cancel()` drops it (true if it was
  still pending). `every` takes 1000 ms at least, and a script has 100 timers pending at most: past
  either, the call throws, with why. A fire is called as a handler is: within the same limits, in
  its cost, its error logged (`a timer threw: …`) with the script going on, a hang failing its node
  (`its script hung: a timer of every(60000) spent over 1000 ms of CPU`). **Timers live in memory
  only:** the node's stop, its stop by exception, a failure, a restart or a reload drops them all,
  and the script runs again from the top when it starts. So a script sets its timers in its first
  run, and keeps what it must remember in `store`; a daily action catches up at start if it was down
  when it was due:

  ```ts
  // Once a day at 06:00 UTC, and at start if today's was missed.
  const HOUR = 6;
  const today = (): string => new Date().toISOString().slice(0, 10);
  function next(): Date {
    const d = new Date();
    d.setUTCHours(HOUR, 0, 0, 0);
    if (d.getTime() <= clock.now()) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  function daily(): void {
    if (new Date().getUTCHours() >= HOUR && store.read('daily') !== today()) {
      store.write('daily', today());
      enqueue('chat', '@QuestBot', '/daily');
    }
    at(next(), daily);
  }
  daily();

  // Each minute, at second :00.
  every(60_000, async () => {
    const n = (await use('state').state.count({ name: 'lantern' })) as number;
    if (n === 0) enqueue('chat', '@QuestBot', '/buy lantern');
  });
  ```

  A queued send's handle is awaited for its outcome (§4.6), with `status()` and `cancel()` (a
  promise); for a command a parser declares answers for, awaited it gives what the game answered too
  (`const a = await enqueue(…)`; `a.answer?.status`: `ok`, `refused` with its `reason`, or
  `unanswered`; bot-os.md D98), and `held(chat, command)` says what holds the command back now (the
  retry-loop guard; never a game's cooldown, D142: a script that would wait one out binds to a
  state's readiness, as the player does, or a refused send counts toward the guard); its cancel
  takes `on`, `when`, `deadline` and `withinMs`, not `test`, a function that cannot cross a thread.
  A member, an output or an event type its ports do not declare is refused, with why
  (`state offers it state.count, not state.get`); a handler that throws is logged, and the others go
  on. **It runs** in a worker thread of its own, its environment empty, its heap limited
  (`limits.memoryMb`, 16–2048, 64 by default), and the CPU it spends at a stretch limited
  (`limits.callMs`, 10–60000, 1000 by default): a ping from the main thread unanswered for twice the
  limit while the worker's thread spends the limit on the CPU, as a loop does in a handler's run or
  after an `await`, is a hang; a thread stalled with its host, not running, is waited for, even in
  the middle of a run (bot-os.md D81, D85). It is pinged only while its script is busy, from a
  message that may run its code until the worker says it is idle again, so an idle script costs
  nothing (D87). Past either, or if it crashes, the worker is killed and the node failed with why
  (`its script hung: a handler of quest.tick spent over 1000 ms of CPU`,
  `its script ran out of memory (its limit is 64 MB)`), the instance up. Its calls to the main
  thread are messages: an interface's member called there, a send queued there, its store's writes
  (read from a copy beside it), its events, its log lines and its timers, armed there and told to it
  as each is due; its clock is the main thread's time as the event or the timer was handed over.
  **In the dev kit** (§4.10), `scriptPlugin({ isolation: 'in-process' })` runs the same runtime in
  the main thread, on the kit's virtual clock, its calls direct, so that a run is deterministic.
  There is no worker to kill there, so its limit is vm's `timeout` on each synchronous run, `callMs`
  of real time (`its script hung: a handler of quest.tick took over 1000 ms`); a loop after an
  `await` is not caught, nor its memory limited.

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

  - **A bot's commands' readiness** (bot-os.md D141): a spec with `readiness`
    (`{ parser: { id, ...vocabulary }, mechanics }`, a `ReadinessSpec`, or a `ReadinessModel` built
    from one) keeps, in a section of its own, `readiness`, each of the bot's commands' readiness,
    reduced from its parser's events (`<id>.sent`, `.turn`, `.answer`, `.reply`, consumed through
    the same events input) by the reusable reducer `ReadinessModel`
    (`packages/turns/src/readiness.ts`) before the spec's `reduce` sees the state: a "too soon"
    holds a command for the wait it states; any other answer read is a success, which holds it for
    its `cooldownMin` or until the next of its `resetsAt` times (D165: `HH:MM` in its `timeZone`),
    the wait the bot states if longer, the latest of them winning, uses up its unlock, and applies
    its `effects` (`clear`, `shortenMin`) to other commands' holds; the turn's hold is the bot's
    rest, the longest it was told; an event's `unlocks` unlock an unlockable command (for
    `unlock.forMin` minutes, if given) and its `effects` apply as a success's. The spec's `reduce`
    sees the parser's events too, and may **fold more facts** into the section with the model's own
    pure steps: `hold(section, key, { until?, why, commands? } | undefined)` (a ban: every command,
    or those named, held until then; `undefined` lifts it), `succeed(section, command, t)`,
    `unlock(section, command, t)` and `lock(section, command)` (an unlock withdrawn): no wrapper of
    the parser's. It adds a second input, `parser`, a contract on its parser (`actions.sent`, bound
    by default to the node of the parser's id), to which it hands a player's sends; its bot's
    commands with their mechanics and its bot's name to its manifest (`botCommands`, `botUsername`),
    for the editor's checklist; and the player's contract (`READINESS_MEMBERS`): `state.ready()`,
    each command's readiness now, by name, the turn first,
    `{ ready, since?, until?, why?, sent?, answer? }` (ready since when, or held until when, none
    until an unlock, and why; its last send, `{ t, byHand }`, and the last answer read to it,
    `{ t, length }`), a game's hold told over the command's own unless that one ends later;
    `state.commands()`, its commands
    (`{ command, aliases?, turn?, cooldownMin?, resetsAt?, unlock?: { pattern?, forMin? }, effects?, interactive? }`,
    the turn first, then the vocabulary's order; `pattern` the parser's `announcedBy`);
    `state.bot()`; and `actions.sent(...)`, handed to its parser. A query may not take those names,
    nor the schema a section `readiness`. **`readinessPlugin`** (same file) is such a state with
    nothing else, for a game with no state of its own:
    `readinessPlugin({ id: "quest-ready", parser: { id: "quest", ...vocabulary }, mechanics })`. It
    survives restarts and catches up from the log as every state plugin does.
  - **The spec:** `schema`, a zod object whose keys are the state's **sections**, each value
    `.describe()`d (the viewer's labels); `initial`; `consumes`, the event types it applies, heard
    through a **required** events input per namespace (`events`, or `<ns>-events` for several): a
    parser disabled or stopped makes it inactive, at once and at the next start, and with it every
    node that requires it (§2.1, D65), since running on it would be frozen in time while the nodes
    acting on it go on asking; on its parser's drift (§4.7) the actors that require it are stopped
    through it, and it, of kind `stats`, goes on, as every node that does not act;
    `reduce(state, event)`, pure; `freshness(event, changed)`, what the event says of the sections
    it touches (`snapshot`, `delta` or `uncertain`; by default each section it changed a `delta`);
    `queries`, reads of its interface beside `get` and `freshness`; `events` and `announce`, its own
    events (below); and `migrations` (§4.2) for a kept state whose schema changed (one that does not
    fit fails the node, with why). Its kind is `stats`; its namespace is its id.
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
    (`<id>.refused`, with why), never retried; and raised as a `refused` notice (§4.16, bot-os.md
    D91), for a node that tells the owner. The events heard live, applied and refused, are counted
    in the owner's summary (§4.17, D92): `40 events applied, 2 refused`.
  - **Announced** after the write: each applied event that changed a section's value or freshness as
    `<id>.changed`, `{ sections, refreshed, event: { type, t } }`; a catch-up at start as one, its
    sections summed, with no event. A crash between the write and the announcement: the batch kept
    with the state is announced at the next start (a note, `announced`, says the last done), so a
    change is announced at least once, and never lost.
  - **What happened, in its own events** (bot-os.md D83): `events`, by name, each a zod object
    (`{ gained: z.object({ name: z.string(), count: z.number() }) }`), declared in its manifest as
    `<id>.<name>` beside `<id>.changed` (so the editor and a script node's types know them;
    `changed` and `refused` are taken), and `announce(before, after, event)`, pure, which gives
    `{ type: '<name>', payload }[]` for an event applied. So a script reacts to `quest-state.gained`
    instead of comparing states. They are **news only, and best effort**: `announce` is called for
    an event applied live alone, never for one refused, one the catch-up at start reads from the
    log, or one played back (`playback: true`), so that nothing acts again on what happened while
    the instance was down; each payload is checked against its schema (one refused, one of an
    undeclared name, or all of an event's when `announce` throws, are logged and dropped, the event
    applied all the same), then published, in order, with its event's time, once the state is kept
    and its `<id>.changed` announced. They are kept nowhere: a crash between the write and them
    loses them, and a restart never publishes them again.
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
`module-files.ts` (the modules in a folder or a repository, and each one's files), `module-git.ts`
(repository links and their updates, on any host), `module-github.ts` (GitHub), `module-gitea.ts` (a
Gitea-compatible server), `module-hosts.ts` (the hosts allowed) and `semver.ts`.

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
second. A `{ type: 'chat' }` input, and the `reach` shorthand, which the plugin API `"1"` read as
both before the split, are refused (bot-os.md D110). A graph of version 1 is refused (§2.3); code
that types a graph as `GraphInput` writes `version: 2`, and its chat edges each way.

### 7.3 Loading

At start (`src/main.ts`), in the background once the servers are up and the image's packages have
loaded (bot-os.md D143, §3), before the core loads, `loadModules` reads `/data/modules/` (the data
directory's `modules/`, `LOG_DIR`), the hidden directories aside (`.previous/`, `.staging/`), and:

1. reads and checks each `module.json`, and that its plugin entries exist;
2. checks each module's `api` against the shell's, and each import against the installed version of
   the module that provides it;
3. orders the modules so that each loads after those it imports;
4. registers the resolve hook (`module.register`, run on Node's hooks thread) with the table of the
   modules that load: their `provides` names and directories, and the host's file to resolve
   `@megabottron1999/*` and `zod` from;
5. imports each module's plugin entries, in that order, each import given 30 s to settle, and checks
   what they export and their manifests.

A module that fails any step is refused, by name and with why, and so is every module that imports
it, directly or not; the others load. The reasons read as:
`it targets plugin API 2, and this shell offers 1`,
`it imports @example/dice ^0.2.0, and dice 0.1.0 is installed`,
`it imports @example/nowhere, which no module provides`,
`it imports @example/old, which is refused`, `its imports form a cycle: a → b → a`,
`@example/same is provided by a and b`, `src/p.ts failed to load: …`,
`src/p.ts exports no plugins array`, `its plugin irc is offered by the image already`; a top-level
error or a SyntaxError of Node's type stripping reads `src/p.ts failed to load: <its message>`, one
that does not settle `src/p.ts failed to load: it did not load within 30 s`. The entry point prints
each module loaded, and each refused is told to the core as a failed load (§3, D143): its nodes are
`unloaded` in the editor, naming the module, for the owner to reinstall or roll it back on the
Modules page; the rest of the graph runs.

The plugins loaded are registered with the core beside the image's (`core.registerModule`), and
`core.available()` lists them all, each with its module: the plugins the instance offers, which the
editor will add as nodes. A plugin runs once a node of the saved graph (§2.3) names it.

### 7.4 Installing, rolling back and removing

The owner installs a module through the control API (§4.11), never an agent (P1, P11); it is loaded
at the next start (P8). The shell downloads a module only when the owner asks it to install one from
a repository's link, on GitHub or on a self-hosted Git server the owner added, and never installs or
restarts on its own (bot-os.md D67, D102). `ModuleStore` (`<data>/modules`):

- **Install** (`POST /modules`), one module a request: from a directory of the container's
  (`{"dir": "/path"}`); from a tarball, `.tar.gz` or `.tar` (base64 in `{"tarball": "…"}`, which the
  web UI's same-origin rule allows; or the bytes as the body, with `content-type: application/gzip`,
  on the loopback); from a directory's files one by one, as a browser reads a folder picked or
  dropped (`{"files": [{"path": "dice/module.json", "content": "<base64>"}, …]}`); or from a
  repository
  (`{"git": {"host"?: "git.example.lan", "repo": "<owner>/<repo>", "ref": "main", "refType"?: "branch", "path": "modules/dice", "commit"?: "<sha>"}}`,
  GitHub's without a `host`; `{"github": {…}}` is GitHub's too; below). A tarball or files may name
  their source for the owner (`"name"`). Up to 64 MiB: the body, and the files' bytes together. The
  tarball, or the files, hold the module at their root or in their one directory (as
  `git archive --prefix=dice/`, GitHub's release tarballs and a folder picked make it), which is
  stripped. A tarball holds files and directories only, nothing outside it; a file's path is
  relative to that root, with `/` (or `\`) between its parts, and one that is absolute, a drive's,
  or goes through `..` refuses the whole upload (`<path> leaves the module's directory`). It is
  staged in `.staging/`, checked (its `module.json`), pruned to the files it installs (below),
  checked again (each plugin entry must be among them: `its plugin entry src/p.ts is not there`),
  and replaces `<id>/`, whose version before is kept as `.previous/<id>/`. The answer is
  `{id, version, previous?, left?}`, `left` the files left out. 400 with why for what is not a
  module. Reinstalling an id is how a module is upgraded, or reinstalled at the same version
  (versions are not always bumped), the version before one rollback away.
- **What a module installs** (`module-files.ts`): the files under its directory, but `.git` and
  `node_modules` (never taken) and another module's directory nested in it. Of those, the ones its
  `module.json`'s `files` globs name (§7.1), or, without `files`, all but its tests: `*.test.ts`,
  `*.spec.ts` (and `.tsx`, `.js`, …), and the `test/`, `tests/`, `__tests__/` and `__snapshots__/`
  directories at any depth, its own top-level `vendor/`, and, for a folder whose listing has its
  `.gitignore` files, what they ignore (bot-os.md D104). Its `module.json` is always kept. A
  module's runtime code is under `src/` (§7.1), which no plugin may import its tests from.
- **Its source** is recorded at each install in `<data>/modules/.sources.json`, never in the
  module's own files: `{"kind": "folder", "name"?}`, `{"kind": "tarball", "name"?}`,
  `{"kind": "directory", "path"}` or
  `{"kind": "github", "repo", "ref", "refType", "path", "commit", "commitDate"?}` or
  `{"kind": "git", "host", "api": "gitea", "repo", "ref", "refType", "path", "commit", "commitDate"?}`
  (a self-hosted Git server's), with when it was installed (`installedAt`). The version kept for a
  rollback keeps its own, and a rollback swaps them; an install that replaces nothing (the module
  removed) leaves the previous version, and its record, as they are. A module installed before has
  none.
- **The modules in a tree** (`POST /modules/plan`): a folder may be a module's or a repository's
  root with several. Given its listing
  (`{"paths": ["games/modules/dice/module.json", …], "manifests": {"<path>": "<its text>"}, "ignores"?: {"<path>": "<its text>"}}`,
  the `module.json` files' text, and the `.gitignore` files' as `ignores`), it answers each module
  found: every `module.json` at any depth, but under `.git`, `node_modules`, a `vendor/` directory
  (vendored copies, not the owner's), a test directory (fixtures) or a path the `.gitignore` files
  ignore. **`.gitignore` files** (D104) are read as git reads them for a file not tracked: each
  file's rules apply under its directory, a deeper file's after a shallower's, the last rule that
  matches deciding (`!` re-includes), `/` anchoring a pattern to the file's directory, a trailing
  `/` matching directories only, `*`, `?`, `[…]` and `**`; what is under an ignored directory is
  ignored, and no rule re-includes it. What they ignore is left out of a module's default files;
  `files` globs that name it install it (a build's output a module ships). Only a folder's listing
  has them: a repository's archive holds only what is tracked, and a file tracked despite a
  `.gitignore` was added on purpose. Each with its `path` in the tree, `id`, `version`,
  `description`, its `status` against the version of its id installed (`new`; `update`, `same` or
  `older`, with the version `installed`), the `files` it installs and those `left` out, by their
  paths in the tree; or its `error`: its manifest refused (as `module.json: api: …`), a plugin entry
  missing or left out by its `files`, its id found twice. Nothing is installed; the web UI then
  sends each module the owner checks, with only its files.
- **From GitHub** (`module-github.ts`, #13): `POST /modules/link {"url": "…"}` (or
  `POST /modules/github`, the same) takes a public repository's link:
  `https://github.com/<owner>/<repo>` (its default branch), `…/tree/<ref>` or `…/tree/<ref>/<path>`
  (a branch, which may hold slashes, a tag, or a commit). The shell resolves the ref to a commit
  through GitHub's API (`GET /repos/<repo>`, for the default branch;
  `GET /repos/<repo>/commits?sha=<ref>&per_page=1`, the commit and its date; and
  `GET /repos/<repo>/git/ref/tags/<ref>`, whether it is a tag), downloads the repository's tarball
  at that commit from codeload (`https://codeload.github.com/<repo>/tar.gz/<commit>`, outside the
  API's rate limit; the last two are kept in memory, so the installs that follow a look download
  nothing), and finds its modules under the path as above:
  `{"source": {"repo", "ref", "refType", "path", "commit", "commitDate"}, "modules": [ … ]}`. Each
  module is then installed with `{"github": {…, "path": "<the module's>", "commit"}}`, from that
  commit; without a `commit`, from the ref's head now. 404 for a repository, branch, tag or commit
  not found (a private repository on GitHub reads as not found: private sources are on a self-hosted
  Git server, below), 429 for GitHub's rate limit, 502 for GitHub unreachable or failing.
- **From a self-hosted Git server** (`module-gitea.ts`, `module-hosts.ts`, bot-os.md D102, #48): a
  server with a Gitea-compatible API, once the owner has added it. **The hosts allowed** are GitHub
  and the servers added: `GET /modules/hosts` answers
  `{"servers": [{"host": "git.example.lan", "api": "gitea", "secret"?: "git_example_token"}], "secrets": [ … ]}`,
  `secrets` the names of the Docker secrets a token may be picked from (the shell's own left out);
  `POST /modules/hosts {"host": "git.example.lan", "secret"?: "<a secret's name>"}` adds one, or
  changes its secret, once it answers `GET https://<host>/api/v1/version` (with the token, if a
  secret is named), and answers the list; `DELETE /modules/hosts/<host>` forgets one (404 for one
  not added). The host is as the server's links name it (`git.example.lan`, or
  `git.example.lan:3000`), over `https://` only, at the server's root (one under a path is not
  supported); GitHub needs no adding. The list is kept in the core's store
  (`<data>/core/git-servers.json`): hosts and secrets' names, never a token. A link on a host not
  added is refused, 403:
  `git.example.lan is not an allowed host: add it under Git servers on the Modules page (…)`, and
  nothing is fetched from it. **The token** of a server is the Docker secret the owner picked (any
  name; `git_example_token` in the examples), read from `/run/secrets` when a request needs it,
  redacted from everything logged, and sent as `Authorization: token …` only to that server's own
  origin: redirects are followed by hand, and one to another origin is followed without it. A secret
  named for a server is no longer offered to a connector's config (`GET /secrets`). A server's
  public repositories need no token. **Links:** `https://<host>/<owner>/<repo>` (its default
  branch), or a folder's as the server's pages give it: `…/src/branch/<branch>/<path>`,
  `…/src/tag/<tag>/<path>`, `…/src/commit/<sha>/<path>`. The shell resolves them through the
  server's API (`GET /api/v1/repos/<repo>`, its default branch;
  `…/commits?sha=<ref>&limit=1&stat=false&verification=false&files=false`, the commit and its date),
  downloads `…/archive/<commit>.tar.gz`, and finds its modules as above (but under `vendor/`); the
  source answered and recorded is `{"kind": "git", "host", "api": "gitea", …}`, and each module is
  installed with `{"git": {"host", …}}`. **Errors** tell the cases apart: the host not allowed
  (403); the server's certificate not trusted (502,
  `git.example.lan: the server's certificate isn't trusted (SELF_SIGNED_CERT_IN_CHAIN): mount its CA and set NODE_EXTRA_CA_CERTS`);
  the server unreachable (502, with why); the token refused (401,
  `git.example.lan refused the token in the secret git_example_token (401): check it, or replace it`)
  or not allowed to read the repository (403); a token asked for where none is given (401 or 403); a
  repository not found, or private without a token (404,
  `git.example.lan/<repo> is not found, or is private: a private repository needs a token (…)`; with
  a token, `… or the token in the secret <name> cannot read it`); a branch, tag or commit missing
  (404). **A private CA:** the image's Node trusts the public authorities only; mount the server's
  CA certificate (PEM) and set `NODE_EXTRA_CA_CERTS` to its path. TLS verification is never turned
  off, and no option does it.
- **Updates:** for the modules installed from a repository, on GitHub or a Git server added, the
  shell checks at its start, every 6 hours, and when the owner asks (`POST /modules/updates`, which
  answers the list): each branch's head once (`commits?sha=<branch>`), however many modules follow
  it, and each repository's tags once (`GET /repos/<repo>/tags`; a server's page by page) for the
  modules installed from a tag. A host no longer allowed, or GitHub's rate limit, stops that host's
  checks, said in the check's `error`; the others go on. A module whose branch now names another
  commit, or whose tag has a newer semver tag (`v1.2.3` or `1.2.3`; pre-releases only after a
  pre-release), has an `update`: `{ref, commit, commitDate?, compare, unsure?}`, `compare` the
  host's comparison of the two commits (GitHub's, or `https://<host>/<repo>/compare/<a>...<b>`). A
  branch that moved is first compared with the commit each module was installed from (bot-os.md
  D103, #37), through the host's API, once for each pair of commits: GitHub's
  `GET /repos/<repo>/compare/<a>...<b>?per_page=1`, or the server's
  `GET /api/v1/repos/<repo>/compare/<a>...<b>?verification=false&files=true`; a module has an update
  only when a path changed (either side of a rename) lies under its own directory, any change for a
  module at the root. When the comparison cannot tell, the module has its update, with `unsure`
  saying why: on GitHub, the new head not `ahead` of the commit installed (a history rewritten) or
  300 files listed, its most; on a server, the commit installed not on the new head's first-parent
  line within the commits listed, a commit listed without its `files` (an older server), or the
  commits not all listed; on either, the comparison failing (said in the check's `error` too). A
  newer tag is an update whatever it changed. An update is installed as any install (`POST /modules`
  with its source at the new commit and ref), never on its own; a module installed from a commit is
  pinned.
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
folder dropped on the page) or a repository's link pasted (GitHub's, or one on a Git server added
under **Git servers**, where a server is added with its host and its token's secret picked from
those mounted, and removed) lists the modules found as a checklist (each with its path, version and
status, and its files left out; all checked but downgrades), installs those checked one by one, each
on its own, and says how each went; it shows each module's source (linked to GitHub, or to its
server, at its commit) and when it was installed, its update (**Update**, **Update all**, **Check
for updates**), installs a `.tar.gz`, rolls one back, removes one (**Remove**, confirmed in a dialog
that names it; disabled, its reason shown on hover, while the module is used) and restores one
removed (**Restore**), and offers the restart.

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
`commands`); untyped, a version 1 graph is refused (D110).
