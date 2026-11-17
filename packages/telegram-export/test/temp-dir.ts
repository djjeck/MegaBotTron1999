import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onTestFinished } from 'vitest';

/** A fresh temporary folder, deleted when the current test finishes. */
export function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-export-test-'));
  onTestFinished(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
