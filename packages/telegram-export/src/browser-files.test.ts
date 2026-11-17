import { describe, expect, it } from 'vitest';
import { fileLike } from '#test/browser-picks.ts';
import { inputFolders, listFolder, readFolderPages } from './browser-files.ts';

describe('inputFolders', () => {
  it('each_top_folder_of_each_pick_is_an_input_folder_in_pick_order', () => {
    const folders = inputFolders([
      [fileLike('B/messages.html', 'b'), fileLike('A/messages.html', 'a')],
      [fileLike('C/x/messages.html', 'c')],
    ]);
    expect(folders.map((f) => [f.name, [...f.files.keys()]])).toStrictEqual([
      ['B', ['B/messages.html']],
      ['A', ['A/messages.html']],
      ['C', ['C/x/messages.html']],
    ]);
  });

  it('a_folder_name_seen_before_is_numbered', () => {
    const folders = inputFolders([
      [fileLike('Export/messages.html', '1')],
      [fileLike('Export/messages.html', '2')],
      [fileLike('Export/messages.html', '3'), fileLike('loose.html', '')],
      [fileLike('other.html', '')],
    ]);
    expect(folders.map((f) => [f.name, [...f.files.keys()]])).toStrictEqual([
      ['Export', ['Export/messages.html']],
      ['Export (2)', ['Export (2)/messages.html']],
      ['Export (3)', ['Export (3)/messages.html']],
      ['.', ['loose.html']],
      ['. (2)', ['. (2)/other.html']],
    ]);
  });
});

describe('readFolderPages', () => {
  it('reads_the_listed_pages_as_on_disk', async () => {
    const [folder] = inputFolders([
      [
        fileLike('E/messages2.html', 'two\r\n'),
        fileLike('E/messages.html', 'one\r'),
        fileLike('E/photos/a.jpg', new Uint8Array([0xff])),
      ],
    ]);
    if (folder === undefined) throw new Error('no folder');
    const { pages, warnings } = listFolder(folder);
    expect(warnings).toStrictEqual([]);
    const read: string[] = [];
    expect(await readFolderPages(folder, pages, (l) => read.push(l))).toStrictEqual([
      { label: 'E/messages.html', html: 'one\n' },
      { label: 'E/messages2.html', html: 'two\n' },
    ]);
    expect(read).toStrictEqual(['E/messages.html', 'E/messages2.html']);
  });

  it('reads_the_text_files_a_page_links_to', async () => {
    const html = '<a class="media media_file" href="files/file (1).txt">f</a>';
    const [folder] = inputFolders([
      [fileLike('E/messages.html', html), fileLike('E/files/file (1).txt', '3x\r\n')],
    ]);
    if (folder === undefined) throw new Error('no folder');
    expect(await readFolderPages(folder, listFolder(folder).pages)).toStrictEqual([
      { label: 'E/messages.html', html, files: new Map([['files/file (1).txt', '3x\n']]) },
    ]);
  });
});
