/**
 * Tells the author what the run does, through the instance's own Telegram bot, in
 * its private chat with the author
 * (packages/connectors/src/transport/telegram-switchboard.ts). A message may carry inline
 * buttons, each an action that comes back to the remote (the core's owner's controls,
 * packages/core/src/controls.ts). A failed send is reported once on stdout and never stops
 * the run.
 */
import { type Buttons, type CommandButton } from '@megabottron1999/core';
import { type Switchboard } from 'grammy-switchboard';

/** An inline button: its label, and the command a tap runs (`CommandButton`). */
export type Button = CommandButton;

export type Notify = (text: string, buttons?: Buttons) => void;

/** Changes a message the bot sent, its text and buttons; in order, without waiting. */
export type Edit = (messageId: number, text: string, buttons?: Buttons) => void;

export interface NotifierOptions {
  switchboard: Pick<Switchboard, 'send' | 'edit'>;
  /** The topic the messages go to: the author's. */
  topic: string;
  /** Where a failed send is reported. */
  warn?: (line: string) => void;
}

/** A `Notify` that sends to the topic, in order, without waiting. */
export function telegramNotify(o: NotifierOptions): Notify {
  const warn = o.warn ?? ((line: string) => console.log(line));
  let chain: Promise<void> = Promise.resolve();
  let failing = false;
  return (text, buttons) => {
    chain = chain.then(async () => {
      try {
        await o.switchboard.send({
          topic: o.topic,
          text,
          ...(buttons === undefined ? {} : { buttons: buttons.map((row) => [...row]) }),
        });
        failing = false;
      } catch (e) {
        if (!failing) warn(`notify failed: ${String(e)}`);
        failing = true;
      }
    });
  };
}

/** An `Edit` of the topic's messages; buttons left out stay as they are. */
export function telegramEdit(o: NotifierOptions): Edit {
  const warn = o.warn ?? ((line: string) => console.log(line));
  return (messageId, text, buttons) => {
    o.switchboard
      .edit({
        topic: o.topic,
        messageId,
        text,
        ...(buttons === undefined ? {} : { buttons: buttons.map((row) => [...row]) }),
      })
      .catch((e: unknown) => warn(`edit failed: ${String(e)}`));
  };
}
