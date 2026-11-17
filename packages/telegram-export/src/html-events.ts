/**
 * Raw, tree-less HTML events on top of htmlparser2's Tokenizer.
 *
 * htmlparser2's `Parser` builds an implicit tree (implied end tags, void elements,
 * first duplicate attribute wins). The HTML reader's state machine needs the markup exactly
 * as written, so this adapter builds its events from the Tokenizer: every tag is
 * reported as written, `<x/>` is a start-end tag, attribute names are lower-cased, a
 * duplicate attribute keeps the last value, a valueless attribute is `null`, and text
 * between two markup tokens arrives as one `data` call, with entities decoded.
 */
import { QuoteType, Tokenizer } from 'htmlparser2';

/** Attributes of a tag, last value wins for duplicates; valueless attributes are `null`. */
export type Attrs = Map<string, string | null>;

export interface HtmlEvents {
  starttag(tag: string, attrs: Attrs): void;
  startendtag(tag: string, attrs: Attrs): void;
  endtag(tag: string): void;
  data(text: string): void;
}

/** Tokenizes `html` completely and reports its events to `h`. */
export function feedHtml(html: string, h: HtmlEvents): void {
  let text: string[] = [];
  let tag = '';
  let attrs: Attrs = new Map();
  let attrName = '';
  let attrValue = '';

  const flushText = (): void => {
    if (text.length === 0) return;
    const s = text.join('');
    text = [];
    if (s !== '') h.data(s);
  };

  const tokenizer = new Tokenizer(
    { decodeEntities: true },
    {
      ontext(start, end) {
        // A "<" that does not open markup is reported as a data chunk of its own.
        if (html[start] === '<') {
          flushText();
          text.push('<');
          flushText();
          start++;
        }
        if (end > start) text.push(html.slice(start, end));
      },
      ontextentity(cp) {
        text.push(String.fromCodePoint(cp));
      },
      onopentagname(start, end) {
        flushText();
        tag = html.slice(start, end).toLowerCase();
        attrs = new Map();
      },
      onattribname(start, end) {
        attrName = html.slice(start, end).toLowerCase();
        attrValue = '';
      },
      onattribdata(start, end) {
        attrValue += html.slice(start, end);
      },
      onattribentity(cp) {
        attrValue += String.fromCodePoint(cp);
      },
      onattribend(quote) {
        attrs.set(attrName, quote === QuoteType.NoValue ? null : attrValue);
        attrValue = '';
      },
      onopentagend() {
        h.starttag(tag, attrs);
      },
      onselfclosingtag() {
        h.startendtag(tag, attrs);
      },
      onclosetag(start, end) {
        flushText();
        h.endtag(html.slice(start, end).toLowerCase());
      },
      oncomment() {
        flushText();
      },
      oncdata() {
        flushText();
      },
      ondeclaration() {
        flushText();
      },
      onprocessinginstruction() {
        flushText();
      },
      onend() {
        flushText();
      },
    }
  );
  tokenizer.write(html);
  tokenizer.end();
}
