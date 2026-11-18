/**
 * The players that send to one chat from one account (bot-os.md D140): in a group, a bare command
 * reaches every bot there that takes it, so the form a player sends a command as is chosen with
 * the others that send there in view. One registry per `playerPlugin` (its instances' meeting
 * point, in memory), in which each player joins under its account and its chat:
 *
 * - **its group**, the players of the same account sending to the same chat: the reach of a form
 *   (`reachOf`) is those of them whose parser takes it, a bare `/x` every one whose bot declares
 *   the name `/x`, an addressed `/x@Bot` only Bot's;
 * - **the pick** (`pickForm`): a form is allowed only if every player it reaches would play its
 *   command now; among those allowed, the widest reach, the first in order on a tie;
 * - **claims**: the player that picked marks the players its form reaches as covered for their
 *   command, in the same tick as its send, so that no other sends an overlapping form, until it
 *   hands the send off (`sent`) or the claim times out;
 * - **the hand-off**: a command sent is told to every other player of the same account, whatever
 *   its chat, each telling its own parser, which counts it if it reaches its bot (a bare command in
 *   a group its edge reads).
 */

/** A command a player sent, as the others of its account are told (D139, D140). */
export interface PlayerSend {
  /** The chat it went to, as its edge names it. */
  chat: string;
  /** The command as sent: bare (`/play`) or addressed (`/play@QuestBot`). */
  text: string;
  /** The network's id of its message. */
  id?: string;
  t: number;
}

/** A player as a form's reach sees it. */
export interface Reacher {
  /** Its node's id. */
  readonly id: string;
  /** Its bot's command a form is, by its name; undefined when the form does not reach its bot. */
  takes(form: string): string | undefined;
  /** Whether it would play `command` now, sent as `form` (in a sitting, ticked, ready, allowed). */
  wouldPlay(command: string, form: string): boolean;
}

/** A player as its group sees it: its reach, and what the settling and the hand-off ask of it. */
export interface GroupMember extends Reacher {
  /**
   * When its `command` becomes ready, if it would play it then and that is within `withinMs` of
   * `now`; else undefined.
   */
  dueWithin(command: string, now: number, withinMs: number): number | undefined;
  /** Its parser's last send that no answer came to yet, if younger than the answer window. */
  unanswered(now: number): number | undefined;
  /** Another player of its account sent a command. */
  heard(s: PlayerSend): void;
}

/** One player a form reaches, and its command it is. */
export interface Reached {
  id: string;
  command: string;
}

/** The form picked, and whom it reaches. */
export interface Pick {
  form: string;
  reach: Reached[];
}

/** The players of `members` that `form` reaches, each with its command it is. */
export function reachOf(form: string, members: readonly Reacher[]): Reached[] {
  return members.flatMap((m) => {
    const command = m.takes(form);
    return command === undefined ? [] : [{ id: m.id, command }];
  });
}

/**
 * The form to send a command as (D140): of `forms`, in order, those every player they reach would
 * play now; the widest reach of them, the first on a tie. Undefined: none is allowed.
 */
export function pickForm(forms: readonly string[], members: readonly Reacher[]): Pick | undefined {
  let best: Pick | undefined;
  for (const form of forms) {
    const reach = reachOf(form, members);
    if (reach.length === 0 || (best !== undefined && reach.length <= best.reach.length)) continue;
    const all = reach.every((r) => members.find((m) => m.id === r.id)?.wouldPlay(r.command, form));
    if (all) best = { form, reach };
  }
  return best;
}

/** The widest reach of `forms`, would its players play or not: whom a send could cover. */
export function widestReach(forms: readonly string[], members: readonly Reacher[]): Reached[] {
  return forms
    .map((f) => reachOf(f, members))
    .reduce<Reached[]>((a, r) => (r.length > a.length ? r : a), []);
}

interface Joined {
  account: string;
  chat: string;
  member: GroupMember;
}

interface Claim {
  by: string;
  command: string;
  until: number;
}

/** The players of one `playerPlugin`, by account and chat, their claims and their hand-offs. */
export class ChatGroups {
  private readonly joined = new Map<string, Joined>();
  /** Each player's commands covered by a claim, by its id. */
  private readonly claims = new Map<string, Claim[]>();

  /** A player joins its group; the function returned leaves it. */
  join(id: string, account: string, chat: string, member: GroupMember): () => void {
    const j = { account, chat: chat.toLowerCase(), member };
    this.joined.set(id, j);
    return () => {
      if (this.joined.get(id) === j) this.joined.delete(id);
      this.release(id);
    };
  }

  /** The players sending to the same chat from the same account as `id`, itself included. */
  group(id: string): GroupMember[] {
    const me = this.joined.get(id);
    if (me === undefined) return [];
    return [...this.joined.values()]
      .filter((j) => j.account === me.account && j.chat === me.chat)
      .map((j) => j.member);
  }

  /** `by` covers the players its form reaches, each for its command, until `until`. */
  claim(by: string, reach: readonly Reached[], until: number): void {
    for (const r of reach) {
      const list = (this.claims.get(r.id) ?? []).filter((c) => c.by !== by);
      this.claims.set(r.id, [...list, { by, command: r.command.toLowerCase(), until }]);
    }
  }

  /** Whether a claim covers `id`'s `command` now. */
  covered(id: string, command: string, now: number): boolean {
    const c = command.toLowerCase();
    return (this.claims.get(id) ?? []).some((x) => x.command === c && x.until > now);
  }

  /** `by`'s claims end. */
  release(by: string): void {
    for (const [id, list] of [...this.claims]) {
      const kept = list.filter((c) => c.by !== by);
      if (kept.length === 0) this.claims.delete(id);
      else this.claims.set(id, kept);
    }
  }

  /**
   * `by` sent a command: its claims end, and every other player of its account hears it, each
   * telling its parser, which counts it if it reaches its bot.
   */
  sent(by: string, s: PlayerSend): void {
    this.release(by);
    const me = this.joined.get(by);
    if (me === undefined) return;
    for (const [id, j] of [...this.joined])
      if (id !== by && j.account === me.account) j.member.heard(s);
  }
}
