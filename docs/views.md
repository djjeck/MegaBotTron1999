# Views: a cookbook

A **view** is a node whose page shows the nodes wired to it (bot-os.md D170): a dashboard at
`/v/<path>/`, behind the web UI's login. This page shows every element a view may hold, each with a
short, complete example, then a whole dashboard. The reference is bot-os-api.md §2 (Views); the
schema is `packages/core/src/widgets.ts`.

## How a view is made

A module ships a view as a plugin of kind `view` whose manifest declares `view`; the owner adds its
node in the editor and draws an edge from each node it shows to one of its inputs. The image's
generic `view` plugin takes the same `view` from its node's config, for the owner's own pages.

Every example below reads a made-up shop, a node of plugin `shop` whose interface offers these reads
and actions:

```ts
interface: {
  state: {
    summary: { help: 'Its counts', output: z.object({ ads: z.number(), queued: z.number(), donated: z.number(), since: z.string() }) },
    ads: { help: 'Its ads', output: z.array(z.object({ id: z.string(), item: z.string(), pictures: z.array(z.string()), cover: z.string(), category: z.string(), seller: z.string(), rev: z.number() })) },
    players: { help: 'Its players', output: z.array(z.object({ id: z.string(), name: z.string(), level: z.number(), triggers: z.array(z.string()), lastTurn: z.number() })) },
    player: { help: 'One player', input: z.object({ id: z.string() }), output: z.object({ drops: z.array(z.string()), pricing: z.object({ rate: z.number() }) }) },
    donations: { help: 'Its donations', output: z.array(z.object({ id: z.string(), from: z.string(), coins: z.number(), verdict: z.string(), at: z.string() })) },
  },
  actions: {
    advertise: { help: 'Writes an ad again', input: z.object({ item: z.string(), again: z.boolean().optional() }) },
    price: { help: 'Prices a donation', input: z.object({ id: z.string(), coins: z.number() }) },
  },
},
settings: z.object({ rate: z.number().default(1), minCoins: z.number().default(10) }),
```

The view's manifest names its input, then its page:

```ts
manifest: {
  id: 'shop-view',
  kinds: ['view'],
  description: "The shop's dashboard",
  inputs: { shop: { type: 'interface', plugin: 'shop', optional: true } },
  view: { title: 'Shop', sections: [/* the elements below */] },
},
```

**Two words to keep apart.** `show` names the kind of a section (`'table'`, `'tabs'`), and nothing
else. `format` says how a value is drawn (`'number'`, `'badge'`), on a column, a stat or a badge.
`from` names the input a section reads; a picture's `source` says where its file is (`'files'` or
`'media'`).

## The leaves

Each leaf is a card of its own. It names its input (`from`), its read, the read's `input` if it
takes one, a `path` into its output, a `label` (else the output's description there), and what it
says when empty (`empty`, else `Nothing yet`). While its read is asked it says so; a read that fails
breaks its card alone, naming the input and the read. **Its read is asked again as its node
changes** (bot-os.md D173): the view hears its nodes' changes as the core sees them (a write to the
node's store, an event it publishes, its state or settings, its `ctx.changed()`, or a change of a
node it reads through an interface edge, within about half a second), and asks again only the reads
of the nodes changed, in one batch. Nothing is asked while the page's browser tab is hidden; every
read is asked once when it shows again, and every two minutes while it is visible, whatever changed
(`SAFETY_REFRESH_MS`). A read whose answer depends on what the core cannot see (the time, a
connection) calls `ctx.changed()` when it would answer otherwise, or waits for that safety refresh.
A time shown as `in 5 minutes` ticks in the browser, with no request. The editor's **Costs** counts
the reads a view asks of each node (`reads`).

### stat: one value, large

```ts
{ show: 'stat', from: 'shop', read: 'summary', path: 'donated', label: 'Donated', format: 'number', unit: 'coins' }
```

A list or a map shows how many it holds. `of` adds a total (`of: 'ads'`, a path of the same read, or
a number); `tone` colours it (`neutral`, `info`, `success`, `warning`, `danger`), or `tones` by its
value (`tones: { open: 'success', closed: 'danger' }`).

### table: rows, searched, sorted and paged

```ts
{
  show: 'table', from: 'shop', read: 'players', label: 'Players',
  search: true, sort: true, defaultSort: { path: 'level', direction: 'desc' }, pageSize: 25,
  columns: ['name', { path: 'level', format: 'number' }, { path: 'triggers', format: 'tags' }, { path: 'lastTurn', label: 'Last turn', format: 'relative' }],
  empty: 'No player yet',
}
```

