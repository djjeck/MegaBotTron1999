import { describe, expect, it } from 'vitest';
import { escapeHtml, htmlToPlain } from './html.ts';

describe('escapeHtml', () => {
  it('escapes &, < and >, and nothing else', () => {
    expect(escapeHtml(`<<Dr. Fish>> & "co" ¯\\_(ツ)_/¯ -> &lt;`)).toBe(
      `&lt;&lt;Dr. Fish&gt;&gt; &amp; "co" ¯\\_(ツ)_/¯ -&gt; &amp;lt;`
    );
  });
});

describe('htmlToPlain', () => {
  it('strips the tags and unescapes the entities, &amp; last', () => {
    expect(
      htmlToPlain(
        '<u>Menu:</u>\n<blockquote><b>a &lt;b&gt; &amp; &quot;c&quot;</b></blockquote> &amp;lt;'
      )
    ).toBe('Menu:\na <b> & "c" &lt;');
  });

  it('reads escaped text back as it was', () => {
    const name = '<<ASCII>> & art --> |>';
    expect(htmlToPlain(`<b>${escapeHtml(name)}</b>`)).toBe(name);
  });
});
