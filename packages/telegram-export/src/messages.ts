/**
 * The messages of a Telegram Desktop chat export, as the readers give them (docs/telegram-export.md
 * §9): one shape for the HTML export (`html.ts`) and the JSON export (`json.ts`). Generic: nothing
 * here knows of any bot or game. Pure types, no Node APIs.
 *
 * Field names and key order are those of the JSON form (snake_case), the optional fields last;
 * objects are built in this key order, so that serialising them gives byte-identical output from
 * run to run.
 */

/** One message of an export. */
export interface ExportMessage {
  /** Chat title (the page header's, the JSON export's `name`); `null` if the export has none. */
  chat: string | null;
  /** Telegram message id, unique within a chat. */
  id: number;
  /**
   * Its date in the Windows HTML form, `27.11.2025 19:14:19 UTC-05:00`; `null` if missing. A
   * macOS HTML export's (`27 November 2025, 19:14:19`, no offset) is converted to this form with
   * the export's inferred or given UTC offset (`mergeExports`); a JSON export's with its own.
   */
  date: string | null;
  /** The sender's display name (stripped); a joined HTML message inherits it. */
  sender: string | null;
  /** Original author of a forwarded message, by display name. */
  forwarded_from: string | null;
  /** Id of the message replied to (negative in chats with negative ids). */
  reply_to: number | null;
  /**
   * Visible text, stripped: lines joined by `\n`, entities decoded, markup dropped; `/cmd@Bot` as
   * written. A file's caption for a message with a file.
   */
  text: string;
  /**
   * The chat's id as the network names it (bot-os.md D90), where the export gives it (JSON): a
   * user's or bot's id, `-<id>` for a basic group, `-100<id>` for a supergroup or a channel.
   */
  chat_id?: string;
  /** The chat's kind, where the export says (JSON): `personal_chat`, `bot_chat`, `private_group`, … */
  chat_type?: string;
  /**
   * The sender's id, where the export gives it: `user<id>` (JSON's `from_id`, or the avatar file
   * name of a macOS HTML export, inherited by joined messages like the name), `channel<id>` for a
   * channel posting as itself.
   */
  sender_id?: string;
  /** The name of the text file attached, with `file_text`. */
  file_name?: string;
  /**
   * Present only for a message with a text file attached that the export holds (`files/*.txt`,
   * docs/telegram-export.md §5.6): the file's content, read like a page (`decodeText`).
   */
  file_text?: string;
}

/** One page of an HTML export as found: where it came from, and its HTML. */
export interface Page {
  /** Path of the page file: `path/to/messagesN.html`. */
  label: string;
  html: string;
  /**
   * The text files the page links to as attachments that the export holds (`linkedTextFiles`):
   * link as written (`files/file (1).txt`) -> content. Absent for none.
   */
  files?: ReadonlyMap<string, string>;
}
