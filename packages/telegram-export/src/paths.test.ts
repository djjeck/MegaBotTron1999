import { describe, expect, it } from 'vitest';
import { comparePaths, normalizePath, pathName, pathParent, pathSuffix } from './paths.ts';

describe('paths', () => {
  it('path normalisation and ordering', () => {
    expect(normalizePath('./inbox//a/')).toBe('inbox/a');
    expect(pathParent('messages.html')).toBe('.');
    expect(comparePaths('a/b.zip', 'a-c/x.zip')).toBeLessThan(0); // by parts, not by string
    expect(comparePaths('a', 'a/b')).toBeLessThan(0); // a folder before its subfolders
    expect(comparePaths('./a', 'a')).toBe(0);
  });

  it('roots and empty paths', () => {
    // POSIX keeps exactly two leading slashes as a distinct root; three or more are one.
    expect(['', '.', '/', '//', '///', '//srv/x/'].map(normalizePath)).toStrictEqual([
      '.',
      '.',
      '/',
      '//',
      '/',
      '//srv/x',
    ]);
    expect(['', '/', '//srv/x', '/a', 'a/b/'].map(pathParent)).toStrictEqual([
      '.',
      '/',
      '//srv',
      '/',
      'a',
    ]);
    expect(['', '/', '//srv/x/', 'a/b/'].map(pathName)).toStrictEqual(['', '', 'x', 'b']);
  });

  it('pathSuffix is the extension of the last component only', () => {
    expect(
      ['a.html', 'a/b.tar.gz', '.bashrc', 'x.', 'dir.d/file', ''].map(pathSuffix)
    ).toStrictEqual(['.html', '.gz', '', '', '', '']);
  });
});
