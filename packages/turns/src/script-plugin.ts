/**
 * The script node (docs/bot-os.md D76, docs/bot-os-api.md §5): a node whose logic is TypeScript
 * the owner types in the web UI, for quick logic tried live; logic that proves itself is exported
 * as a module's plugin (D79). A peer of the reactor and the state plugins:
 *
 * - **Its ports are its config's** (D74): events inputs (the namespaces it hears), interface inputs
 *   (the members it uses), chat-out outputs (with the commands they send, and their spacing), and,
 *   optionally, event types of its own, in its node's namespace (its id). Its node's manifest is
 *   made from them, so the check, the edges, the dry runs, the drift, the queue and the editor
 *   know them as any plugin's.
 * - **Its code** is TypeScript with its types stripped (Node's, as the repository's sources are),
 *   run in a `vm` context holding the script API alone (`script-runtime.ts`): `on`, `use`,
 *   `outbox`/`enqueue`, `publish`, `store`, `clock` and `log`, as the plugin context has them. A
 *   config whose code does not parse is refused by the check.
 * - **Isolation:** in an instance, each node's script runs in a worker thread of its own, with its
 *   memory limited (`resourceLimits`) and a time limit on each handler's run; a script that holds
 *   its thread past it, runs out of memory or crashes is killed, and its node failed with why
 *   (`ctx.fail`), the instance up. Its calls to the main thread (interfaces, the queue, its store,
 *   its events, its log) are messages. In the dev kit (`isolation: 'in-process'`), the same
 *   runtime runs in the main thread on the kit's virtual clock, so that tests and simulations stay
 *   deterministic: each handler's synchronous run is limited still, its memory not.
 * - **It reaches** its node's ports, its own store, its queue, the clock and a logger: never a
 *   secret, nor the files, nor the network. The `vm` context is no security boundary: the code is
 *   the owner's own (D28, D75).
 */
import {
  definePlugin,
  type Instance,
  type ManifestInput,
  type Plugin,
  type PluginContext,
  type PluginInterface,
  type QueuedSend,
} from '@megabottron1999/core';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import {
  type CallEnd,
  type ScriptBridge,
  type ScriptCancel,
  ScriptRuntime,
  ScriptTimeout,
  type SendOutcome,
} from './script-runtime.ts';
import { type FromHost, type FromWorker, type WorkerData } from './script-worker-messages.ts';

export const SCRIPT = 'script';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const NETWORK = /^[a-z][a-z0-9-]*$/u;
const MEMBER = /^(?:state|actions)\.[a-z][A-Za-z0-9_]*$/u;
const EVENT_NAME = /^[a-z][A-Za-z0-9]*$/u;
const FIELD = /^[A-Za-z_$][\w$]*$/u;

/** The code a new script node starts with: comments only, which load and do nothing. */
export const SCRIPT_TEMPLATE = `// A script node: declare its ports in its panel, then register handlers here.
// The API panel lists this node's ports, members and event types; Export makes it a plugin.
//
// on('<namespace>.<event>', async (event) => {
//   const n = await use('<port>').state.<read>({ /* its input */ });
//   enqueue('<port>', '<chat>', '/<command> …', { cancel: { on: '<namespace>.<event>', withinMs: 60_000 } });
// });
`;

/** The types a field of an event of its own may have. */
export const FIELD_TYPES = ['string', 'number', 'boolean', 'unknown'] as const;

/** Why a script's code does not parse, or undefined: its types stripped, then compiled. */
export function codeProblem(code: string): string | undefined {
  let js: string;
  try {
    js = strip(code);
  } catch (e) {
    return `does not parse: ${message(e)}`;
  }
  try {
    new vm.Script(`(async () => {\n${js}\n})()`, { filename: 'script.ts', lineOffset: -1 });
  } catch (e) {
    const at = /^script\.ts:(\d+)/u.exec(e instanceof Error ? (e.stack ?? '') : '')?.[1];
    return `does not parse: ${message(e)}${at === undefined ? '' : ` (line ${at})`}`;
  }
  return undefined;
}

/** TypeScript to JavaScript, its types stripped, every position kept. */
function strip(code: string): string {
  return stripTypeScriptTypes(code, { mode: 'strip' });
}

