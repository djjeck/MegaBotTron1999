/**
 * Telegram HTML written by a plugin (`format: 'html'`, bot-os.md D164). A plugin builds it itself,
 * for what Markdown cannot say (an underline, a quote around a player's name) and escapes what it
 * did not write with `escapeHtml`; a connector that cannot show it sends `htmlToPlain` of it, and
 * a caption's length is that of the text it shows. The same two as grammy-switchboard's, which the
 * core cannot import (bot-os-api.md §6).
 */

/** Escapes `&`, `<` and `>`, so that a text shows as it is inside Telegram HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/**
 * The text Telegram HTML shows: its tags removed, and `&lt;`, `&gt;`, `&quot;` and `&amp;`
 * unescaped (`&amp;` last, so that `&amp;lt;` reads `&lt;`).
 */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/gu, '')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, '&');
}
