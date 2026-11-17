import { describe, expect, it } from 'vitest';
import { feedHtml } from './html-events.ts';

/** The events of `html`, attributes as plain objects. */
function events(html: string): unknown[] {
  const out: unknown[] = [];
  feedHtml(html, {
    starttag: (tag, attrs) => out.push(['start', tag, Object.fromEntries(attrs)]),
    startendtag: (tag, attrs) => out.push(['startend', tag, Object.fromEntries(attrs)]),
    endtag: (tag) => out.push(['end', tag]),
    data: (text) => out.push(['data', text]),
  });
  return out;
}

describe('html events', () => {
  it('tags_and_attributes_as_written', () => {
    expect(events('<DIV Class="x" class="y" hidden data-x=\'1\' n=v>t&amp;u</DIV>')).toStrictEqual([
      ['start', 'div', { class: 'y', hidden: null, 'data-x': '1', n: 'v' }],
      ['data', 't&u'],
      ['end', 'div'],
    ]);
  });

  it('self_closing_tags_and_entities_in_attributes', () => {
    expect(events('<br/>x<img src="a&lt;b"/>')).toStrictEqual([
      ['startend', 'br', {}],
      ['data', 'x'],
      ['startend', 'img', { src: 'a<b' }],
    ]);
  });

  it('a_less_than_sign_that_opens_no_markup_is_data_of_its_own', () => {
    expect(events('a < b')).toStrictEqual([
      ['data', 'a '],
      ['data', '<'],
      ['data', ' b'],
    ]);
  });

  it('numeric_entities_decoded_unknown_ones_kept', () => {
    expect(events('x &#x1F600; &unknown; y')).toStrictEqual([['data', 'x 😀 &unknown; y']]);
  });

  it('comments_cdata_declarations_and_processing_instructions_split_the_text', () => {
    expect(events('a<!-- c -->b<![CDATA[z]]>c<!DOCTYPE html>d<?xml x?>e')).toStrictEqual([
      ['data', 'a'],
      ['data', 'b'],
      ['data', 'c'],
      ['data', 'd'],
      ['data', 'e'],
    ]);
  });
});
