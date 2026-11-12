/**
 * Loads modules as the instance does (docs/bot-os-api.md §7), outside one: for a module's
 * repository to check that its modules load against this MegaBotTron1999, through the resolve hook,
 * and that their plugins' manifests are valid. Each directory given is a module (its `module.json`
 * and its files), linked into a temporary modules' directory under its id; prints the modules
 * loaded with their plugins and those refused with why, and exits 1 if any is refused.
 *
 * Usage: node packages/core/tools/modules.ts <module dir>...
 *        node packages/core/tools/modules.ts --installed [/data/modules]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core, GRAPH_VERSION, loadModules, MODULE_FILE, wallClock } from '#src/index.ts';

const args = process.argv.slice(2);
let dir: string;
if (args[0] === '--installed') dir = args[1] ?? `${process.env['LOG_DIR'] || '/data'}/modules`;
else {
  if (args.length === 0) {
    console.error('usage: node packages/core/tools/modules.ts <module dir>...');
    process.exit(2);
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modules-'));
  for (const given of args) {
    const at = path.resolve(given);
    const { id } = JSON.parse(fs.readFileSync(path.join(at, MODULE_FILE), 'utf8')) as {
      id: string;
    };
    fs.symlinkSync(at, path.join(dir, id), 'dir');
  }
}
const loaded = await loadModules({ dir, host: import.meta.url });
const core = new Core({
  clock: wallClock(),
  graph: { version: GRAPH_VERSION, nodes: [], edges: [] },
});
for (const m of loaded.modules)
  core.registerModule(
    m.id,
    loaded.plugins.filter((p) => p.module === m.id).map((p) => p.plugin)
  );
core.load();
for (const m of loaded.modules) console.log(`${m.id} ${m.version}: ${m.plugins.join(', ') || '-'}`);
for (const f of loaded.failures) console.log(`${f.id}: refused: ${f.reason}`);
process.exit(loaded.failures.length > 0 ? 1 : 0);
