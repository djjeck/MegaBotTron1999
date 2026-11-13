/**
 * The messages between a script node's host, in the main thread, and its worker thread
 * (`script-plugin.ts`, `script-worker.ts`, docs/bot-os.md D76): types only.
 */
import {
  type CallEnd,
  type LogLevel,
  type ScriptCancel,
  type ScriptLimits,
  type SendOutcome,
} from './script-runtime.ts';

/** What the worker starts with. */
export interface WorkerData {
  id: string;
  /** Its code, its types stripped. */
  js: string;
  limits: ScriptLimits;
  documents: Record<string, unknown>;
  publishes: string[];
  /** The host's clock when it was made. */
  now: number;
}

/** From the host: an event to handle, an answer to a call, a send's outcome, a ping. */
export type FromHost =
  | { op: 'event'; pattern: string; event: unknown; now: number }
  | { op: 'answer'; id: number; ok: true; value: unknown }
  | { op: 'answer'; id: number; ok: false; error: string }
  | { op: 'sent'; send: number; result: SendOutcome }
  | { op: 'ping'; now: number };

/**
 * From the worker: its load, the synchronous run that holds its thread, its calls' ends, its calls
 * to the main thread, a pong.
 */
export type FromWorker =
  | { op: 'ready' }
  | { op: 'loaded'; patterns: string[] }
  | { op: 'refused'; reason: string }
  | { op: 'running'; what: string | undefined }
  | { op: 'ended'; end: CallEnd }
  | { op: 'use'; id: number; port: string; member: string; input: unknown }
  | { op: 'cancel'; id: number; send: number }
  | {
      op: 'enqueue';
      send: number;
      port: string;
      chat: string;
      text: string;
      cancel: ScriptCancel | undefined;
    }
  | { op: 'publish'; type: string; payload: Record<string, unknown> }
  | { op: 'write'; name: string; value: unknown }
  | { op: 'remove'; name: string }
  | { op: 'log'; level: LogLevel; line: string }
  | { op: 'pong' };