`search: true` searches every column; `search: ['name']`, those named. `sort: true` sorts by a click
on a header. A column is a path, or `{ path, label?, format?, unit?, tones?, source? }`.

### Formats

| `format`   | Draws                                                             |
| ---------- | ----------------------------------------------------------------- |
| `text`     | the value as text (the default)                                   |
| `number`   | a number, grouped, at most two decimals; `unit` after it          |
| `percent`  | a number out of 100, with `%`                                     |
| `datetime` | a time (ms or ISO) as a date and an hour                          |
| `relative` | a time as how long ago or until (`3m 20s ago`)                    |
| `badge`    | the value in a pill, coloured by `tones` (`'*'`: any other value) |
| `tags`     | a list of texts as chips                                          |
| `image`    | a picture: a file of the node's (`source: 'files'`) or a media    |
| `carousel` | a list of pictures, one at a time                                 |

```ts
{ path: 'verdict', format: 'badge', tones: { accepted: 'success', pending: 'warning', refunded: 'danger', '*': 'neutral' } }
```

A column written in phase 1 as `{ path, show: 'image', from: 'media' }` still reads, as
`{ path, format: 'image', source: 'media' }`.

### Row actions

```ts
{
  show: 'table', from: 'shop', read: 'donations', label: 'Donations',
  columns: ['from', { path: 'coins', format: 'number' }],
  actions: [{ label: 'Price', action: 'price', input: { id: '$row.id' }, confirm: 'Price it?' }],
}
```

`input` gives the action's keys: constants, `'$row.<path>'`, `'$selector'`; the owner fills the rest
in a small form, `current` presetting keys from the row. The button says it is busy, then its answer
or why it was refused, and the leaves of that node are read again.

### gallery: cards of pictures

```ts
{
  show: 'gallery', from: 'shop', read: 'ads', label: 'Ads',
  image: { path: 'pictures', carousel: true }, caption: 'item', search: ['item', 'seller'], pageSize: 24,
  badges: [{ path: 'category', format: 'badge', tones: { teleshopping: 'info', guru: 'success' } }],
  actions: [{ label: 'Write again', action: 'advertise', input: { item: '$row.item', again: true } }],
}
```

`image.source` is `'files'` (the default) or `'media'`; `carousel: true` for a list of pictures.

### A drawer: a row's detail, in the address

```ts
{
  show: 'table', from: 'shop', read: 'players', label: 'Players', key: 'id',
  columns: ['name', { path: 'level', format: 'number' }],
  detail: {
    title: 'name',
    fields: ['level', { path: 'triggers', format: 'tags' }],
    actions: [{ label: 'Write again', action: 'advertise', input: { item: '$row.name' } }],
    sections: [
      { show: 'list', from: 'shop', read: 'player', label: 'Drops', input: { id: '$row.id' }, path: 'drops' },
    ],
  },
}
```

