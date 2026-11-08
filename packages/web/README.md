# @megabottron1999/web

The shell's web UI: the instance's graph, its home page, the owner's admin pages, and the server
that guards them.

- `src/ui/`: a React app, built by Vite (`npm run build`, `vite.config.ts`, `index.html`) into
  `dist/`, the only build step of the shell. Its pages are reached by the URL's hash. The home page
  is the **Graph** (`#/graph`, `src/ui/graph/`), drawn with React Flow (`@xyflow/react`, chosen
  because the editor to come drags edges between ports): each plugin instance is a node with its
  input ports on the left and its output ports on the right, each port type in its own shape and
  colour (a legend says which), each binding an edge in its type's colour, dashed when the input is
  optional; each node shows its state, its mode and its parser's drift, polled. Selecting a node
  shows its details: its config and its settings in read-only forms generated from their JSON
  Schemas (`SchemaForm.tsx`), and the ports, reads, actions and commands it declares. Select one
  node or several (Shift, Ctrl or Cmd with a click; Shift and drag for a box) and **Kill selected**
  kills each: its plugin's own safety stop, then paused until reinstated. A killed node is drawn
  disabled, with a **Reinstate** button on it; its forms stay as they were. Nodes start in columns
  (`layout.ts`), each one past what feeds it, and can be moved. The admin pages are a secondary menu
  (Admin), one per area: **Instance** (on or off with its switch, uptime, memory, the plugins and
  accounts by state, the kill switch), **Accounts** (each connector, its account and its
  connection's status), **Plugins** (each plugin instance with its state, a mode control, a resume
  when paused, and, opened, its settings, its own status and the reads and actions it declares),
  **Drift** (each parser's counts and the latest reports) and **Events** (the event log's latest
  records, filtered by type). Every page reads the control API only; the app imports the core's
  types and nothing else of it, so its bundle holds none of the shell's code. A page is a line of
  `PAGES` in `src/ui/App.tsx`.
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
(`test/fake-api.ts`, with a made-up instance for the graph in `test/graph-view.ts`, and what React
Flow needs of a browser in `test/react-flow.ts`); `src/ui/main.tsx`, which only mounts it, is left
out of coverage.

The UI publishes no port of its own on the host: put it behind a reverse proxy with HTTPS (and, if
you like, the proxy's own authentication in front of this login).
