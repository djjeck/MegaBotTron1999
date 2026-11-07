import { type Connector } from '@megabottron1999/core';

/**
 * What the client needs from the channel: lines in, one line out. The IRC client
 * (packages/connectors/src/transport/irc-client.ts) is one transport; the arena's simulated
 * channel is the other.
 */

export interface ChannelLine {
  nick: string;
  text: string;
  /** The line's `server-time`, in milliseconds. */
  time: number;
  /** From ZNC's buffer replay at attach: history, not news. */
  playback: boolean;
}

export type TransportStatus = 'connecting' | 'registered' | 'joined' | 'closed';

export interface TransportEvents {
  line: (line: ChannelLine) => void;
  status: (status: TransportStatus, detail?: string) => void;
}

export interface Transport {
  start(): void;
  /** Sends one line to the channel; false if it cannot now (not connected). */
  say(text: string): boolean;
  stop(): void;
}

/**
 * The client's transport over a connector (packages/core/src/connector.ts), or the way to
 * find it once the core runs it, and one of its chats: its lines in, and lines to it out. The
 * connector is started and stopped by the core, so `start` and `stop` only attach and detach the
 * client; the status the client first hears is the connector's at once.
 */
export function transportOver(
  over: Connector | (() => Connector | undefined),
  chat: string
): (events: TransportEvents) => Transport {
  const get = typeof over === 'function' ? over : () => over;
  return (events) => {
    const off: (() => void)[] = [];
    return {
      start: () => {
        const connector = get();
        if (connector === undefined) {
          events.status('closed', 'no connector');
          return;
        }
        off.push(
          connector.onMessage((m) => {
            if (m.chat.toLowerCase() !== chat.toLowerCase()) return;
            events.line({ nick: m.sender, text: m.text, time: m.time, playback: m.playback });
          }),
          connector.onStatus((s) => events.status(s.phase as TransportStatus, s.detail))
        );
        const now = connector.status();
        if (now.state !== 'closed') events.status(now.phase as TransportStatus, now.detail);
      },
      say: (text) => get()?.send(chat, text) ?? false,
      stop: () => {
        for (const f of off.splice(0)) f();
      },
    };
  };
}
