import { describe, expect, it } from 'vitest';
import {
  decodeText,
  type ExportEntry,
  linkedTextFiles,
  listExport,
  withTextFiles,
} from './listing.ts';

const file = (path: string): ExportEntry => ({ path, isFile: () => true });
const folder = (path: string): ExportEntry => ({ path, isFile: () => false });

describe('listExport', () => {
  it('pages_in_folder_then_page_number_order_whatever_the_entry_order', () => {
    const entries = [
      'in/b/messages.html',
      'in/a/messages10.html',
      'in/a/messages2.html',
      'in/a/sub/messages.html',
      'in/a/messages.html',
      'in/a-c/messages.html',
      'in/a/messages1.html', // not a page name
      'in/a/messages01.html', // not a page name
      'in/a/photos/photo_1.jpg',
    ].map(file);
    const expected = [
      'in/a/messages.html',
      'in/a/messages2.html',
      'in/a/messages10.html',
      'in/a/sub/messages.html',
      'in/a-c/messages.html',
      'in/b/messages.html',
    ];
    expect(listExport(entries).pages).toStrictEqual(expected);
    expect(listExport([...entries].reverse()).pages).toStrictEqual(expected);
  });

  it('json_exports_without_pages_are_listed_and_zip_files_warned_in_order', () => {
    const { pages, json, warnings } = listExport([
      file('in/z.zip'),
      folder('in/dir.zip'),
      file('in/json/result.json'),
      file('in/both/result.json'),
      file('in/both/messages.html'),
      file('in/a/result.json'),
    ]);
    expect(pages).toStrictEqual(['in/both/messages.html']);
    // A folder exported in both formats is read from its HTML.
    expect(json).toStrictEqual(['in/a/result.json', 'in/json/result.json']);
    expect(warnings).toStrictEqual([
      'skipping in/z.zip: zip files are not read, extract the export into a folder',
    ]);
  });
});

describe('decodeText', () => {
  it('keeps_the_bom_and_turns_line_ends_into_lf', () => {
    const bytes = new TextEncoder().encode('﻿a\r\nb\rc\n');
    expect(decodeText(bytes)).toBe('﻿a\nb\nc\n');
  });

  it('rejects_invalid_utf8', () => {
    expect(() => decodeText(new Uint8Array([0xc3]))).toThrow();
  });
});

describe('linkedTextFiles', () => {
  const link = (href: string, cls = 'media clearfix pull_left block_link media_file'): string =>
    `<a class="${cls}" href="${href}"><div class="title bold">x</div></a>`;

  it('the_attached_txt_files_once_each_beside_the_page', () => {
    const html = [
      link('files/file.txt'),
      link('files/file (1).txt'),
      link('files/file.txt'),
      link('files/a &amp; b.TXT'),
      link('files/photo.jpg'),
      link('files/sub/x.txt'),
      link('../files/x.txt'),
      link('files/other.txt', 'media clearfix pull_left block_link media_photo'),
      '<a href="#go_to_message5">reply</a>',
    ].join('\n');
    expect(linkedTextFiles('in/E/messages2.html', html)).toStrictEqual([
      { link: 'files/file.txt', path: 'in/E/files/file.txt' },
      { link: 'files/file (1).txt', path: 'in/E/files/file (1).txt' },
      { link: 'files/a & b.TXT', path: 'in/E/files/a & b.TXT' },
    ]);
    expect(linkedTextFiles('messages.html', link('files/f.txt'))).toStrictEqual([
      { link: 'files/f.txt', path: 'files/f.txt' },
    ]);
    expect(linkedTextFiles('E/messages.html', '<div class="text">media_file</div>')).toStrictEqual(
      []
    );
  });

  it('with_text_files_keeps_those_read_as_utf8', () => {
    const html = [link('files/a.txt'), link('files/b.txt'), link('files/c.txt')].join('');
    const bytes: Record<string, Uint8Array> = {
      'E/files/a.txt': new TextEncoder().encode('1\r\n'),
      'E/files/c.txt': new Uint8Array([0xe8]),
    };
    const page = withTextFiles({ label: 'E/messages.html', html }, (p) => bytes[p] ?? null);
    expect(page).toStrictEqual({
      label: 'E/messages.html',
      html,
      files: new Map([['files/a.txt', '1\n']]),
    });
    const none = { label: 'E/messages.html', html: '' };
    expect(withTextFiles(none, () => null)).toBe(none);
  });
});
