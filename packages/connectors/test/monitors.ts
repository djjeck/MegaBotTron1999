/**
 * What the graph's check warns of (bot-os.md D89) when a reader's chat-in edge from a connector
 * plugin's node, with its config, reads the chats given: so that each connector's tests check the
 * chats its manifest says it monitors. `names`, what its running connector would know each chat by
 * (`chatNames`, D90); none: it is not running.
 */
import { parseManifest, type Plugin, resolveGraph } from '@megabottron1999/core';

const READER = parseManifest({
  id: 'reader',
  version: '0.1.0',
  kinds: ['parser'],
  description: 'reads a chat',
  inputs: { chat: { type: 'chat-in' } },
});

export function readWarnings(
  plugin: Plugin,
  config: Record<string, unknown> | undefined,
  reads: string[],
  names?: (chat: string) => readonly string[] | undefined
): string[] {
  const manifest = parseManifest(plugin.manifest);
  return resolveGraph(
    {
      version: 2,
      nodes: [
        { id: 'conn', plugin: manifest.id, ...(config === undefined ? {} : { config }) },
        { id: 'quest', plugin: 'reader' },
      ],
      edges: [{ from: 'conn', to: 'quest.chat', reads }],
    },
    new Map([
      [manifest.id, manifest],
      ['reader', READER],
    ]),
    undefined,
    (node, plugin, chat) => (node === 'conn' && plugin === manifest.id ? names?.(chat) : undefined)
  ).warnings;
}
