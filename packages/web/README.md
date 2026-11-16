# @megabottron1999/web

The shell's web UI, the owner's console: the instance's graph, its home page, the other pages, and
the server that guards them.

- `src/ui/`: a React app, built by Vite (`npm run build`, `vite.config.ts`, `index.html`) into
  `dist/`, the only build step of the shell. Its pages are reached by the URL's hash, as tabs across
  a top bar, the tab selected being the page's title; a bottom bar holds small print, such as
  diagnostics: the release the instance runs and its commit, how long it has run and its memory
  (`GET /api/instance`, read every minute and again after a restart); both bars stay, and only the
  page between them scrolls. The home page is the **Graph** (`#/graph`, `src/ui/graph/`), the graph
  editor (docs/bot-os.md D55), drawn with React Flow (`@xyflow/react`): a draft of the saved graph,
  each plugin instance a node with its input ports on the left (as the core's check resolves them
  from its config, `POST /graph/check`'s `inputs`) and its output ports on the right, each port type
  in its own shape and colour, each binding an edge in its type's colour, dashed when the input is
  optional, and on each node its state and drift (docs/bot-os.md D64): disabled, greyed; stopped, in
  red tones with a warning icon and its reason; inactive, greyed with the node it needs. The page is
  the map, filling the area between the bars: its minimap at the top right; what the draft needs
  (**Review changes**, the problems and warnings, the selection and **Kill selected**) at the top
  left; the zoom controls and the legend at the bottom left; and **Add a node**, a floating "+"
  button, at the bottom right. The panel of what is selected opens beside the map (below it on a
  phone). Chats flow left to right (docs/bot-os.md D60): a connector is drawn as two cards
  (`cards.ts`), its **in** card (`telegram-user · in`) at the left, whose chat-in output feeds the
  readers, and its **out** card (`telegram-user · out`) in a column of its own at the right, whose
  chat-out input takes the senders' edges; one node in the graph file all the same. Each card is
  placed on its own, either selects the node and opens its panel, and removing it removes both,
  after a confirmation that names them. An empty graph offers its first node, a connector. **Add a
  node** lists the plugins offered, by the image and each module (`Palette.tsx`), and asks its id
  and its instance: fresh, or kept (`AddNode.tsx`); the node added is selected, its panel open on
  it. An edge is dragged from an output to an input; one over a port that cannot take it (another
  type, network or namespace) is drawn red and dashed, the port ringed, and the drop refused with
  why in the status (`DraggedEdge.tsx`, `draft.ts`'s `bindProblem`, docs/bot-os.md D101); dropped on
  the card of a node whose inputs its config declares (a script node, docs/bot-os.md D80), not on a
  port, it is bound to an input of the node that takes it, or to one added to its config for it
  (`draft.ts`'s `dropOn`: an events input of the output's namespace, or an interface input of its
  plugin with no member, to pick in its panel); when several of its inputs take it, to the one bound
  to that output already or the only one free, else to none, the status naming them, to drop it on
  the port of one (D84); a rhombus at its midpoint, in its port type's colour (`PortEdge.tsx`), is a
  button that selects it and opens its panel (`EdgeDetails.tsx`), where a chat-in edge's `reads` (or
  all the chats its connector monitors) and its `senders` (anyone, or a list with _me_), or a
  chat-out edge's `sends` and `commands`, are set, the chats read picked among its connector's
  monitored chats, those sent to among all its chats (sending needs no monitoring, D97), and the
  words as rows (`Surfaces.tsx`, D62, D63); a **commands edge** (D109), from a connector's
  `commands` output to a plugin's `commands` input, the plugin's chat commands it answers
  (checkboxes, every one by default; not a chat-out's `commands`, the words a plugin sends), the
  `chats` it answers them in (in the chat picker) and every private chat, who may ask (anyone, or a
  list with _the owner_) and its dry run, which a new one starts (its chats the connector's
  owner's); a plugin's panel says, for each of its commands, which connector serves it, in which
  chats by name and to whom, or that no edge does, a connector's which plugins' commands it serves,
  and a plugin's `commands` port says so on its card; and where **Remove edge** removes it alone; a
  connector's own `chats`, what it monitors, are every chat or those picked. **Every chat is picked
  in one chat picker** (`ChatPicker.tsx`, D96), never typed: an edge's `reads` and `sends`, a
  connector's `chats`, and each config key a plugin's manifest names (`configChats`:
  `telegram-bot`'s `owner`, `group` and `deny`, the reactor's `chat` and `in`), from the chats of
  its connector (its own node, or the one along the node's chat edge; until that edge is drawn, it
  says to draw it). **A chat named once** (D97): a chat a config key picks for its chat edge is
  written on that edge too (`draft.ts`'s `syncEdgeChats`: its `sends` or `reads`), replaced there
  when the pick changes, the chats added to the edge by hand kept; a new edge starts with the chats
  its node's config names (`edgeOf`), and one from an output that sends to the owner
  (`owner-notice`'s) with its connector's owner's chat, its panel saying so of one left with none.
  `owner-notice` and the turn actor have no chat key: their edges are their only chat setting, the
  turn actor's naming its bot's one chat (its panel says so, and the check). Each chat shows by its
  name, its kind by an icon in a colour of its own (a person, a bot, a group, a channel), a person's
  or a bot's `@username` beside it, and when it was last active (`3 days ago`); the chats picked
  come first; a search finds a chat by its name, its `@username` or its id, and an id is never shown
  for a chat that has a name. What is kept is the name its connector sends to (`Surface.id`; a
  number for a key whose schema is one). A chat saved otherwise (an id, a `@username`) is found by
  any of its names, from the lists or a search for it (`useLookups`), so after a reload too, and
  shown as saved only when no search finds it, with why. A chat its connector says it cannot reach
  shows why (`unreachable`), and so do the chats only another connector of its network lists
  (`peers`: the owner's account knows people and groups a bot never saw); picked, one is first asked
  of the connector, which lists it if it can reach it, else it is picked by its id with why it
  cannot. A key of people to recognise rather than chats to send to (`sender`, `telegram-bot`'s
  `deny`, D100) says nothing of reaching them, picks a peer's person at once by id, and is written
  on no edge. A connector that cannot list its chats at all is the one place a chat is typed. Once
  the draft changes a connector's chats, a reminder beside them says that the edges which should
  read a chat need it ticked too (P6: the edges filter again), naming the chat-in edges with a
  `reads` list that miss a chat added or still read one removed, each a link that opens its panel. A
  connector not running yet says to apply first. A new node starts **disabled** and a new chat-out
  edge a **dry run**: its rhombus hollow and its part from the rhombus to the connector greyed and
  dashed; its panel's **Dry-run / Send for real** switch, and a node's **Enabled** switch, are
  changes of the draft, applied with Apply. A node's config, settings and account are forms made
  from its schemas, each field's description as its help; a new node's config starts filled with its
  schema's defaults, and an opened node shows its unset ones filled in, written with its first
  change (`defaults.ts`) (`SchemaForm.tsx`, `NodeDetails.tsx`), a config key that names a secret a
  choice of the secrets' names, a connector's secrets listed under its config, each by name, whether
  it is provided (`GET /secrets`) and where it comes from (a Docker secret), never its value, a list
  of strings or numbers as rows of plain fields with add (+) and remove buttons, and a record of
  plain values (the reactor's `when`) as rows of a key and a value, its type picked where several
  are allowed (`ListFields.tsx`); JSON is typed only for what none of these draws. An events edge
  says what it carries (`Payloads.tsx`, #3): each event type and its payload's fields by dotted path
  and type, in its panel, in the title of its rhombus (a line per type), and in the panel of the
  node it enters, under the input (narrowed to the type the reactor's `on` names), for a reaction's
  `when` and `send` paths. Its outputs say what they carry (docs/bot-os.md D71): an events output
  its event types, each with its description; an interface output its members, folded, each with its
  signature (`signature.ts`) and help when opened. A node up that keeps a state (docs/bot-os.md D72)
  has a **State** section, drawn from its schema alone (`StateViewer.tsx`): its pinned paths first,
  then each section with its freshness; a list of objects as a sortable, searchable table, a map as
  a table of keys and values, an object folded, a value as a labelled line; its card shows a line of
  it. A running connector's panel lists its **Queue** (`Queue.tsx`, D73): each send waiting, until
  when, and the nodes that asked for it with what cancels them, a send several share marked so, and
  the sends coalesced since the start with the pairs of nodes that shared them; a chat-out edge's
  panel sets each command's spacing (`minIntervalS`, empty for the connector's default). Every
  change is checked by the core, and each refusal shown on its edge, port, node or field
  (`draft.ts`, the draft's pure changes); each warning (docs/bot-os.md D89: a chat-in edge reading a
  chat its connector does not monitor), which refuses nothing, in amber and dashed on its edge, its
  port and its node, listed in their panels and the review, and counted in the map's bar
  (`N warnings`), Apply offered all the same; typing in a panel keeps its field focused, and the
  cards and edges that draw as before are kept as drawn (`stable.ts`), so the map does not redraw at
  each keystroke. **Review changes** opens a dialog with the diff and two actions (`Review.tsx`):
  **Apply** saves the graph (`PUT /graph/file`) and restarts the instance on it, waiting for it and
  coming back to the page, still logged in (`src/ui/Restart.tsx`), with a note that says so and goes
  by itself after 30 seconds (or at its **dismiss**), or says why the core refused it and restarts
  nothing; **Revert** drops the draft, back to the graph saved, once confirmed. Its × (or Escape)
  only closes it, the draft kept. When the saved graph is not what runs (changed through the API,
  rolled back, or a restart that did not happen), a banner offers **Apply (restart)**; a saved graph
  refused at the last start is shown first. A **script** node (docs/bot-os.md D76, D78,
  `src/ui/graph/script/`) has its ports in a form in its panel (`ScriptPorts.tsx`), a port renamed
  once its name is typed (left, or Enter; a name empty or taken refused), its edges moved with it in
  the same change, and removed with its row's **Remove**, its edges with it in the same change,
  after a confirmation naming them (docs/bot-os.md D84: several ports of a kind, each its own name),
  and **Edit script** opens its code in Monaco (`ScriptEditor.tsx`, `ScriptCode.tsx`:
  `monaco-editor`, bundled, its chunk loaded only then), typed by a `.d.ts` made from its ports
  (`types.ts`), beside a panel of its API; every key typed there is the editor's (the dialog is out
  of the reach of the map's keys, Space to pan among them), and Escape closes it only when Monaco
  has no use for it, asking first once the code changed; **Keep** is refused while the code does not
  parse; **Export as plugin** (`ExportDialog.tsx`, `export.ts`, docs/bot-os.md D79) downloads it as
  a module's plugin file and its `module.json`. The **Text** tab, on the page's right edge, opens a
  side sheet from the right (sliding, unless the browser asks for reduced motion) with the draft
  printed (`graphText`), read-only, with a copy button (`GraphText.tsx`); the tab rides on the
  sheet's edge and closes it; the rollback is the History page's. Under it, the **Costs** tab opens
  the nodes by cost (`Costs.tsx`, docs/bot-os.md D77: since the start, the CPU a script's worker
  spent running its code or else the time in its handlers, sortable by any column, the top three
  marked), each node's name selecting it. **What belongs to a node is on it** (docs/bot-os.md D111):
  a connector's cards show its connection (`connected`, `connecting`, `closed`, its step on hover)
  and its panel its account as it runs, as whom, and its connection (`GET /accounts`); every node's
  panel says what it costs, its share and whether it is among the top three, and, while it runs, its
  status (read there, so its reads offer no **Read** of it), its settings in force (each set at once
  with its **Set**, as `/set` does in chat, above the form of the settings a fresh instance starts
  with) and its reads and actions, each called with **Read** or **Run**, its input in a form made
  from its schema, its answer under it (`NodeControls.tsx`). **A connector's login** (docs/bot-os.md
  D116): one that logs in from its node (a Telegram one) says `needs login` on its card until it has
  credentials, and its panel, while it runs, shows its **Login** as its connector says it
  (`ConnectorLogin.tsx`, `GET` and `POST /plugins/<id>/login`): a step's title, how-to and link, a
  QR code drawn from its link (`qrcode-generator`, renewed as the login asks again every 2 s while
  under way), its fields (a secret one typed unseen, cleared once sent) and its buttons (a logout
  asking first); once its credentials changed, **Restart now** restarts the instance as Apply does.
  Its Docker secrets show as its fallback, not required. **Widgets and pages** (docs/bot-os.md
  D112): a node whose plugin declares a widget shows it in one line on its card while it runs
  (`Widget.tsx`'s `WidgetLine`, `widget-text.ts`: its fields, a count, a list's first items, a
  table's rows counted, an amount out of its total with a bar, or how long until a time, moving with
  the clock), from `GET /status`'s `widget`, its card a line taller for it; one that declares a page
  has **Open its page** in its panel while it runs, which leads to `#/node/<id>` (`NodePage.tsx`, in
  no menu): the page's sections drawn in full (`WidgetSection`), each read asked every five seconds.
  The map's bar heads with the instance's switches: `instance on` or `off`, **Turn off** (asking
  first) or **Turn on**, and **Kill all** (every plugin's safety stop, asking first). Select one
  node or several (Shift, Ctrl or Cmd with a click; Shift and drag for a box) and **Kill selected**
  kills each: its plugin's own safety stop, then stopped, kept across restarts; a stopped node's
  panel has **Clear stop**, a change of the draft that Review lists and Apply makes (`clear-stop`,
  then the restart), and its forms stay editable. Nodes start in columns (`layout.ts`) and can be
  moved. **Swimlanes** (docs/bot-os.md D69): a node's panel sets its **Group** (none, one of the
  draft's, or **new group…**, named and set), a change of the draft like any other; a draft with
  groups is drawn in lanes (`layout.ts`'s `swimlanes`, `lanes.ts`, `LaneNode.tsx`): the same global
  columns, each group a tinted band with its name at its top left, in the order of its first node,
  the ungrouped nodes in an unlabelled band last, and the connectors' in and out cards outside every
  band, at the left and the right (a connector's group is ignored, which its panel says). A card is
  its lane's child in React Flow, and stays in its lane when dragged. A lane's label zooms to fit
  it; resting on a node dims what it does not reach, and on a lane's label everything outside the
  lane but its edges and the connectors they reach; the minimap tints each lane. Its colour comes
  from a fixed palette, by a hash of its name, the next free one when an earlier lane has it.
  **Modules** (`#/modules`, `ModulesPage.tsx`, docs/bot-os.md D67, D102) lists the modules
  installed, each with its version, its source (a folder upload, a tarball, or a repository on
  GitHub or a self-hosted Git server, linked at its commit) and when it was installed. It installs
  modules from a folder, chosen (**Choose folder**) or dropped on the page, or from a repository's
  link: a public GitHub one (`https://github.com/<owner>/<repo>` or `…/tree/<ref>/<path>`), or one
  on a Git server added under **Git servers** (`GitServers.tsx`: each server with its token's Docker
  secret, picked from `GET /modules/hosts`'s names, added with `POST /modules/hosts`, removed with
  `DELETE /modules/hosts/<host>`), a module's own folder or a repository's that holds several. The
  folder's paths, its `module.json` files and its `.gitignore` files go to `POST /modules/plan`
  (`src/ui/module-folder.ts`), a link to `POST /modules/link`; the modules found, but those under
  `vendor/`, are a checklist (`ModuleChecklist.tsx`): each with its path, version, status against
  the one installed (`new`, `update x → y`, `same version`, `older x → y`), its files and those left
  out (its tests and a folder's `.gitignore`d paths, unless its `module.json` lists `files`), all
  checked but downgrades and those refused. **Install** sends each checked module on its own (a
  folder's files, only that module's, as base64; a repository's module as its source at the commit
  looked up), with its progress (`Installing 2 of 5: dice…`, and an upload's bytes sent, through
  `XMLHttpRequest`, whose upload reports them, D104), and lists how each went; the restart is then
  offered once. A module from a repository with a newer commit that changed its own directory (the
  shell checks every 6 hours, or **Check for updates**; D103) says `update available` with the
  commit and its date, linked to its host's comparison (and, when the host's comparison could not
  tell what changed, says so and why), and **Update** or **Update all** installs it. It also
  installs a `.tar.gz`, picked or dropped on the page (one dropped named, with its size, beside the
  input, which cannot show it), and rolls a module back. **Remove** (D68) asks first, in a dialog
  that names the module, then moves it aside as its previous version (`DELETE /modules/<id>`, sent
  JSON-typed as the server's same-origin rule asks of every change); it is disabled, its reason
  shown beside it on hover, while a node of the saved graph (disabled ones too) uses one of its
  plugins or another module imports it. A module removed is listed as `removed` with **Restore**
  (its rollback) until an install of its id replaces it, and the restart is offered. **History**
  (`#/admin`, `src/ui/pages/AdminPage.tsx`, docs/bot-os.md D59, D111), once Admin, keeps what has no
  node: the graph's history (`#/graph-history`, `GraphHistoryPage.tsx`, docs/bot-os.md D61: each
  version of the saved graph, newest first, with its time, what changed and how the instance started
  on it, the last that ran marked "last good"; one opened shows what rolling back to it would
  change, as the review's diff (**Changes**) and as a line diff of the two printouts (**As text**),
  and **Roll back to this** asks, repeating the diff, then restarts on it; a version the check
  refuses now says why, and has no rollback, D110). Its old sections' routes lead to the editor:
  `#/instance`, `#/accounts` and `#/plugins` to the map, `#/resources` and `#/graph-text` with the
  Costs or the Text sheet open. Beside it, **Drift** (each parser's counts and the latest reports,
  by parser: those of the version it runs, and those of earlier versions folded under one line,
  D113) and **Events** (the event log's latest records, filtered by type). Every page reads the
  control API only; the app imports the core's types and nothing else of it, so its bundle holds
  none of the shell's code. All the pages are in one menu, with no admin part apart: the whole app
  is the owner's console. A page is a line of `PAGES` in `src/ui/App.tsx`; a node's own page
  (`NODE_PAGE`) is in no menu.
- `src/server/web-server.ts`: the UI's own listener. It serves the built app, and the core's control
  API (`controlHandler` of `@megabottron1999/core`) under `/api/`, only to a logged-in owner.
  `startWebUi` starts it only when the `web_ui_password` Docker secret is provided (12 characters at
  least); without it there is no listener at all, and the instance runs as without a UI.
- **A trusted network.** The login is meant for one: behind it, the owner installs modules and edits
  script nodes, code that runs with the bot's accounts. A UI exposed to the internet needs another
  layer of authentication in front of it, such as a reverse proxy with two-factor authentication.
- `src/server/auth.ts`: the login. One owner and one password, compared in constant time; a session
  is a random token in an `HttpOnly`, `SameSite=Strict` cookie, `Secure` when the request came over
  HTTPS (directly or through a proxy's `X-Forwarded-Proto`), lasting 30 days from its login (the
  cookie's `Max-Age` too). The sessions outlive a restart: they are kept in the core's own store,
  `<data>/core/web-sessions.json` (written atomically), as the SHA-256 of each token, never the
  token, beside a salted scrypt fingerprint of the password, never the password. A changed
  `web_ui_password` ends every session at the next start; **Log out** ends that session alone;
  expired ones are pruned. `GET /api/session` also gives the process's `boot` id, by which the page
  tells a restarted instance from the one before. Five failed logins from one address within 15
  minutes, and that address waits; behind a proxy every visitor shares the proxy's address, so the
  limit is the whole instance's.

A POST, a PUT or a DELETE must carry JSON, or no body at all (a bare `POST /api/restart`), and come
from the UI's own origin; the 403 that refuses one says which it missed. Every response carries a
strict Content Security Policy and refuses to be framed.

The app is tested with Vitest on happy-dom and Testing Library, against a fake of the API
(`test/fake-api.ts`; a fake of the editor's routes in `test/fake-core.ts`, on a made-up instance in
`test/graph-view.ts`; and what React Flow needs of a browser in `test/react-flow.ts`);
`src/ui/main.tsx`, which only mounts it, is left out of coverage.

The UI publishes no port of its own on the host: put it behind a reverse proxy with HTTPS (and, if
you like, the proxy's own authentication in front of this login).
