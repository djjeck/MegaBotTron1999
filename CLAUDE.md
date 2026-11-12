# MegaBotTron1999

A plugin-based bot shell for chat networks, with a node-graph web UI: the core, the IRC and Telegram
connectors, the turn plugins, the reactor and the web UI, in one Docker image. It knows no game. See
[README.md](README.md) for the overview.

**This repository is public.** Everything committed here, history included, is readable by anyone.

## Development process

- Implementation is handled by the AI agent; the author reviews and approves each change.
- Each completed sub-task is a self-contained, reviewable change, with tests and documentation
  updated in the same commit. Commit only after the author has reviewed the change.
- **Commit on `main`.** No feature branches unless the author asks for one (bot-os.md D24: the
  author reviews alone, with no branch protection). One logical change per commit; the message says
  why, not only what.
- After each sub-task, stop and wait for the author's approval before the next.

### Read the documentation first

- [README.md](README.md): what the project is, how to run it, how plugins work.
- [docs/bot-os.md](docs/bot-os.md): the principles (P1–P17) and the decisions (D1–D59). Check every
  design choice against them; a choice that breaks one changes the principle there, with its reason,
  or is dropped.
- [docs/bot-os-api.md](docs/bot-os-api.md): the plugin API, as built.
- Each package's README.

### Validate after every edit

```bash
source ~/.nvm/nvm.sh && nvm use && npm run validate
```

`validate` runs the tests with coverage, the type check, ESLint with its autofixes, the formatting
check and the web UI's build. It is for local use; CI (`.github/workflows/ci.yml`) runs
`npm run ci`, the same checks without fixing anything. Run `npm run format` to fix formatting.
Address every error before marking a sub-task complete.

## Rules

- **Docs change in the same commit as the behaviour.** A change to the API, the image, a decision or
  the way to run it updates `docs/bot-os-api.md`, `docs/bot-os.md`, the README or a package's README
  in that commit, not later. A new decision gets the next D number; numbers are never reused.
- **No private data, ever.** No real person's name or handle, no chat or group name, no Telegram or
  other network id, no message quoted from a real chat, no hostname, IP address or domain of
  anyone's network, no registry or server of a private deployment, and no secret of any kind (in
  code, tests, fixtures, docs, comments or commit messages). Use `example.net`, `alice`, `#lobby`,
  `ExampleBot` and made-up bots such as @QuestBot. Before every commit, scan the change for tokens,
  keys, long numbers that could be ids, and names.
- **Test data is synthetic.** Tests and fixtures are made up, never copied from a real chat, log or
  export, and name no real game, bot or person.
- **The shell knows no game.** Nothing here imports, names or depends on a game's code; games and
  automation are modules on top of the shell (bot-os.md D49).
- **Coverage stays at or above 90%** on statements, branches, functions and lines, for the whole and
  for each package's `src/` on its own (`vitest.config.ts` sets a threshold per workspace), so that
  each package's own tests keep it covered.
- **Dependencies:** as few as possible, each justified in the commit that adds it, pinned to exact
  versions at least two weeks old, with `package-lock.json` committed; the same rule for the GitHub
  Actions the workflows use (pinned to an exact release) and for the Node base image. The web UI's
  build tools (React, React DOM, React Flow, Vite) are `@megabottron1999/web`'s own
  `devDependencies`, so that the image's build stage installs them alone; the test and type tools
  stay at the root.
- **Secrets** are Docker secrets (files under `/run/secrets`, `packages/core/src/secrets.ts`), never
  environment variables, and go only to the connector plugin that declares them.
- **People** are referred to as they/them.

## Conventions

- **Language:** English.
- **No build step,** but the web UI's. Node 24 runs the `.ts` sources directly by stripping types,
  and `tsc` only type-checks (`noEmit`). So imports use `.ts` extensions, and only erasable
  TypeScript syntax is allowed (`erasableSyntaxOnly`: no enums, namespaces or constructor parameter
  properties). The exception is the web UI's React app (`packages/web/src/ui/`, `.tsx`): Vite
  bundles it into `packages/web/dist/` (`npm run build`, git-ignored); it has its own
  `tsconfig.json` (DOM, JSX), which `npm run typecheck` checks too.
- **Strict TypeScript,** including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **Workspaces:** npm workspaces under `packages/<name>/`, each `@megabottron1999/<name>`. A package
  has its sources in `src/`, its test helpers in `test/`, its runtime dependencies in its own
  `package.json`, and two kinds of `exports`: `@megabottron1999/<name>/<path under src/>` and
  `@megabottron1999/<name>/test/<path>` (the core's index is `@megabottron1999/core` itself). The
  root holds the workspaces, the dev dependencies, the scripts, the image's entry point
  (`src/main.ts`) and the docs.
- **Boundaries** (bot-os-api.md §6): `packages/core/src/` imports no other package; production code
  never imports test helpers; the web UI's app imports only the core's types. ESLint enforces them.
- **Imports:** ESLint owns their style (sorted in one group, inline `type` specifiers, unused ones
  removed; `npm run lint:fix`). Within a package, import across directories through its own `#src/*`
  and `#test/*` aliases; from another package, by its name; never with `../`.
- **Formatting:** Prettier, for every file it supports, Markdown included, with prose wrapped at 100
  columns.
- **Tests** sit next to the code they test (`foo.ts`, `foo.test.ts`) and run with Vitest. The web
  UI's (`.test.tsx`) run on happy-dom (a `// @vitest-environment happy-dom` line at their top) with
  Testing Library.
- **The image:** one, `megabottron1999` (`Dockerfile`, bot-os.md D49), for `linux/amd64` and
  `linux/arm64`, running `node src/main.ts` as the `node` user from `/app`, with its state in
  `/data`. `docker buildx bake --load` builds it for this machine (`docker-bake.hcl`). CI publishes
  it to `ghcr.io/djjeck/megabottron1999` (`.github/workflows/publish.yml`, D51): `edge` on every
  push to `main`, `<version>` on a pushed tag `v<version>`, and `latest` too unless it is a
  pre-release (`v0.1.0-alpha.1`).
