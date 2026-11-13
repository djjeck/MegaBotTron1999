import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/** The workspace packages (package.json `workspaces`, one level of `group/*`). */
export function workspaces(root = import.meta.dirname): string[] {
  const groups = (
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { workspaces: string[] }
  ).workspaces.map((w) => w.replace(/\/\*$/u, ''));
  return groups.flatMap((g) =>
    fs.existsSync(path.join(root, g))
      ? fs
          .readdirSync(path.join(root, g))
          .filter((d) => fs.existsSync(path.join(root, g, d, 'package.json')))
          .map((d) => `${g}/${d}`)
      : []
  );
}

const PER_PACKAGE = { statements: 90, branches: 90, functions: 90, lines: 90 };

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', ...workspaces().map((w) => `${w}/src/**/*.{ts,tsx}`)],
      // The container's entry point and the web UI's mount in the browser are wiring (network,
      // clock, files, the DOM's root); what they call is tested.
      // A script node's worker thread is plumbing V8's coverage does not reach; its runtime is
      // tested in the main thread, and it through the worker's tests.
      exclude: [
        '**/*.test.{ts,tsx}',
        'packages/web/src/ui/main.tsx',
        'src/main.ts',
        'packages/turns/src/script-worker.ts',
      ],
      // The rule holds for the whole and for each package (CLAUDE.md), so that a package's own
      // tests keep it covered on its own.
      thresholds: {
        ...PER_PACKAGE,
        ...Object.fromEntries(workspaces().map((w) => [`${w}/src/**/*.{ts,tsx}`, PER_PACKAGE])),
      },
    },
  },
});
