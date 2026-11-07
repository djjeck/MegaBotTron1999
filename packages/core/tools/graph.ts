/**
 * Prints a graph file (docs/bot-os-api.md §2.1, §4.12): the plugin instances and the edges between
 * their ports, as text, or as a Mermaid flowchart with `--mermaid`. The instance writes the graph it
 * runs to `graph.json` in its data volume at each start; `cli.ts graph` prints the running one.
 *
 * Usage: node packages/core/tools/graph.ts [/data/graph.json] [--mermaid]
 */
import { type Graph, graphMermaid, graphSchema, graphText, readGraphFile } from '#src/index.ts';

const args = process.argv.slice(2);
const file =
  args.find((a) => !a.startsWith('--')) ?? `${process.env['LOG_DIR'] || '/data'}/graph.json`;
const parsed = graphSchema.safeParse(readGraphFile(file));
if (!parsed.success) {
  console.error(`${file}: not a graph: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  process.exit(2);
}
const graph: Graph = parsed.data;
console.log(args.includes('--mermaid') ? graphMermaid(graph) : graphText(graph));