const help = z.string().min(1).optional().describe('What it is for, shown with the port');

/** A script node's config: its ports, its own events, its code and its limits. */
export const scriptConfig = z.object({
  inputs: z
    .record(
      z.string().regex(ID, 'expected lower-case words and dashes'),
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('events'),
          namespace: z
            .string()
            .regex(ID, 'expected a namespace')
            .describe('The namespace it hears'),
          optional: z.boolean().default(false).describe('It may be left unbound'),
          help,
        }),
        z.object({
          type: z.literal('interface'),
          plugin: z
            .string()
            .regex(ID, 'expected a plugin id')
            .optional()
            .describe('The plugin whose interface it uses; none: any whose interface has them'),
          members: z
            .array(z.string().regex(MEMBER, 'expected state.<name> or actions.<name>'))
            .min(1)
            .describe('The members it uses: state.get, actions.sent'),
          optional: z.boolean().default(false).describe('It may be left unbound'),
          help,
        }),
      ])
    )
    .default({})
    .describe('Its inputs, by port: the events it hears, the interfaces it uses'),
  outputs: z
    .record(
      z.string().regex(ID, 'expected lower-case words and dashes'),
      z.object({
        type: z.literal('chat-out'),
        network: z.string().regex(NETWORK).optional().describe('The network; none: any'),
        commands: z
          .array(z.string().regex(/^\S+$/u, 'expected a command, its first word'))
          .min(1)
          .describe('The commands it sends, by their first word: /look'),
        minIntervalS: z
          .record(z.string().min(1), z.number().nonnegative())
          .optional()
          .describe('The least seconds between two sends of a command in a chat'),
        help,
      })
    )
    .default({})
    .describe('Its chat-out outputs, by port: what it sends, through which account'),
  events: z
    .record(
      z.string().regex(EVENT_NAME, 'expected a name such as itemExamined'),
      z.object({
        help: z.string().min(1).describe('What the event says'),
        fields: z
          .record(z.string().regex(FIELD, 'expected a field name'), z.enum(FIELD_TYPES))
          .default({})
          .describe('Its payload’s fields, each with its type'),
      })
    )
    .default({})
    .describe('Event types of its own, published as <its id>.<name>'),
  code: z
    .string()
    .default(SCRIPT_TEMPLATE)
    .superRefine((code, c) => {
      const why = codeProblem(code);
      if (why !== undefined) c.addIssue({ code: 'custom', message: why });
    })
    .describe('Its TypeScript, its handlers registered with on()'),
  limits: z
    .object({
      callMs: z
        .number()
        .int()
        .min(10)
        .max(60_000)
        .default(1000)
        .describe('How long a handler may hold its thread at a stretch, in milliseconds'),
      memoryMb: z
        .number()
        .int()
        .min(16)
        .max(2048)
        .default(64)
        .describe('Its worker’s heap, in megabytes'),
    })
    .default({ callMs: 1000, memoryMb: 64 })
    .describe('What it may take: past either, it is killed and its node failed'),
});
export type ScriptConfig = z.output<typeof scriptConfig>;

