# @megabottron1999/web

The shell's web UI, the owner's console: the instance's graph, its home page, the other pages, and
the server that guards them.

- `src/ui/`: a React app, built by Vite (`npm run build`, `vite.config.ts`, `index.html`) into
  `dist/`, the only build step of the shell. Its pages are reached by the URL's hash, as tabs across
  a top bar, the tab selected being the page's title; a bottom bar holds small print, such as
  diagnostics (its slot is empty for now); both bars stay, and only the page between them scrolls.
  The home page is the **Graph** (`#/graph`, `src/ui/graph/`), the graph editor (docs/bot-os.md
  D55), drawn with React Flow (`@xyflow/react`): a draft of the saved graph, each plugin instance a
  node with its input ports on the left and its output ports on the right, each port type in its own
  shape and colour, each binding an edge in its type's colour, dashed when the input is optional,
  and on each node its state and drift (docs/bot-os.md D64): disabled, greyed; stopped, in red tones
  with a warning icon and its reason; inactive, greyed with the node it needs. The page is the map,
  filling the area between the bars: its minimap at the top right; what the draft needs (**Review
  changes**, the problems, the selection and **Kill selected**) at the top left; the zoom controls
  and the legend at the bottom left; and **Add a node**, a floating "+" button, at the bottom right.
  The panel of what is selected opens beside the map (below it on a phone). Chats flow left to right
  (docs/bot-os.md D60): a connector is drawn as two cards (`cards.ts`), its **in** card
  (`telegram-user · in`) at the left, whose chat-in output feeds the readers, and its **out** card
  (`telegram-user · out`) in a column of its own at the right, whose chat-out input takes the
  senders' edges; one node in the graph file all the same. Each card is placed on its own, either
  selects the node and opens its panel, and removing it removes both, after a confirmation that
  names them. An empty graph offers its first node, a connector. **Add a node** lists the plugins
  offered, by the image and each module (`Palette.tsx`), and asks its id and its instance: fresh,
  kept, or imported from an older data directory (`AddNode.tsx`). An edge is dragged from an output
  to an input; a rhombus at its midpoint, in its port type's colour (`PortEdge.tsx`), is a button
  that selects it and opens its panel (`EdgeDetails.tsx`), where a chat-in edge's `reads` (or all
  the chats its connector monitors) and its `senders` (anyone, or a list with _me_), or a chat-out
  edge's `sends` and `commands`, are set, the chats ticked among its connector's monitored chats and
  the words as rows (`Surfaces.tsx`, D62, D63); a connector's own `chats`, what it monitors, are
  ticked from its surfaces, with a search. A connector not running yet says to apply first. A new
  node starts **disabled** and a new chat-out edge a **dry run**: its rhombus hollow and its part
  from the rhombus to the connector greyed and dashed; its panel's **Dry-run / Send for real**
  switch, and a node's **Enabled** switch, are changes of the draft, applied with Apply. A node's
  config, settings and account are forms made from its schemas, each field's description as its
  help; a new node's config starts filled with its schema's defaults, and an opened node shows its
  unset ones filled in, written with its first change (`defaults.ts`) (`SchemaForm.tsx`,
  `NodeDetails.tsx`), a config key that names a secret a choice of the secrets' names. Its outputs
  say what they carry (docs/bot-os.md D71): an events output its event types, each with its
  description; an interface output its members, folded, each with its signature (`signature.ts`) and
  help when opened. Every change is checked by the core, and each refusal shown on its edge, port,
  node or field (`draft.ts`, the draft's pure changes). **Review changes** opens a dialog with the
  diff and two actions (`Review.tsx`): **Apply** saves the graph (`PUT /graph/file`) and restarts
  the instance on it, waiting for it and coming back to the page, still logged in
  (`src/ui/Restart.tsx`), or says why the core refused it and restarts nothing; **Revert** drops the
  draft, back to the graph saved, once confirmed. Its × (or Escape) only closes it, the draft kept.
  When the saved graph is not what runs (changed through the API, rolled back, or a restart that did
  not happen), a banner offers **Apply (restart)**; a saved graph refused at the last start is shown
  first. The **Text** tab, on the page's right edge, opens a side sheet from the right (sliding,
  unless the browser asks for reduced motion) with the draft printed (`graphText`), read-only, with
  a copy button (`GraphText.tsx`); the tab rides on the sheet's edge and closes it; the rollback is
  Admin's, with the history. Select one node or several (Shift, Ctrl or Cmd with a click; Shift and
  drag for a box) and **Kill selected** kills each: its plugin's own safety stop, then stopped, kept
  across restarts; a stopped node's panel has **Clear stop**, a change of the draft that Review
  lists and Apply makes (`clear-stop`, then the restart), and its forms stay editable. Nodes start
  in columns (`layout.ts`) and can be moved. **Swimlanes** (docs/bot-os.md D69): a node's panel sets
  its **Group** (none, one of the draft's, or **new group…**, named and set), a change of the draft
  like any other; a draft with groups is drawn in lanes (`layout.ts`'s `swimlanes`, `lanes.ts`,
  `LaneNode.tsx`): the same global columns, each group a tinted band with its name at its top left,
  in the order of its first node, the ungrouped nodes in an unlabelled band last, and the
  connectors' in and out cards outside every band, at the left and the right (a connector's group is
  ignored, which its panel says). A card is its lane's child in React Flow, and stays in its lane
  when dragged. A lane's label zooms to fit it; resting on a node dims what it does not reach, and
  on a lane's label everything outside the lane but its edges and the connectors they reach; the
  minimap tints each lane. Its colour comes from a fixed palette, by a hash of its name, the next
  free one when an earlier lane has it. **Modules** (`#/modules`, `ModulesPage.tsx`, docs/bot-os.md
  D67) lists the modules installed, each with its version, its source (a folder upload, a tarball,
  or a GitHub repository linked at its commit) and when it was installed. It installs modules from a
  folder, chosen (**Choose folder**) or dropped on the page, or from a public GitHub link
  (`https://github.com/<owner>/<repo>` or `…/tree/<ref>/<path>`): a module's own folder or a
  repository's that holds several. The folder's paths and its `module.json` files go to
  `POST /modules/plan` (`src/ui/module-folder.ts`), a link to `POST /modules/github`; the modules
  found, but those under `vendor/`, are a checklist (`ModuleChecklist.tsx`): each with its path,
  version, status against the one installed (`new`, `update x → y`, `same version`, `older x → y`),
  its files and those left out (its tests, unless its `module.json` lists `files`), all checked but
  downgrades and those refused. **Install** sends each checked module on its own (a folder's files,
  only that module's, as base64; a GitHub module as its source at the commit looked up), with its
  progress, and lists how each went; the restart is then offered once. A module from GitHub with a
  newer commit (the shell checks every 6 hours, or **Check for updates**) says `update available`
  with the commit and its date, linked to GitHub's comparison, and **Update** or **Update all**
  installs it. It also installs a `.tar.gz` and rolls a module back. **Remove** (D68) asks first, in
  a dialog that names the module, then moves it aside as its previous version
  (`DELETE /modules/<id>`, sent JSON-typed as the server's same-origin rule asks of every change);
  it is disabled, its reason shown beside it on hover, while a node of the saved graph (disabled
  ones too) uses one of its plugins or another module imports it. A module removed is listed as
  `removed` with **Restore** (its rollback) until an install of its id replaces it, and the restart
  is offered. **Import** (`#/import`) shows an older data directory and imports its event log with a
  table of type renames. **Admin** (`#/admin`, `src/ui/pages/AdminPage.tsx`, docs/bot-os.md D59) has
  one section per area, each reached by its route (`#/instance`, `#/graph-history`, `#/graph-text`,
  `#/accounts`, `#/plugins`), which opens the page scrolled to it: **Instance** (on or off with its
  switch, uptime, memory, the plugins and accounts by state, the kill switch), **Graph history**
  (`GraphHistoryPage.tsx`, docs/bot-os.md D61: each version of the saved graph, newest first, with
  its time, what changed and how the instance started on it, the last that ran marked "last good";
  one opened shows what rolling back to it would change, as the review's diff (**Changes**) and as a
  line diff of the two printouts (**As text**), and **Roll back to this** asks, repeating the diff,
  then restarts on it), **Graph as text** (the saved graph printed, with a copy button),
  **Accounts** (each connector, its account and its connection's status) and **Plugins** (each
  plugin instance with its state, read-only (its reason and its stop), and, opened, its settings,
  its own status and the reads and actions it declares). Beside it, **Drift** (each parser's counts
  and the latest reports) and **Events** (the event log's latest records, filtered by type). Every
  page reads the control API only; the app imports the core's types and nothing else of it, so its
  bundle holds none of the shell's code. All the pages are in one menu, with no admin part apart:
  the whole app is the owner's console. A page is a line of `PAGES` in `src/ui/App.tsx`.
- `src/server/web-server.ts`: the UI's own listener. It serves the built app, and the core's control
  API (`controlHandler` of `@megabottron1999/core`) under `/api/`, only to a logged-in owner.
  `startWebUi` starts it only when the `web_ui_password` Docker secret is provided (12 characters at
  least); without it there is no listener at all, and the instance runs as without a UI.
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

A POST, a PUT or a DELETE must carry JSON (a DELETE its type alone) and come from the UI's own
origin. Every response carries a strict Content Security Policy and refuses to be framed.

The app is tested with Vitest on happy-dom and Testing Library, against a fake of the API
(`test/fake-api.ts`; a fake of the editor's routes in `test/fake-core.ts`, on a made-up instance in
`test/graph-view.ts`; and what React Flow needs of a browser in `test/react-flow.ts`);
`src/ui/main.tsx`, which only mounts it, is left out of coverage.

The UI publishes no port of its own on the host: put it behind a reverse proxy with HTTPS (and, if
you like, the proxy's own authentication in front of this login).
