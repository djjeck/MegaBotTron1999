/**
 * A script node's worker thread (docs/bot-os.md D76): the runtime (`script-runtime.ts`) on a
 * message channel to its host in the main thread (`script-plugin.ts`). Plumbing only, left out of
 * coverage (V8's coverage does not reach a worker thread): the runtime it runs is tested in the
 * main thread, and this file through the worker's tests.
 */
import { getHeapStatistics } from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';
import { ScriptRuntime, type SendOutcome } from './script-runtime.ts';
import { type FromHost, type FromWorker, type WorkerData } from './script-worker-messages.ts';

const port = parentPort;
if (port === null) throw new Error('script-worker.ts runs in a worker thread');
const data = workerData as WorkerData;
const post = (m: FromWorker): void => port.postMessage(m);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The host's clock, as its last message carried it: an event's handlers read the time it was
// handed over at, as they would on the dev kit's clock.
let base = data.now;
const now = (): number => base;
const tick = (t: number): void => {
  base = t;
};

let nextCall = 1;
const calls = new Map<number, { ok: (v: unknown) => void; ko: (e: Error) => void }>();
const sends = new Map<number, (r: SendOutcome) => void>();
const call = (m: (id: number) => FromWorker): Promise<unknown> =>
  new Promise((ok, ko) => {
    const id = nextCall++;
    calls.set(id, { ok, ko });
    post(m(id));
  });

const runtime = new ScriptRuntime({
  id: data.id,
  limits: data.limits,
  documents: data.documents,
  publishes: data.publishes,
  // No limit of vm's here, real time, which a stalled host would trip: its host's watchdog limits
  // the CPU this thread spends (D85), and names the run it kills by what is told it here.
  running: (what) => post({ op: 'running', what }),
  bridge: {
    use: (p, member, input) => call((id) => ({ op: 'use', id, port: p, member, input })),
    enqueue: (send, p, chat, text, cancel, done) => {
      sends.set(send, done);
      post({ op: 'enqueue', send, port: p, chat, text, cancel });
    },
    cancel: (send) => call((id) => ({ op: 'cancel', id, send })) as Promise<boolean>,
    publish: (type, payload) => post({ op: 'publish', type, payload }),
    write: (name, value) => post({ op: 'write', name, value }),
    remove: (name) => post({ op: 'remove', name }),
    log: (level, line) => post({ op: 'log', level, line }),
    now,
  },
});

// What its script costs (docs/bot-os.md D87): the CPU this thread spends from a message that may run
// the script's code (an event, a call's answer, a send's outcome; its first run) until it is idle
// again, the microtasks that message started drained (an immediate runs only then). A loop in
// there never gets idle, and its host's watchdog kills it. Each time it gets idle it tells its host
// how many such messages it has handled, its CPU so far and its heap: its host watches it only
// while one is unhandled, and polls nothing, so that an idle script costs nothing and shows it.
let handled = 0;
let depth = 0;
let busyFrom = 0;
let cpuMs = 0;
const threadCpuMs = (): number => {
  const c = process.threadCpuUsage();
  return (c.user + c.system) / 1000;
};
const busy = (): void => {
  if (depth++ === 0) busyFrom = threadCpuMs();
};
const idle = (counted: boolean): void => {
  setImmediate(() => {
    if (counted) handled++;
    if (--depth > 0) return;
    cpuMs += threadCpuMs() - busyFrom;
    post({ op: 'idle', handled, cpuMs, heapBytes: getHeapStatistics().used_heap_size });
  });
};

// A promise the script left unhandled is its error, logged; never the thread's end.
process.on('unhandledRejection', (e) =>
  post({ op: 'log', level: 'error', line: `unhandled: ${message(e)}` })
);

port.on('message', (m: FromHost) => {
  if (m.op === 'ping') {
    tick(m.now);
    post({ op: 'pong' });
    return;
  }
  busy();
  try {
    handle(m);
  } finally {
    idle(true);
  }
});

function handle(m: Exclude<FromHost, { op: 'ping' }>): void {
  switch (m.op) {
    case 'event':
      tick(m.now);
      runtime.dispatch(
        m.pattern,
        m.event,
        (end) => post({ op: 'ended', end }),
        () => performance.now()
      );
      return;
    case 'answer': {
      const c = calls.get(m.id);
      calls.delete(m.id);
      if (m.ok) c?.ok(m.value);
      else c?.ko(new Error(m.error));
      return;
    }
    case 'sent':
      sends.get(m.send)?.(m.result);
      sends.delete(m.send);
      return;
  }
}

post({ op: 'ready' });
// Its first run is its own: counted from here, the thread's start (Node's, its modules') left out.
busy();
runtime
  .load(data.js, `${data.id}.ts`)
  .then(
    () => post({ op: 'loaded', patterns: runtime.patterns() }),
    (e: unknown) => post({ op: 'refused', reason: message(e) })
  )
  .finally(() => idle(false));
