import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUEST_HTML, QUEST_JSON, QUEST_MAPPING_FILE } from '#test/quest.ts';
import { exportCli, USAGE } from './cli.ts';

function run(...args: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = exportCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

describe('the command line', () => {
  it('prints_the_messages_as_json_lines', () => {
    const { code, out, err } = run(QUEST_HTML);
    expect(code).toBe(0);
    expect(out).toHaveLength(11);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      chat: 'QuestBot',
      id: 100,
      text: '/play',
    });
    expect(err).toStrictEqual(['exports: 2; chats: Quest Lobby, QuestBot']);
  });

  it('prints_the_inbounds_of_a_mapping', () => {
    const { code, out } = run('--inbounds', QUEST_MAPPING_FILE, '--playback', QUEST_JSON);
    expect(code).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      account: 'telegram:alice',
      chat: '@QuestBot',
      own: true,
      playback: true,
    });
  });

  it('reads_a_macos_export_in_the_time_zone_given', () => {
    const { code, err } = run('--time-zone', 'Mars/Base', path.join(QUEST_HTML, 'x.json'));
    // Nothing to read: a warning, and no time zone needed.
    expect(code).toBe(0);
    expect(err[0]).toMatch(/^skipping .*x\.json: not a folder/u);
  });

  it('refuses_bad_arguments', () => {
    expect(run()).toMatchObject({ code: 2, err: [USAGE] });
    expect(run('--time-zone')).toMatchObject({ code: 2 });
    expect(run('--frobnicate', 'x').err[0]).toMatch(/^unknown option --frobnicate/u);
    expect(run('--help')).toMatchObject({ code: 0, out: [USAGE] });
    const bad = exportCli(['--inbounds', 'mapping.json', QUEST_HTML], {
      out: () => {},
      err: () => {},
      readFile: () => 'not json',
    });
    expect(bad).toBe(1);
    const thrown: string[] = [];
    exportCli(['--inbounds', 'm.json', QUEST_HTML], {
      out: () => {},
      err: (l) => thrown.push(l),
      readFile: () => {
        throw 'gone';
      },
    });
    expect(thrown).toStrictEqual(['gone']);
  });
});
