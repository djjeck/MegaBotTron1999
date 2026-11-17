/** What a browser folder picker gives (`<input type="file" webkitdirectory>`), for the tests. */
import { type FileLike } from '#src/browser-files.ts';

/** A file as a picker gives it, with these bytes. */
export function fileLike(relativePath: string, bytes: Uint8Array | string): FileLike {
  // A copy: a Node Buffer may be a view of a larger shared pool.
  const data = new Uint8Array(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  return {
    name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
    webkitRelativePath: relativePath,
    arrayBuffer: () => Promise.resolve(data.slice().buffer),
  };
}
