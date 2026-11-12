/**
 * A fake of the core's control API for the graph editor's tests (`test/fake-api.ts` underneath):
 * the saved graph file, a check that refuses what `refuse` says (and prints the draft: its node ids,
 * a line each), a save, the instances kept, the secrets' names, an older data directory, and a restart, after
 * which a new process answers, the session kept. Synthetic: made-up plugins (`test/graph-view.ts`).
 */
import {
  type AvailablePlugin,
  type Graph,
  type GraphProblem,
  type InstanceInfo,
  type LegacyReport,
  type Status,
} from '#src/ui/api.ts';
import { type Answer, type FakeApi, fakeApi } from './fake-api.ts';
import { AVAILABLE, DRIFT, status, VIEW } from './graph-view.ts';

export interface FakeCore {
  api: FakeApi;
  /** The saved file's graph. */
  file: Graph | undefined;
  /** What the running instance runs, for `differs`. */
  running: Graph;
  restarted: boolean;
  /** The graphs checked, in order. */
  checked: Graph[];
}

const ids = (g: Graph | undefined): string[] => (g?.nodes ?? []).map((n) => n.id);
const ends = (g: Graph | undefined): string[] => (g?.edges ?? []).map((e) => `${e.from}|${e.to}`);
const pair = (k: string) => {
  const [from = '', to = ''] = k.split('|');
  return { from, to };
};

export function fakeCore(
  o: {
    file?: Graph | undefined;
    refuse?: (g: Graph) => GraphProblem[];
    available?: AvailablePlugin[];
    instances?: InstanceInfo[];
    legacy?: LegacyReport;
    status?: Status;
    routes?: Record<string, Answer>;
  } = {}
): FakeCore {
  const refuse = o.refuse ?? (() => []);
  const core: FakeCore = {
    api: fakeApi({}),
    file: 'file' in o ? o.file : VIEW.graph,
    running: VIEW.graph,
    restarted: false,
    checked: [],
  };
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const instances = o.instances ?? [];
  Object.assign(core.api.routes, {
    'GET /graph/view': [200, VIEW],
    'GET /status': () => [200, o.status ?? status()],
    'GET /drift': [200, DRIFT],
    'GET /available': [200, o.available ?? AVAILABLE],
    'GET /instances': () => [200, instances],
    'GET /secrets': [200, { names: ['chat_password', 'token_a', 'token_b'] }],
    'GET /graph/file': () => [
      200,
      core.file === undefined
        ? { exists: false, differs: core.running.nodes.length > 0 }
        : { exists: true, graph: core.file, differs: !same(core.file, core.running) },
    ],
    'POST /graph/check': (body) => {
      const g = body as Graph;
      core.checked.push(g);
      const problems = refuse(g);
      const [a, b] = [ids(core.file), ids(g)];
      const [x, y] = [ends(core.file), ends(g)];
      return [
        200,
        {
          ok: problems.length === 0,
          problems,
          text: `nodes:\n${g.nodes.map((n) => `  ${n.id} (${n.plugin})\n`).join('')}edges:`,
          diff: {
            nodes: {
              added: b.filter((id) => !a.includes(id)),
              removed: a.filter((id) => !b.includes(id)),
              changed: g.nodes
                .filter((n) => {
                  const old = core.file?.nodes.find((m) => m.id === n.id);
                  return old !== undefined && !same(old, n);
                })
                .map((n) => ({ id: n.id, fields: ['config'] })),
            },
            edges: {
              added: y.filter((k) => !x.includes(k)).map(pair),
              removed: x.filter((k) => !y.includes(k)).map(pair),
              changed: [],
            },
          },
        },
      ];
    },
    'PUT /graph/file': (body) => {
      const g = body as Graph;
      const problems = refuse(g);
      if (problems.length > 0) return [400, { error: 'the graph is refused', problems }];
      core.file = g;
      return [200, { saved: true, restart: !same(g, core.running) }];
    },
    'POST /instances/import': (body) => {
      const b = body as { from: string; instance: string; plugin: string };
      if (instances.some((i) => i.id === b.instance))
        return [409, { error: `the instance ${b.instance} exists already` }];
      instances.push({ id: b.instance, plugin: b.plugin, created: 1, referenced: 1, used: false });
      return [200, { instance: b.instance, plugin: b.plugin, documents: ['state'] }];
    },
    'GET /legacy':
      o.legacy === undefined
        ? [404, { error: 'no older data directory is mounted at /legacy' }]
        : [200, o.legacy],
    'POST /restart': () => {
      core.restarted = true;
      return [200, { restarting: true }];
    },
    // The session outlives a restart (it is kept in the data volume); the process's id changes.
    'GET /session': () => [
      200,
      { authenticated: true, boot: core.restarted ? 'boot-2' : 'boot-1' },
    ],
    ...o.routes,
  } satisfies Record<string, Answer>);
  return core;
}
