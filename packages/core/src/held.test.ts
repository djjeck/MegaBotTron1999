import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { holdUnloaded } from './held.ts';
import { type Manifest, parseManifest } from './manifest.ts';

const manifests = (...raw: unknown[]): Map<string, Manifest> =>
  new Map(
    raw.map((m) => {
      const parsed = parseManifest(m);
      return [parsed.id, parsed];
    })
  );

const chat = {
  id: 'chat',
  version: '0.1.0',
  kinds: ['connector'],
  description: 'a chat',
  account: 'chat:me',
};
const scorer = {
  id: 'scorer',
  version: '0.1.0',
  kinds: ['parser'],
  description: 'keeps a score',
  interface: { state: { score: { help: 'the score', output: z.number() } } },
};
const actor = {
  id: 'actor',
  version: '0.1.0',
  kinds: ['actor'],
  description: 'acts on the score',
  inputs: {
    chat: { type: 'chat-in', network: 'chat' },
    score: { type: 'interface', plugin: 'scorer', members: ['state.score'] },
  },
  outputs: { chat: { type: 'chat-out', network: 'chat' } },
};
/** Reads the score if it can: an optional input. */
const watcher = {
  id: 'watcher',
  version: '0.1.0',
  kinds: ['stats'],
  description: 'watches the score',
  inputs: {
    score: { type: 'interface', plugin: 'scorer', members: ['state.score'], optional: true },
  },
};
/** Sends if it can: an optional chat-out output. */
const herald = {
  id: 'herald',
  version: '0.1.0',
  kinds: ['actor'],
  description: 'announces',
  outputs: { chat: { type: 'chat-out', network: 'chat', optional: true } },
};

const graph = {
  version: 2,
  nodes: [
    { id: 'chat', plugin: 'chat' },
    { id: 'scorer', plugin: 'scorer' },
    { id: 'actor', plugin: 'actor' },
    { id: 'watcher', plugin: 'watcher' },
    { id: 'herald', plugin: 'herald' },
  ],
  edges: [
    { from: 'chat', to: 'actor.chat', reads: ['#lobby'] },
    { from: 'actor.chat', to: 'chat.chat', sends: ['#lobby'] },
    { from: 'scorer', to: 'actor.score' },
    { from: 'scorer', to: 'watcher.score' },
    { from: 'herald.chat', to: 'chat.chat', sends: ['#lobby'] },
  ],
};

describe('holding the nodes of plugins not loaded (D143)', () => {
  it('gives the graph back as it is when every plugin is offered, or it does not read', () => {
    const all = manifests(chat, scorer, actor, watcher, herald);
    expect(holdUnloaded(graph, all)).toEqual({ raw: graph, held: [] });
    expect(holdUnloaded('nonsense', all)).toEqual({ raw: 'nonsense', held: [] });
    expect(holdUnloaded({ version: 2 }, all)).toEqual({ raw: { version: 2 }, held: [] });
  });

  it('holds a node of a plugin not offered, and what requires it, but not an optional reader', () => {
    const { raw, held } = holdUnloaded(graph, manifests(chat, actor, watcher, herald));
    expect(held).toEqual([
      { id: 'scorer', plugin: 'scorer', disabled: false },
      { id: 'actor', plugin: 'actor', disabled: false, needs: 'scorer' },
    ]);
    expect(raw).toEqual({
      version: 2,
      nodes: [
        { id: 'chat', plugin: 'chat' },
        { id: 'watcher', plugin: 'watcher' },
        { id: 'herald', plugin: 'herald' },
      ],
      edges: [{ from: 'herald.chat', to: 'chat.chat', sends: ['#lobby'] }],
    });
  });

  it('holds a sender whose required chat-out output its connector took, not an optional one', () => {
    const { held } = holdUnloaded(
      { ...graph, nodes: [...graph.nodes.slice(0, 4), { ...graph.nodes[4], disabled: true }] },
      manifests(scorer, actor, watcher, herald)
    );
    expect(held).toEqual([
      { id: 'chat', plugin: 'chat', disabled: false },
      { id: 'actor', plugin: 'actor', disabled: false, needs: 'chat' },
    ]);
    // An edge from a sender that names no output port: any required chat-out output counts.
    const bare = holdUnloaded(
      {
        version: 2,
        nodes: [
          { id: 'chat', plugin: 'chat' },
          { id: 'actor', plugin: 'actor' },
          { id: 'herald', plugin: 'herald' },
        ],
        edges: [
          { from: 'actor', to: 'chat.chat' },
          { from: 'herald', to: 'chat.chat' },
          { from: 'ghost', to: 'chat.chat' },
          'not an edge',
        ],
      },
      manifests(actor, herald)
    );
    expect(bare.held.map((h) => h.id)).toEqual(['chat', 'actor']);
    expect((bare.raw as { edges: unknown[] }).edges).toEqual(['not an edge']);
  });

  it('says a disabled node held as disabled, and leaves a graph without edges as it is', () => {
    const { raw, held } = holdUnloaded(
      { version: 2, nodes: [{ id: 's', plugin: 'scorer', disabled: true }, 'not a node'] },
      manifests(chat)
    );
    expect(held).toEqual([{ id: 's', plugin: 'scorer', disabled: true }]);
    expect(raw).toEqual({ version: 2, nodes: ['not a node'] });
  });
});
