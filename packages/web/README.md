# @megabottron1999/web

The shell's web UI: the instance's graph, its home page, the owner's admin pages, and the server
that guards them.

- `src/ui/`: a React app, built by Vite (`npm run build`, `vite.config.ts`, `index.html`) into
  `dist/`, the only build step of the shell. Its pages are reached by the URL's hash. The home page
  is the **Graph** (`#/graph`, `src/ui/graph/`), the graph editor (docs/bot-os.md D55), drawn with
  React Flow (`@xyflow/react`): a draft of the saved graph, each plugin instance a node with its
  input ports on the left and its output ports on the right, each port type in its own shape and
  colour, each binding an edge in its type's colour, dashed when the input is optional, and on each
  node its live state, mode and drift. An empty graph offers its first node, a connector. **Add a
  node** lists the plugins offered, by the image and each module (`Palette.tsx`), and asks its id
  and its instance: fresh, kept, or imported from an older data directory (`AddNode.tsx`). An edge
  is dragged from an output to an input; a chat edge's chats and commands are set in its panel
  (`EdgeDetails.tsx`). A node's config, settings, mode and account are forms made from its schemas
  (`SchemaForm.tsx`, `NodeDetails.tsx`), a config key that names a secret a choice of the secrets'
  names. Every change is checked by the core, and each refusal shown on its edge, port, node or
  field (`draft.ts`, the draft's pure changes). **Review changes** shows the diff, **Save** writes
  the file, **Apply (restart)** restarts the instance and waits for it (`src/ui/Restart.tsx`),
  **Roll back** puts the previous file back; a saved graph refused at the last start is shown first.
  Select one node or several (Shift, Ctrl or Cmd with a click; Shift and drag for a box) and **Kill
  selected** kills each: its plugin's own safety stop, then paused until reinstated; a killed node
  is drawn disabled, with a **Reinstate** button, and its forms stay editable. Nodes start in
  columns (`layout.ts`) and can be moved. **Modules** (`#/modules`) lists the modules installed,
  installs a `.tar.gz` and rolls one back; **Import** (`#/import`) shows an older data directory and
  imports its event log with a table of type renames. The admin pages are a secondary menu (Admin),
  one per area: **Instance** (on or off with its switch, uptime, memory, the plugins and accounts by
  state, the kill switch), **Accounts** (each connector, its account and its connection's status),
  **Plugins** (each plugin instance with its state, a mode control, a resume when paused, and,
  opened, its settings, its own status and the reads and actions it declares), **Drift** (each
  parser's counts and the latest reports) and **Events** (the event log's latest records, filtered
  by type). Every page reads the control API only; the app imports the core's types and nothing else
  of it, so its bundle holds none of the shell's code. A page is a line of `PAGES` in
  `src/ui/App.tsx`.
- `src/server/web-server.ts`: the UI's own listener. It serves the built app, and the core's control
  API (`controlHandler` of `@megabottron1999/core`) under `/api/`, only to a logged-in owner.
  `startWebUi` starts it only when the `web_ui_password` Docker secret is provided (12 characters at
  least); without it there is no listener at all, and the instance runs as without a UI.
- `src/server/auth.ts`: the login. One owner and one password, compared in constant time; a session
  is a random token kept in memory (a restart logs out), in an `HttpOnly`, `SameSite=Strict` cookie,
  `Secure` when the request came over HTTPS (directly or through a proxy's `X-Forwarded-Proto`).
  Five failed logins from one address within 15 minutes, and that address waits; behind a proxy
  every visitor shares the proxy's address, so the limit is the whole instance's.

A POST or a PUT must carry JSON and come from the UI's own origin. Every response carries a strict
Content Security Policy and refuses to be framed.

The app is tested with Vitest on happy-dom and Testing Library, against a fake of the API
(`test/fake-api.ts`; a fake of the editor's routes in `test/fake-core.ts`, on a made-up instance in
`test/graph-view.ts`; and what React Flow needs of a browser in `test/react-flow.ts`);
`src/ui/main.tsx`, which only mounts it, is left out of coverage.

The UI publishes no port of its own on the host: put it behind a reverse proxy with HTTPS (and, if
you like, the proxy's own authentication in front of this login).
