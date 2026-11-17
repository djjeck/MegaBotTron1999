/**
 * A clone of the made-up @QuestBot on alice's faked account (bot-os.md D132–D134, #49): it answers
 * each command a second after it is sent, in @QuestBot's own words (`test/quest.ts`'s grammar reads
 * them), from a game it keeps on the clock it is given. Its game: `/play` finds an apple and rests
 * 15 minutes (a "Too soon" while it rests), every other turn announcing a chest; `/chest` opens the
 * chest announced, for 30 minutes; `/daily` gives coins once a day; `/coffee`, once an hour, ends
 * the turn's rest. `garble`, it answers what no grammar reads.
 */
import { type Clock, FakeConnector } from '@megabottron1999/core';
import { QUESTBOT } from '#test/quest.ts';

const MIN = 60_000;

export class QuestClone extends FakeConnector {
  private readonly clock: Clock;
  private n = 500;
  private turns = 0;
  private restUntil = 0;
  private chestUntil = 0;
  private dailyAt = 0;
  private coffeeAt = 0;
  /** It answers gibberish. */
  garble = false;
  /** Every reply it gave: when, to what, and what. */
  readonly replies: { t: number; command: string; text: string }[] = [];

  constructor(clock: Clock) {
    super({ account: 'telegram:alice' });
    this.clock = clock;
  }

  deliver(chat: string, text: string): Promise<{ id?: string }> {
    this.send(chat, text);
    const id = String(this.n++);
    this.clock.setTimeout(() => this.answer(chat, text, id), 1000);
    return Promise.resolve({ id });
  }

  /** The owner plays `text` by hand from another device: heard, and answered. */
  byHand(chat: string, text: string): void {
    const id = String(this.n++);
    this.hear({ chat, sender: 'alice', own: true, time: this.clock.now(), id, text });
    this.clock.setTimeout(() => this.answer(chat, text, id), 1000);
  }

  private answer(chat: string, command: string, replyTo: string): void {
    const t = this.clock.now();
    const text = this.garble ? 'Gibberish' : this.reply(command, t);
    this.replies.push({ t, command, text });
    this.hear({ chat, sender: QUESTBOT, time: t, id: String(this.n++), replyTo, text });
  }

  private reply(command: string, t: number): string {
    const wait = (until: number) => `Come back in ${Math.ceil((until - t) / MIN)} minutes.`;
    if (command === '/play') {
      if (t < this.restUntil) return `Too soon: ${Math.ceil((this.restUntil - t) / MIN)} minutes.`;
      this.restUntil = t + 15 * MIN;
      this.turns++;
      if (this.turns % 2 === 1) return 'Found an apple.';
      this.chestUntil = t + 30 * MIN;
      return 'Found an apple.\nA chest appears!';
    }
    if (command === '/chest') {
      if (t >= this.chestUntil) return 'No chest here.';
      this.chestUntil = 0;
      return 'The chest holds a gem.';
    }
    if (command === '/daily') {
      if (t < this.dailyAt) return wait(this.dailyAt);
      this.dailyAt = t + 24 * 60 * MIN;
      return 'Daily reward: 5 coins.';
    }
    if (command === '/coffee') {
      if (t < this.coffeeAt) return wait(this.coffeeAt);
      this.coffeeAt = t + 60 * MIN;
      this.restUntil = t;
      return 'You drink a coffee: rested.';
    }
    return 'Unknown command.';
  }
}