const BASE: ManifestInput = {
  id: SCRIPT,
  version: '0.1.0',
  kinds: ['actor'],
  description: 'Runs TypeScript typed in the editor, on the ports its config declares',
  config: scriptConfig,
  audit: ['code'],
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const recordOf = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** The zod schema of an event of its own, from its fields. */
function payloadOf(e: { help?: unknown; fields?: unknown }): z.ZodType {
  const types = {
    string: z.string(),
    number: z.number(),
    boolean: z.boolean(),
    unknown: z.unknown(),
  };
  const shape = Object.fromEntries(
    Object.entries(recordOf(e.fields)).map(([k, t]) => [
      k,
      types[
        (FIELD_TYPES as readonly unknown[]).includes(t) ? (t as keyof typeof types) : 'unknown'
      ],
    ])
  );
  const schema = z.object(shape);
  return typeof e.help === 'string' && e.help !== '' ? schema.describe(e.help) : schema;
}

/**
 * A script node's own manifest (D74), from its config (as written, when its schema refuses it)
 * and its id: its inputs and outputs as declared, its events in its own namespace, an `actor`
 * when it sends.
 */
export function scriptManifest(
  config: Readonly<Record<string, unknown>>,
  id: string
): ManifestInput {
  const outputs = recordOf(config['outputs']);
  const events = recordOf(config['events']);
  return {
    ...BASE,
    kinds: Object.keys(outputs).length > 0 ? ['actor'] : ['stats'],
    inputs: recordOf(config['inputs']) as ManifestInput['inputs'],
    outputs: outputs as ManifestInput['outputs'],
    games: { registers: Object.keys(events).length > 0 ? [id] : [] },
    events: Object.fromEntries(
      Object.entries(events).map(([name, e]) => [`${id}.${name}`, payloadOf(recordOf(e))])
    ),
  };
}

export interface ScriptPluginOptions {
  /**
   * Where scripts run: each in a worker thread of its own (`worker`, an instance's), or in the main
   * thread (`in-process`, the dev kit's, deterministic on its virtual clock).
   */
  isolation?: 'worker' | 'in-process';
}

/** How often a worker's CPU and heap are sampled. */
const SAMPLE_MS = 5000;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A script, as its host runs it: in a worker, or in the main thread. */
interface Runner {
  /** Loads the script: the patterns its handlers hear; refused with why. */
  load(): Promise<string[]>;
  /** Its thread's CPU time and heap, as last sampled (a worker's; none in the main thread). */
  usage(): { cpuMs?: number; heapBytes?: number };
  dispatch(pattern: string, event: unknown): void;
  close(): Promise<void>;
}

/** The script plugin: one node per script, each with its own ports, code and limits. */
export function scriptPlugin(options: ScriptPluginOptions = {}): Plugin {
  const isolation = options.isolation ?? 'worker';
  return definePlugin({
    // Its inputs are its config's: an edge dropped on it from an output it has no input for adds
    // one there (D80).
    manifest: {
      ...BASE,
      node: scriptManifest,
      configInputs: { key: 'inputs', types: ['events', 'interface'] },
    },
    create: (ctx): Instance => {
      const c = ctx.config as ScriptConfig;
      const stats = { calls: 0, errors: 0, ms: 0, maxMs: 0 };
      let failed = false;
      const fail = (why: string): void => {
        if (failed) return;
        failed = true;
        ctx.fail(why);
      };
      const ended = (end: CallEnd): void => {
        stats.calls += 1;
        stats.ms += end.ms;
        stats.maxMs = Math.max(stats.maxMs, end.ms);
        if (end.error !== undefined) {
          stats.errors += 1;
          ctx.log.warn(`a handler threw: ${end.error}`);
        }
      };
      const bridge = hostBridge(ctx, c);
      const runner =
        isolation === 'worker'
          ? workerRunner(ctx, c, bridge, ended, fail)
          : inProcessRunner(ctx, c, bridge, ended, fail);
      const unsubscribe: (() => void)[] = [];
      return {
        async start() {
          let patterns: string[];
          try {
            patterns = await runner.load();
            for (const p of patterns)
              unsubscribe.push(ctx.bus.subscribe(p, (e) => runner.dispatch(p, e)));
          } catch (e) {
            for (const u of unsubscribe.splice(0)) u();
            await runner.close();
            throw e;
          }
          ctx.log.info(
            `loaded, ${isolation === 'worker' ? 'in a worker' : 'in process'}: ${patterns.length === 0 ? 'no handler' : `on ${patterns.join(', ')}`}`
          );
        },
        async stop() {
          for (const u of unsubscribe.splice(0)) u();
          await runner.close();
        },
        // What it costs (D77): its handlers' calls, from each to its end, and its thread's use.
        cost: () => ({ runs: isolation, ...stats, ...runner.usage() }),
      };
    },
  });
}

/** The main thread's side of the bridge: the node's context, within what its ports reach. */
function hostBridge(ctx: PluginContext, c: ScriptConfig): ScriptBridge {
  const sends = new Map<number, QueuedSend>();
  return {
    use: async (port, member, input) => {
      const declared = c.inputs[port];
      if (declared?.type !== 'interface')
        throw new Error(`use(${JSON.stringify(port)}): it has no interface input ${port}`);
      if (!declared.members.includes(member))
        throw new Error(`${port} offers it ${declared.members.join(', ')}, not ${member}`);
      const iface = ctx.useOptional<PluginInterface>(port);
      if (iface === undefined) throw new Error(`${port} is not bound, or not running`);
      const [part, name] = member.split('.') as ['state' | 'actions', string];
      const fn = (iface[part] as Record<string, (i: unknown) => unknown> | undefined)?.[name];
      if (typeof fn !== 'function') throw new Error(`${port} offers no ${member}`);
      const value = await fn(input);
      return value === undefined ? undefined : (structuredClone(value) as unknown);
    },
    enqueue: (id, port, chat, text, cancel, done) => {
      try {
        const q = ctx.outbox(port).enqueue(chat, text, cancel === undefined ? {} : { cancel });
        sends.set(id, q);
        void q.result.then((r) => {
          sends.delete(id);
          done(structuredClone(r) as SendOutcome);
        });
      } catch (e) {
        done({ text, outcome: 'refused', reason: message(e) });
      }
    },
    cancel: (id) => Promise.resolve(sends.get(id)?.cancel('cancelled by the script') ?? false),
    publish: (type, payload) => ctx.bus.publish(type, payload),
    write: (name, value) => ctx.store.write(name, value),
    remove: (name) => ctx.store.remove(name),
    log: (level, line) => ctx.log[level](line),
    now: () => ctx.clock.now(),
  };
}

/** Its store's documents, as they are, for the runtime's copy. */
const documentsOf = (ctx: PluginContext): Record<string, unknown> =>
  Object.fromEntries(ctx.store.names().map((n) => [n, ctx.store.read(n)]));

/** The event types of its own it may publish. */
const publishesOf = (ctx: PluginContext, c: ScriptConfig): string[] =>
  Object.keys(c.events).map((n) => `${ctx.id}.${n}`);

/** The script in the main thread: the dev kit's, on its clock. */
function inProcessRunner(
  ctx: PluginContext,
  c: ScriptConfig,
  bridge: ScriptBridge,
  ended: (end: CallEnd) => void,
  fail: (why: string) => void
): Runner {
  const runtime = new ScriptRuntime({
    bridge: {
      ...bridge,
      // A call's promise handled here too: a script that does not await it leaves no unhandled
      // rejection behind in the main thread.
      use: (...a) => {
        const p = bridge.use(...a);
        p.catch(() => {});
        return p;
      },
    },
    limits: { callMs: c.limits.callMs },
    documents: documentsOf(ctx),
    publishes: publishesOf(ctx, c),
    id: ctx.id,
  });
  let closed = false;
  return {
    load: async () => {
      try {
        await runtime.load(strip(c.code), `${ctx.id}.ts`);
      } catch (e) {
        throw new Error(
          `its script ${e instanceof ScriptTimeout ? 'hung' : 'failed'}: ${message(e)}`
        );
      }
      return runtime.patterns();
    },
    dispatch: (pattern, event) => {
      if (closed) return;
      try {
        runtime.dispatch(pattern, event, ended, () => performance.now());
      } catch (e) {
        closed = true;
        fail(`its script hung: ${message(e)}`);
      }
    },
    usage: () => ({}),
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
}

/** The script in a worker thread of its own: an instance's. */
function workerRunner(
  ctx: PluginContext,
  c: ScriptConfig,
  bridge: ScriptBridge,
  ended: (end: CallEnd) => void,
  fail: (why: string) => void
): Runner {
  const data: WorkerData = {
    id: ctx.id,
    js: strip(c.code),
    limits: { callMs: c.limits.callMs },
    documents: documentsOf(ctx),
    publishes: publishesOf(ctx, c),
    now: ctx.clock.now(),
  };
  let worker: Worker | undefined;
  let closing = false;
  let loaded: ((patterns: string[]) => void) | undefined;
  let refused: ((why: Error) => void) | undefined;
  let ping: ReturnType<typeof setTimeout> | undefined;
  let answered = true;
  let usage: { cpuMs?: number; heapBytes?: number } = {};
  let sampler: ReturnType<typeof setInterval> | undefined;
  // Its CPU and heap, sampled every few seconds (real time, as the watchdog's), for its cost.
  const sample = async (): Promise<void> => {
    try {
      const w = worker as Worker;
      const [cpu, heap] = await Promise.all([w.cpuUsage(), w.getHeapStatistics()]);
      usage = { cpuMs: (cpu.user + cpu.system) / 1000, heapBytes: heap.used_heap_size };
    } catch {
      // A worker ending: its last sample stands.
    }
  };
  const post = (m: FromHost): void => worker?.postMessage(m);
  const end = (why: string): void => {
    if (closing) return;
    closing = true;
    clearTimeout(ping);
    clearInterval(sampler);
    void worker?.terminate();
    refused?.(new Error(`its script ${why}`));
    fail(`its script ${why}`);
  };
  // The watchdog: a worker that does not answer within its limit holds its thread (a loop after
  // an await, which vm's limit does not see). Its time is the thread's, real time, never the
  // node's clock (the dev kit's is virtual, and moves by leaps): the one timer here not of
  // `ctx.clock`, and it keeps no process alive.
  const watch = (): void => {
    if (closing) return;
    if (!answered) {
      end(`hung: it held its thread past its limit of ${c.limits.callMs} ms`);
      return;
    }
    answered = false;
    post({ op: 'ping', now: ctx.clock.now() });
    // Twice the limit: a ping that lands as a run starts is answered once that run, limited by
    // vm, has ended.
    ping = setTimeout(watch, 2 * c.limits.callMs);
    ping.unref();
  };
  const onMessage = (m: FromWorker): void => {
    switch (m.op) {
      case 'pong':
        answered = true;
        return;
      case 'ready':
        // Watched from its first word: its thread's start (Node's, its modules') is not its own.
        watch();
        void sample();
        sampler = setInterval(() => void sample(), SAMPLE_MS);
        sampler.unref();
        return;
      case 'loaded':
        loaded?.(m.patterns);
        return;
      case 'refused':
        refused?.(new Error(`its script failed: ${m.reason}`));
        return;
      case 'timeout':
        end(`hung: ${m.reason}`);
        return;
      case 'ended':
        ended(m.end);
        return;
      case 'use':
        bridge.use(m.port, m.member, m.input).then(
          (value) => post({ op: 'answer', id: m.id, ok: true, value }),
          (e: unknown) => post({ op: 'answer', id: m.id, ok: false, error: message(e) })
        );
        return;
      case 'cancel':
        void bridge
          .cancel(m.send)
          .then((value) => post({ op: 'answer', id: m.id, ok: true, value }));
        return;
      case 'enqueue':
        bridge.enqueue(m.send, m.port, m.chat, m.text, m.cancel, (result) =>
          post({ op: 'sent', send: m.send, result })
        );
        return;
      case 'publish':
        try {
          bridge.publish(m.type, m.payload);
        } catch (e) {
          ctx.log.error(`publish ${m.type}: ${message(e)}`);
        }
        return;
      case 'write':
        bridge.write(m.name, m.value);
        return;
      case 'remove':
        bridge.remove(m.name);
        return;
      case 'log':
        bridge.log(m.level, m.line);
        return;
    }
  };
  return {
    load: () =>
      new Promise<string[]>((resolve, reject) => {
        loaded = resolve;
        refused = reject;
        worker = new Worker(new URL('./script-worker.ts', import.meta.url), {
          workerData: data,
          // Nothing of the process's environment, where a secret could be.
          env: {},
          resourceLimits: {
            maxOldGenerationSizeMb: c.limits.memoryMb,
            maxYoungGenerationSizeMb: Math.min(16, Math.max(4, Math.floor(c.limits.memoryMb / 8))),
            stackSizeMb: 4,
          },
        });
        worker.on('message', onMessage);
        worker.on('error', (e: Error & { code?: string }) =>
          end(
            e.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? `ran out of memory (its limit is ${c.limits.memoryMb} MB)`
              : `crashed: ${e.message}`
          )
        );
        worker.on('exit', (code) => {
          if (!closing) end(`stopped (exit code ${code})`);
        });
      }),
    dispatch: (pattern, event) => {
      if (!closing) post({ op: 'event', pattern, event, now: ctx.clock.now() });
    },
    usage: () => usage,
    close: async () => {
      closing = true;
      clearTimeout(ping);
      clearInterval(sampler);
      await worker?.terminate();
    },
  };
}

export type { ScriptCancel };
