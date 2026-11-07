/**
 * The IRC wire format, as much of it as the client uses (RFC 1459 framing with IRCv3 message
 * tags): parse a line into its parts, and format a command. Pure.
 */

export interface IrcMessage {
  /** IRCv3 tags (`@time=…;account=…`), unescaped. */
  tags: Record<string, string>;
  /** The sender's nick (or server name), without `!user@host`. */
  source?: string;
  command: string;
  params: string[];
}

const TAG_ESCAPES: Record<string, string> = { ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' };

function unescapeTag(value: string): string {
  return value.replace(/\\(.?)/gu, (_, c: string) => TAG_ESCAPES[c] ?? c);
}

/** One line from the server, without its CRLF. */
export function parseIrcLine(line: string): IrcMessage {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    for (const tag of rest.slice(1, end).split(';')) {
      const eq = tag.indexOf('=');
      if (eq < 0) tags[tag] = '';
      else tags[tag.slice(0, eq)] = unescapeTag(tag.slice(eq + 1));
    }
    rest = rest.slice(end + 1).trimStart();
  }
  const message: IrcMessage = { tags, command: '', params: [] };
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    message.source = String(rest.slice(1, end).split('!')[0]);
    rest = rest.slice(end + 1).trimStart();
  }
  const trailing = rest.indexOf(' :');
  const head = trailing < 0 ? rest : rest.slice(0, trailing);
  const [command = '', ...params] = head.split(' ').filter((p) => p !== '');
  if (trailing >= 0) params.push(rest.slice(trailing + 2));
  else if (rest.startsWith(':')) params.push(rest.slice(1));
  message.command = command.toUpperCase();
  message.params = params;
  return message;
}

/** A command line to send: the last parameter is sent as trailing when it needs to be. */
export function formatIrcLine(command: string, ...params: string[]): string {
  const last = params.length - 1;
  const parts = params.map((p, i) =>
    i === last && (p === '' || p.includes(' ') || p.startsWith(':')) ? `:${p}` : p
  );
  return [command, ...parts].join(' ');
}

/** The time of a message: its `server-time` tag if any, else `fallback`. Milliseconds. */
export function messageTime(message: IrcMessage, fallback: number): number {
  const t = message.tags['time'];
  if (t === undefined) return fallback;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? fallback : ms;
}
