import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import { diffSummary, graphDiff, GraphFile, printable } from './graph-file.ts';
import { GraphHistory, HISTORY_KEEP } from './graph-history.ts';

const DAY = 86_400_000;
const graph = (...ids: string[]) => ({
  version: 2,
  nodes: ids.map((id) => ({ id, plugin: 'p' })),
  edges: [],
});

let dir: string;
let clock: VirtualClock;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-history-'));
  clock = new VirtualClock(Date.UTC(2026, 10, 1));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the graph history', () => {
  it('keeps versions newest first, and reads each back', () => {
    const history = new GraphHistory(path.join(dir, 'h'), () => clock.now());
    expect(history.list()).toEqual([]);
    expect(history.latest()).toBeUndefined();
    const a = history.record(graph('a'), { source: 'save', summary: '+ node a' });
    // Two in the same millisecond: the second's id says so.
    const b = history.record(graph('b'), {
      source: 'rollback',
      summary: '+ node b; − node a',
      restores: a.id,
    });
    expect(b.id).toBe(`${a.id}-1`);
    expect(history.list().map((v) => v.id)).toEqual([b.id, a.id]);
    expect(history.latest()).toMatchObject({ id: b.id, restores: a.id, graph: graph('b') });
    expect(history.started(a.id, { result: 'refused', at: 'then', problems: ['why'] })).toBe(true);
    expect(history.get(a.id)).toMatchObject({ start: { result: 'refused', problems: ['why'] } });
    expect(history.started('nope', { result: 'ran', at: 'then' })).toBe(false);
  });

  it('reads nothing outside it, nor a file that is not a version', () => {
    const history = new GraphHistory(dir, () => clock.now());
    fs.writeFileSync(path.join(dir, 'half.json'), '{half');
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ time: 't', source: 'x' }));
    fs.writeFileSync(path.join(dir, 'bare.json'), JSON.stringify({ time: 't', source: 'found' }));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a version');
    expect(history.get('../graph')).toBeUndefined();
    expect(history.get('half')).toBeUndefined();
    expect(history.get('other')).toBeUndefined();
    expect(history.list()).toEqual([{ id: 'bare', time: 't', source: 'found', summary: '' }]);
  });

  it('keeps 7 days, and never fewer than the 5 latest', () => {
    const history = new GraphHistory(dir, () => clock.now());
    for (let i = 0; i < 8; i++) {
      history.record(graph(`n${i}`), { source: 'save', summary: `${i}` });
      clock.advance(DAY);
    }
    // A day on, the first is over 7 days old: pruned, though only 5 must be kept.
    history.prune();
    expect(history.list().map((v) => v.summary)).toEqual(['7', '6', '5', '4', '3', '2', '1']);
    clock.advance(30 * DAY);
    history.prune();
    expect(history.list()).toHaveLength(HISTORY_KEEP);
  });
});

describe('the graph file at a start', () => {
  const core = (problems: string[] = []) => ({
    graphProblems: () => problems.map((text) => ({ text })),
  });

  it('takes the files before the history into it, at their times', () => {
    fs.writeFileSync(path.join(dir, 'graph.previous.json'), JSON.stringify(graph('a')));
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph('a', 'b')));
    const then = new Date(clock.now() - DAY);
    fs.utimesSync(path.join(dir, 'graph.previous.json'), then, then);
    fs.utimesSync(path.join(dir, 'graph.json'), then, then);
    const file = new GraphFile(dir, () => clock.now());
    file.started(core());
    expect(fs.existsSync(file.previous)).toBe(false);
    expect(file.history.list()).toEqual([
      {
        id: '2026-10-31T00-00-00.001Z',
        time: '2026-10-31T00:00:00.001Z',
        source: 'migrated',
        summary: '+ node b',
        start: { result: 'ran', at: '2026-11-01T00:00:00.000Z' },
      },
      {
        id: '2026-10-31T00-00-00.000Z',
        time: '2026-10-31T00:00:00.000Z',
        source: 'migrated',
        summary: '+ node a',
      },
    ]);
    // A later start on the same file adds no version; one on a file changed by hand does.
    clock.advance(1000);
    file.started(core(['node b: refused']));
    expect(file.history.list()).toHaveLength(2);
    expect(file.history.latest()).toMatchObject({
      start: { result: 'refused', problems: ['node b: refused'] },
    });
    fs.writeFileSync(file.file, JSON.stringify(graph('c')));
    file.started(core());
    expect(file.history.latest()).toMatchObject({
      source: 'found',
      summary: '+ node c; − node a; − node b',
      start: { result: 'ran' },
    });
  });

  it('keeps nothing without a file, or with one that does not read', () => {
    const file = new GraphFile(dir, () => clock.now());
    file.started(core());
    expect(file.history.list()).toEqual([]);
    fs.writeFileSync(file.previous, '{half');
    fs.writeFileSync(file.file, '{half');
    file.started(core(['not JSON']));
    expect(file.history.list()).toEqual([]);
    expect(fs.existsSync(file.previous)).toBe(true);
  });
});

describe('a diff on one line', () => {
  it('names what is added, removed and changed, and counts past its limit', () => {
    const before = {
      nodes: [
        { id: 'x', plugin: 'p' },
        { id: 'gone', plugin: 'p' },
      ],
      edges: [
        { from: 'a.chat', to: 'b.chat', type: 'chat-in' },
        { from: 'x.out', to: 'y.in', reads: ['#a'] },
      ],
    };
    const after = {
      nodes: [
        { id: 'x', plugin: 'p', config: { k: 1 } },
        { id: 'examine', plugin: 'p' },
      ],
      edges: [
        { from: 'x.out', to: 'y.in', reads: ['#b'] },
        { from: 'c.chat', to: 'd.chat' },
      ],
    };
    const d = graphDiff(before, after);
    expect(diffSummary(d)).toBe(
      '+ node examine; − node gone; ~ node x: config; + edge c.chat → d.chat; − edge a.chat → b.chat; ~ edge x.out → y.in: reads'
    );
    expect(diffSummary(d, 2)).toBe('+ node examine; − node gone; … 4 more');
    expect(diffSummary(graphDiff(before, before))).toBe('no change');
  });

  it('prints a graph as a file holds it, leaving out what does not fit', () => {
    expect(
      printable({
        nodes: [
          { id: 'a', plugin: 'p', instance: 'i', account: 'x:y', mode: 'live', config: { k: 1 } },
          { id: 'b', settings: { s: true } },
          { plugin: 'p' },
          'x',
        ],
        edges: [
          { from: 'a.o', to: 'b.i', type: 'chat-in', reads: ['#a', 1], sends: 's', commands: [] },
          { from: 'a.o' },
        ],
      })
    ).toEqual({
      version: 2,
      nodes: [
        { id: 'a', plugin: 'p', instance: 'i', account: 'x:y', mode: 'live', config: { k: 1 } },
        { id: 'b', plugin: '?', settings: { s: true } },
      ],
      edges: [{ from: 'a.o', to: 'b.i', type: 'chat-in', reads: ['#a'], commands: [] }],
    });
    expect(printable(null)).toEqual({ version: 2, nodes: [], edges: [] });
  });
});
