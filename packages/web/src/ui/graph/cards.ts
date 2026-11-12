/**
 * The cards the editor draws for the graph's nodes (docs/bot-os.md D60): a node is one card, but a
 * connector, whose chats are read on the left of the graph and written to on its right, is two,
 * one node in the graph all the same (one account, one session):
 *
 * - its **in** card (`telegram-user · in`), with its chat-in output and every other port of it, at
 *   the left, its React Flow id the node's;
 * - its **out** card (`telegram-user · out`), with its chat-out input alone, at the right, its id
 *   the node's with `::out` (a node's id has no colon, so no node can take it).
 *
 * Each card is placed on its own; selecting either selects the node. The split lives here, in the
 * editor's view, and nowhere in the graph file. Pure functions, tested apart from React.
 */
import type { GraphEdge, NodeView } from '#src/ui/api.ts';
import { endOf } from './draft.ts';

/** The suffix of an out card's id. */
export const OUT_CARD = '::out';

/** Which card of a node: its only one, or the in or out card of a connector. */
export type CardSide = 'in' | 'out' | undefined;

/** One card: its id in the drawing, its node, its side, and the ports it shows. */
export interface Card {
  id: string;
  node: string;
  side: CardSide;
  view: NodeView;
}

/** Whether a node is drawn as two cards: it has a chat-out input, the sends of a connector. */
export const isSplit = (view: NodeView): boolean =>
  Object.values(view.inputs).some((p) => p.type === 'chat-out');

/** A card's title: its node's id, and its side when it has one (`telegram-user · in`). */
export const cardTitle = (node: string, side: CardSide): string =>
  side === undefined ? node : `${node} · ${side}`;

/** The node a card of the drawing is of. */
export const nodeOfCard = (id: string): string =>
  id.endsWith(OUT_CARD) ? id.slice(0, -OUT_CARD.length) : id;

/** The cards of a node: one, or its in and out cards. */
export function cardsOf(view: NodeView): Card[] {
  if (!isSplit(view)) return [{ id: view.id, node: view.id, side: undefined, view }];
  const pick = (out: boolean) =>
    Object.fromEntries(
      Object.entries(view.inputs).filter(([, p]) => (p.type === 'chat-out') === out)
    );
  return [
    { id: view.id, node: view.id, side: 'in', view: { ...view, inputs: pick(false) } },
    {
      id: `${view.id}${OUT_CARD}`,
      node: view.id,
      side: 'out',
      view: { ...view, inputs: pick(true), outputs: {} },
    },
  ];
}

/**
 * The card an edge's input end is drawn on: a split node's out card for its chat-out input (by
 * the edge's type, or the port's), its node's otherwise. Its output end is always on the node's
 * in card, or only card.
 */
export function targetCard(edge: GraphEdge, views: ReadonlyMap<string, NodeView>): string {
  const { node, port } = endOf(edge.to);
  const view = views.get(node);
  if (view === undefined || !isSplit(view)) return node;
  const type = port === undefined ? undefined : view.inputs[port]?.type;
  return type === 'chat-out' || (type === undefined && edge.type === 'chat-out')
    ? `${node}${OUT_CARD}`
    : node;
}

/** Card ids as node ids, each once, in their order: the nodes a selection of cards selects. */
export function nodesOfCards(ids: readonly string[]): string[] {
  return [...new Set(ids.map(nodeOfCard))];
}
