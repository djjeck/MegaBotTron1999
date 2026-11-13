/**
 * A script node exported as a module's plugin (docs/bot-os.md D79): a TypeScript file whose
 * `definePlugin` manifest is built from the node's declared ports and own events, and whose
 * `create` runs the script as typed, on a few lines that give it the script API from the plugin
 * context (`on`, `use`, `outbox`, `enqueue`, `publish`, `store`, `clock`, `log`), typed as the
 * editor typed it (its `.d.ts`, without its `declare`s); and a `module.json` for it. Moving a
 * script to a repository is then a copy, not a rewrite. Pure: the editor downloads its result.
 */
import type { ScriptApi } from './types.ts';
import { portsOf, scriptDts } from './types.ts';

/** What an export gives: the plugin's file, and its module's manifest. */
export interface ScriptExport {
  /** The plugin's file name, `<id>.ts`. */
  fileName: string;
  plugin: string;
  moduleJson: string;
}

const ZOD: Record<string, string> = {
  string: 'z.string()',
  number: 'z.number()',
  boolean: 'z.boolean()',
};

/** A JSON value as TypeScript, indented under `indent`. */
const literal = (v: unknown, indent: string): string =>
  JSON.stringify(v, null, 2)
    .split('\n')
    .map((l, i) => (i === 0 ? l : `${indent}${l}`))
    .join('\n');

/** The code, each line indented under `indent`, blank lines left blank. */
const indented = (code: string, indent: string): string =>
  code
    .replace(/\s+$/u, '')
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : `${indent}${l}`))
    .join('\n');

/**
 * The script node `id` as a module's plugin of the same id, so its events keep their types
 * (`<id>.<name>`) and its edges their ports.
 */
export function exportScript(
  id: string,
  config: Readonly<Record<string, unknown>>,
  api: ScriptApi
): ScriptExport {
  const ports = portsOf(config);
  const code = typeof config['code'] === 'string' ? config['code'] : '';
  const sends = Object.keys(ports.outputs).length > 0;
  const events = Object.entries(ports.events).map(([name, e]) => {
    const fields = Object.entries(e.fields)
      .map(([k, t]) => `${JSON.stringify(k)}: ${ZOD[t] ?? 'z.unknown()'}`)
      .join(', ');
    const help = e.help === '' ? '' : `.describe(${JSON.stringify(e.help)})`;
    return `        ${JSON.stringify(`${id}.${name}`)}: z.object({ ${fields} })${help},`;
  });
  // The editor's types, as local ones: its `declare`s are the shim's below.
  const types = scriptDts(api, id)
    .split('\n')
    .filter((l) => !l.startsWith('// '))
    .join('\n')
    .replace(/\/\*\*[^\n]*\*\/\ndeclare [\s\S]*$/u, '')
    .trimEnd();
  const plugin = `/**
 * ${id}: a plugin exported from MegaBotTron1999's script node ${id} (docs/bot-os.md D79). Its
 * manifest is the node's declared ports; its \`create\` runs the script as it was typed, on the
 * script API given from the plugin context. As a module's plugin it runs in the shell's process,
 * with no worker and no limits of its own.
 */
import { definePlugin, type Plugin, type PluginInterface } from '@megabottron1999/core';
import { z } from 'zod';

${types}

export const plugins: Plugin[] = [
  definePlugin({
    manifest: {
      id: ${JSON.stringify(id)},
      version: '0.1.0',
      kinds: [${sends ? "'actor'" : "'stats'"}],
      description: ${JSON.stringify(`Exported from the script node ${id}`)},
      inputs: ${literal(ports.inputs, '      ')},
      outputs: ${literal(ports.outputs, '      ')},
      games: { registers: [${events.length === 0 ? '' : JSON.stringify(id)}] },
      events: {
${events.join('\n')}
      },
    },
    create: async (ctx) => {
      // The script API, on the plugin context (docs/bot-os-api.md §5, script).
      const handlers: { type: string; fn: (event: never) => unknown }[] = [];
      function on<T extends keyof ScriptEvents>(type: T, fn: (event: ScriptEvents[T]) => unknown): void;
      function on<N extends keyof ScriptNamespaces>(
        namespace: N,
        fn: (event: ScriptNamespaces[N]) => unknown
      ): void;
      function on(type: string, fn: (event: never) => unknown): void {
        handlers.push({ type, fn });
      }
      const promised = (members: Record<string, unknown> | undefined) =>
        new Proxy(
          {},
          {
            get: (_, name) => (input?: unknown) =>
              Promise.resolve((members?.[String(name)] as (i?: unknown) => unknown)(input)),
          }
        );
      const use = <P extends keyof ScriptInterfaces>(port: P): ScriptInterfaces[P] => {
        const i = ctx.use<PluginInterface>(port);
        return { state: promised(i.state), actions: promised(i.actions) } as ScriptInterfaces[P];
      };
      const outbox = (port: ScriptOutput) => ctx.outbox(port);
      const enqueue = (
        port: ScriptOutput,
        chat: string,
        text: string,
        options: { cancel?: ScriptCancel } = {}
      ) => ctx.outbox(port).enqueue(chat, text, options);
      const publish = <T extends keyof ScriptOwnEvents>(type: T, payload: ScriptOwnEvents[T]): void =>
        ctx.bus.publish(type, payload as Record<string, unknown>);
      const { store, clock } = ctx;
      const line = (values: unknown[]): string =>
        values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
      const log = Object.assign((...v: unknown[]) => ctx.log.info(line(v)), {
        info: (...v: unknown[]) => ctx.log.info(line(v)),
        warn: (...v: unknown[]) => ctx.log.warn(line(v)),
        error: (...v: unknown[]) => ctx.log.error(line(v)),
      });
      const console = { log, info: log.info, warn: log.warn, error: log.error };
      void [on, use, outbox, enqueue, publish, store, clock, log, console];

      // The script, as typed in the editor.
${indented(code, '      ')}

      const stops: (() => void)[] = [];
      return {
        start() {
          for (const h of handlers)
            stops.push(
              ctx.bus.subscribe(h.type, (event) => {
                Promise.resolve()
                  .then(() => h.fn(event as never))
                  .catch((e: unknown) => ctx.log.warn(\`a handler threw: \${String(e)}\`));
              })
            );
        },
        stop() {
          for (const s of stops.splice(0)) s();
        },
      };
    },
  }),
];
`;
  const moduleJson = `${JSON.stringify(
    {
      id,
      version: '0.1.0',
      api: '1',
      provides: `@example/${id}`,
      description: `Exported from the script node ${id}`,
      plugins: [`src/plugins/${id}.ts`],
    },
    null,
    2
  )}\n`;
  return { fileName: `${id}.ts`, plugin, moduleJson };
}
