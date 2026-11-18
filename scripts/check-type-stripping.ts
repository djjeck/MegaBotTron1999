// Checks that Node parses every TypeScript file the image can run, the way the image runs it: the
// image starts `node src/main.ts` with no flag, so Node strips the types (strip-only mode, which
// rejects enums, namespaces and parameter properties) and V8 parses what is left as a module.
// Vitest compiles with esbuild, which accepts more: `private declare(v)` passed the tests, but
// Node's stripping read `declare` as TypeScript's modifier and 0.1.42 failed to start.
//
// Nothing is executed: each file goes through `node:module`'s stripTypeScriptTypes, the same
// transform the loader applies, and its output through `vm.SourceTextModule`, which parses a
// module without linking or evaluating it (hence `--experimental-vm-modules`).
//
//   node --experimental-vm-modules scripts/check-type-stripping.ts [--exact]
//
// The image's Node is the Dockerfile's base image; a different version only warns, unless
// `--exact` (CI runs it so, on the image's version), which fails then.
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const exact = process.argv.includes('--exact');

/** What the image copies and can run: the entry point and the packages. */
const SCAN = ['src', 'packages'];
/** Never run by Node: dependencies and Vite's output (the React app's `.tsx`, which Vite bundles,
 * is left out by its extension). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);
/** Vitest's, which esbuild compiles. */
const TEST = /\.test\.m?ts$/u;
const TS = /\.m?ts$/u;

const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const problems: string[] = [];

// The stripping mode is the start command's: refuse to vouch for one this check does not mirror.
const cmd = /^CMD\s+(.+)$/mu.exec(dockerfile)?.[1];
const argv = cmd === undefined ? undefined : (JSON.parse(cmd) as unknown);
if (
  !Array.isArray(argv) ||
  argv.length !== 2 ||
  argv[0] !== 'node' ||
  /^-/u.test(String(argv[1])) ||
  /NODE_OPTIONS/u.test(dockerfile)
) {
  problems.push(
    `Dockerfile: the start command is no longer a flagless \`node <file>\` (${cmd ?? 'no CMD'}), ` +
      'or NODE_OPTIONS is set: update this check to the mode the image uses.'
  );
}

const imageNode = /^FROM node:(\d+\.\d+\.\d+)\S*\s+AS base$/mu.exec(dockerfile)?.[1];
if (imageNode === undefined) {
  problems.push("Dockerfile: no `FROM node:<x.y.z>… AS base` to read the image's Node from.");
} else if (imageNode !== process.versions.node) {
  const note = `Node ${process.versions.node} here, ${imageNode} in the image`;
  if (exact) problems.push(`${note}: run this check on the image's version.`);
  else console.warn(`check-type-stripping: ${note}; CI checks on the image's version.`);
}

function* sources(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sources(file);
    } else if (TS.test(entry.name) && !TEST.test(entry.name)) {
      yield file;
    }
  }
}

let count = 0;
for (const top of SCAN) {
  for (const file of sources(path.join(root, top))) {
    count++;
    const name = path.relative(root, file);
    try {
      const js = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' });
      new vm.SourceTextModule(js, { identifier: name });
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-type-stripping: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-type-stripping: Node ${process.versions.node} parses all ${count} files.`);