A click on a row (or a gallery's card) opens its drawer at the side, the whole screen on a phone.
The open row is in the address, `?row=<key>`, its `key` path's value (`id` by default), so a link,
such as one in the owner's chat, opens it. Its `sections` are leaves read with the row's values
(`'$row.<path>'`); they open no drawer of their own. A tab (or the page outside the tabs) has one
leaf with a drawer at most.

### form: several fields at once

```ts
{
  show: 'form', from: 'shop', label: 'Price', action: 'price',
  input: { id: '$row.id' }, fields: ['coins'],
  current: { read: 'player', input: { id: '$row.id' }, path: 'pricing' },
  submit: 'Price', confirm: 'Price this donation?',
}
```

An action's form: the fields `input` does not give (only `fields`, if named), preset from `current`.
A form of the node's live settings instead:

```ts
{ show: 'form', from: 'shop', label: 'Pricing', settings: ['rate', 'minCoins'] }
```

Each sends on its button, says it is busy, then done or why not.

### keyValue, counter, list, progress, until

```ts
{ show: 'keyValue', from: 'shop', read: 'summary', fields: ['ads', { path: 'since', format: 'relative' }] }
{ show: 'counter', from: 'shop', read: 'donations', label: 'Donations' }
{ show: 'list', from: 'shop', read: 'players', item: 'name', max: 10 }
{ show: 'progress', from: 'shop', read: 'summary', path: 'queued', of: 50 }
{ show: 'until', from: 'shop', read: 'summary', path: 'since' }
```

## The layouts

### grid: columns of cards

```ts
{ show: 'grid', columns: 4, sections: [/* stats, tables… */] }
```

`columns` from 1 to 6 (3 by default); one column on a phone.

### card: sections in one box

```ts
{ show: 'card', title: 'Pricing', sections: [{ show: 'form', from: 'shop', settings: ['rate'] }] }
```

### tabs: one panel at a time

```ts
{
  show: 'tabs',
  tabs: [
    { title: 'Catalogue', count: { from: 'shop', read: 'ads' }, sections: [/* … */] },
    { title: 'Players', sections: [/* … */] },
  ],
}
```

The open tab is in the address, `?tab=<slug>` (its title in lower case, words joined by dashes:
`Donations & refunds` is `donations-refunds`); only its reads are asked, with those outside the tabs
and the tabs' counts: a tab not on screen asks nothing else, and one switched to asks its reads at
once, then every five seconds with the rest. An open drawer (`?row=`) is its tab's. `count` puts a
number by its title: a number, or a list's or a map's size. A view has one level of tabs, and no two
of one slug.

## The selector

One choice on the page, its options a list read; sections take its value as `'$selector'`, and the
address keeps it, `?s=<value>`:

```ts
view: {
  title: 'A player',
  selector: { from: 'shop', read: 'players', value: 'id', label: 'name', title: 'Player' },
  sections: [{ show: 'keyValue', from: 'shop', read: 'player', input: { id: '$selector' }, path: 'pricing' }],
}
```

## When the check refuses it

The manifest's check and the graph's name the path into the manifest and what is wrong, with the
input and the node it is bound to:

```text
view.sections.0.tabs.1.title: its address is tab 0's too (?tab=players): give it another title
node home: view sections.1.tabs.0.sections.0.columns.2: triggers is not a list of texts (from shop, bound to shop)
node home: view sections.1.tabs.0.sections.0.key: its rows have no id: a drawer needs a key that tells its rows apart (key)
expected show to be one of: keyValue, counter, list, table, progress, until, stat, gallery, form, tabs, grid, card
```

## A whole dashboard

```ts
view: {
  title: 'Shop ads',
  sections: [
    {
      show: 'grid', columns: 4,
      sections: [
        { show: 'stat', from: 'shop', read: 'summary', path: 'ads', label: 'Ads', format: 'number' },
        { show: 'stat', from: 'shop', read: 'players', label: 'Players' },
        { show: 'stat', from: 'shop', read: 'summary', path: 'donated', label: 'Donated', format: 'number', unit: 'coins', tone: 'success' },
        { show: 'stat', from: 'shop', read: 'summary', path: 'queued', label: 'Queued', tone: 'warning' },
      ],
    },
    {
      show: 'tabs',
      tabs: [
        {
          title: 'Catalogue',
          count: { from: 'shop', read: 'ads' },
          sections: [
            {
              show: 'gallery', from: 'shop', read: 'ads', label: 'Ads',
              image: { path: 'pictures', carousel: true }, caption: 'item', search: ['item', 'seller'], pageSize: 24,
              badges: [{ path: 'category', format: 'badge', tones: { teleshopping: 'info', guru: 'success' } }],
              actions: [{ label: 'Write again', action: 'advertise', input: { item: '$row.item', again: true }, confirm: 'Write this ad again?' }],
              detail: { title: 'item', fields: ['seller', { path: 'rev', label: 'Revision', format: 'number' }] },
            },
          ],
        },
        {
          title: 'Players',
          count: { from: 'shop', read: 'players' },
          sections: [
            {
              show: 'table', from: 'shop', read: 'players', label: 'Players',
              search: true, sort: true, defaultSort: { path: 'level', direction: 'desc' }, pageSize: 25,
              columns: ['name', { path: 'level', format: 'number' }, { path: 'triggers', format: 'tags' }, { path: 'lastTurn', label: 'Last turn', format: 'relative' }],
              detail: {
                title: 'name',
                sections: [{ show: 'list', from: 'shop', read: 'player', label: 'Drops', input: { id: '$row.id' }, path: 'drops' }],
              },
            },
          ],
        },
        {
          title: 'Donations & refunds',
          sections: [
            {
              show: 'table', from: 'shop', read: 'donations', label: 'Donations',
              sort: true, defaultSort: { path: 'at', direction: 'desc' },
              columns: [
                'from',
                { path: 'coins', format: 'number' },
                { path: 'verdict', format: 'badge', tones: { accepted: 'success', pending: 'warning', refunded: 'danger' } },
                { path: 'at', label: 'When', format: 'datetime' },
              ],
              actions: [{ label: 'Price', action: 'price', input: { id: '$row.id' } }],
            },
            { show: 'card', title: 'Pricing', sections: [{ show: 'form', from: 'shop', settings: ['rate', 'minCoins'] }] },
          ],
        },
      ],
    },
  ],
},
```
