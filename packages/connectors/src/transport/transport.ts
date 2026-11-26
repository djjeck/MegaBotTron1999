/**
 * What the client needs from the channel: lines in, one line out. The IRC client
 * (packages/connectors/src/transport/irc-client.ts) is the transport the IRC connector runs; tests
 * run it on a fake, or over a connector's chat (packages/connectors/test/transport.ts).
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
