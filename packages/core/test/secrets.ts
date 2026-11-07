/** Docker secrets for tests: files in a temporary directory, as /run/secrets holds them. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Secrets } from '#src/secrets.ts';

export function secretsWith(values: Record<string, string>): Secrets {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
  for (const [name, value] of Object.entries(values))
    fs.writeFileSync(path.join(dir, name), `${value}\n`);
  return new Secrets(dir);
}
