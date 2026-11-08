import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { paxRecord, tarOf, tempDir } from '#test/modules.ts';
import { extractTar } from './tar.ts';

const read = (dir: string, file: string): string => fs.readFileSync(path.join(dir, file), 'utf8');

describe('extractTar', () => {
  it('unpacks files and directories, with pax, GNU and ustar long names', () => {
    const dest = path.join(tempDir(), 'out');
    const long = `${'d'.repeat(120)}/file.ts`;
    extractTar(
      zlib.gzipSync(
        tarOf([
          { name: './' },
          { name: './src/' },
          { name: './src/a.ts', data: 'a' },
          { name: 'PaxHeader', type: 'x', data: paxRecord('path', long) + paxRecord('mtime', '1') },
          { name: 'truncated', data: 'pax' },
          { name: '././@LongLink', type: 'L', data: 'gnu/long/name.ts\0' },
          { name: 'truncated', data: 'gnu' },
          { name: 'name.ts', prefix: 'ustar/prefix', data: 'ustar' },
          { name: 'global', type: 'g', data: paxRecord('comment', 'x') },
          { name: 'src/._a.ts', data: 'apple' },
          { name: 'empty', data: '' },
          { name: 'odd-pax', type: 'x', data: 'not a record' },
          { name: 'after-odd-pax', data: 'ok' },
        ])
      ),
      dest
    );
    expect(read(dest, 'src/a.ts')).toBe('a');
    expect(read(dest, long)).toBe('pax');
    expect(read(dest, 'gnu/long/name.ts')).toBe('gnu');
    expect(read(dest, 'ustar/prefix/name.ts')).toBe('ustar');
    expect(read(dest, 'empty')).toBe('');
    expect(read(dest, 'after-odd-pax')).toBe('ok');
    expect(fs.existsSync(path.join(dest, 'src/._a.ts'))).toBe(false);
  });

  it('refuses links, paths out of the directory, and an archive cut short', () => {
    const dest = tempDir();
    expect(() => extractTar(tarOf([{ name: 'link', type: '2', data: '' }]), dest)).toThrow(
      'tar: link is not a file or a directory (type 2)'
    );
    for (const name of ['/etc/passwd', 'a/../../b', 'C:/x'])
      expect(() => extractTar(tarOf([{ name, data: '' }]), dest)).toThrow('leaves');
    const whole = tarOf([{ name: 'big', data: 'x'.repeat(2000) }]);
    expect(() => extractTar(whole.subarray(0, 1024), dest)).toThrow('cut short');
  });
});
