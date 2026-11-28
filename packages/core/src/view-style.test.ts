/**
 * A view's stylesheet (bot-os.md D175): checked as its module loads, refused unless safe, served
 * from the instance scoped to the view's body; and a view's theme.
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { manifestOf, tempDir, writeModule } from '#test/modules.ts';
import { VirtualClock } from './clock.ts';
import { controlServer } from './control-server.ts';
import { Core } from './core.ts';
import { loadModules, moduleSheet } from './module-loader.ts';
import {
  checkViewSheet,
  MAX_SHEET_BYTES,
  MAX_Z,
  scopedSheet,
  ViewStyleError,
} from './view-style.ts';
import { themeSchema, viewSchema } from './widgets.ts';

const none = { name: 'views/shop.css', picture: () => undefined };

/** The problems a sheet has; none when it stands. */
function problems(css: string, picture: (p: string) => string | undefined = () => undefined) {
  try {
    checkViewSheet(css, { name: 'views/shop.css', picture });
    return [];
  } catch (e) {
    if (e instanceof ViewStyleError) return e.problems;
    throw e;
  }
}

describe('a view’s stylesheet (D175)', () => {
  it('takes what arranges and colours, custom properties, media queries and pictures of its own', () => {
    const style = checkViewSheet(
      [
        '.card { background: color-mix(in srgb, var(--view-accent) 10%, white); border-radius: 4px; }',
        '.stat-value { font-weight: 800; color: oklch(60% 0.2 250); z-index: 3; position: relative; }',
        ':scope { --view-accent: teal; display: grid; gap: calc(1rem + 2px); }',
        '@media (max-width: 640px) { .gallery { grid-template-columns: repeat(2, minmax(0, 1fr)); } }',
        '@supports (display: grid) { .tag:not(.x) { border: 1px dashed currentColor; } }',
        '.leaf-stat { background-image: url(pictures/coin.png), linear-gradient(red, blue); }',
      ].join('\n'),
      {
        name: 'views/shop.css',
        picture: (p) => (p === 'pictures/coin.png' ? '/m/coin.png' : undefined),
      }
    );
    expect(style.css).toContain('url(files/pictures/coin.png)');
    expect(style.files).toEqual({
      'pictures/coin.png': { file: '/m/coin.png', type: 'image/png' },
    });
    expect(scopedSheet(style, 'home')).toMatch(/^@scope \(\[data-view-body="home"\]\) \{\n/u);
    expect(() => scopedSheet(style, 'x"]{')).toThrow("not a node's id");
  });

  it('refuses what reaches past the view, hides, draws or loads, each at its line', () => {
    const p = problems(
      [
        '@import url(other.css);',
        '@font-face { font-family: x; }',
        '.a { position: fixed; }',
        '.b { position: sticky; }',
        '.c { z-index: 999; }',
        '.d { z-index: -1; }',
        '.e::after { content: "Pay"; }',
        '.f { display: none; }',
        '.g { opacity: 0; visibility: hidden; transform: scale(0); }',
        '.h { color: red !important; }',
        '.i { background: url(https://example.net/x.png); }',
        '.j { background: url(../secret.png); }',
        '.k { width: attr(data-w); }',
        '.l { background: url(pictures/coin.svg); }',
      ].join('\n')
    ).join('\n');
    for (const said of [
      'line 1: @import is not allowed',
      'line 2: @font-face is not allowed',
      'line 3: position: fixed is not allowed',
      'line 4: position: sticky is not allowed',
      `line 5: z-index: 999 is not allowed: from 0 to ${MAX_Z}`,
      'line 6: z-index: -1 is not allowed',
      'line 7: content is not allowed',
      'line 8: display: none is not allowed',
      'line 9: opacity is not allowed',
      'line 9: visibility is not allowed',
      'line 9: transform is not allowed',
      'line 10: color: !important is not allowed',
      'line 11: url(https://example.net/x.png) is not allowed',
      'line 12: url(../secret.png) is not allowed',
      'line 13: attr() is not allowed',
      'line 14: url(pictures/coin.svg) is not allowed',
    ])
      expect(p).toContain(said);
    expect(problems('.a { color: red')).toEqual([]);
    expect(problems('.a { color: red; } }}} @')).not.toEqual([]);
    expect(() => checkViewSheet('a'.repeat(MAX_SHEET_BYTES + 1), none)).toThrow('over 64 KiB');
  });
});

describe('a module’s view stylesheet as it loads (D175)', () => {
  const VIEW_ENTRY = (sheet: string): string =>
    `export const plugins = [{ manifest: { id: 'shop-view', kinds: ['view'], description: 'A view', view: { title: 'Shop', sections: [], stylesheet: '${sheet}' } }, create: () => ({}) }];\n`;

  it('reads and checks it, its pictures beside it within the module', async () => {
    const root = tempDir();
    writeModule(root, 'shop', manifestOf('shop', { plugins: ['src/p.ts'] }), {
      'src/p.ts': VIEW_ENTRY('views/shop.css'),
      'views/shop.css': '.card { background: url(coin.png) teal; }',
      'views/coin.png': 'png',
    });
    const r = await loadModules({ dir: root, host: 'file:///app/src/main.ts', register: () => {} });
    expect(r.failures).toEqual([]);
    expect(Object.keys(r.modules[0]?.styles ?? {})).toEqual(['shop-view']);
    expect(r.modules[0]?.styles?.['shop-view']?.files['coin.png']?.type).toBe('image/png');
  });

  it('refuses the module whose stylesheet is not safe, or not there', async () => {
    const root = tempDir();
    writeModule(root, 'bad', manifestOf('bad', { plugins: ['src/p.ts'] }), {
      'src/p.ts': VIEW_ENTRY('views/bad.css'),
      'views/bad.css': '.a { position: fixed; }',
    });
    writeModule(root, 'gone', manifestOf('gone', { plugins: ['src/p.ts'] }), {
      'src/p.ts': VIEW_ENTRY('views/gone.css').replace("'shop-view'", "'gone-view'"),
    });
    const r = await loadModules({ dir: root, host: 'file:///app/src/main.ts', register: () => {} });
    expect(r.failures.map((f) => [f.id, f.reason])).toEqual([
      [
        'bad',
        'views/bad.css is refused: line 1: position: fixed is not allowed: it would reach past the view',
      ],
      ['gone', 'its stylesheet views/gone.css is not in the module'],
    ]);
  });

  it('takes no picture outside the module, through a link', () => {
    const root = tempDir();
    const dir = path.join(root, 'm');
    fs.mkdirSync(path.join(dir, 'views'), { recursive: true });
    fs.writeFileSync(path.join(root, 'outside.png'), 'png');
    fs.symlinkSync(path.join(root, 'outside.png'), path.join(dir, 'views', 'out.png'));
    fs.writeFileSync(path.join(dir, 'views', 'a.css'), '.a { background: url(out.png); }');
    expect(() => moduleSheet(dir, 'views/a.css')).toThrow('url(out.png) is not allowed');
  });
});

let server: http.Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe('a view’s stylesheet served (D175)', () => {
  it('serves it scoped to the node’s view body, and its pictures, from the instance', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'views'));
    fs.writeFileSync(path.join(root, 'views', 'coin.png'), Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(path.join(root, 'views', 'shop.css'), '.card { background: url(coin.png); }');
    const style = moduleSheet(root, 'views/shop.css');
    const core = new Core({
      clock: new VirtualClock(),
      graph: {
        version: 2,
        nodes: [
          { id: 'home', plugin: 'shop-view' },
          { id: 'plain', plugin: 'plain' },
        ],
        edges: [],
      },
    });
    core.registerModule(
      'shop',
      [
        {
          manifest: {
            id: 'shop-view',
            kinds: ['view'],
            description: 'A view',
            view: { title: 'Shop', sections: [], stylesheet: 'views/shop.css' },
          },
          create: () => ({}),
        },
        { manifest: { id: 'plain', kinds: ['stats'], description: 'Plain' }, create: () => ({}) },
      ],
      '0.1.0',
      { 'shop-view': style }
    );
    await core.start();
    server = controlServer({ controls: core.controls, settings: core.settings });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);
    const css = await get('/views/home/style.css');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await css.text()).toContain('@scope ([data-view-body="home"])');
    const png = await get('/views/home/files/coin.png');
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('content-security-policy')).toContain('sandbox');
    expect((await get('/views/plain/style.css')).status).toBe(404);
    expect((await get('/views/home/files/other.png')).status).toBe(404);
    fs.rmSync(path.join(root, 'views', 'coin.png'));
    expect((await get('/views/home/files/coin.png')).status).toBe(404);
  });
});

describe('a view’s theme (D175)', () => {
  it('takes colours light and dark, density, radius and font', () => {
    expect(
      themeSchema.parse({
        light: {
          accent: '#0f766e',
          surface: 'rgb(250 250 249)',
          chart: ['teal', 'oklch(70% 0.1 80)'],
        },
        dark: { accent: '#5eead4' },
        density: 'compact',
        radius: 6,
        font: 'rounded',
      }).density
    ).toBe('compact');
    const wrong = (theme: unknown): string => {
      const r = themeSchema.safeParse(theme);
      return r.success ? '' : r.error.issues.map((i) => i.message).join('; ');
    };
    expect(wrong({ light: { accent: 'url(x)' } })).toContain('expected a colour');
    expect(wrong({ light: { border: 'red' } })).not.toBe('');
    expect(wrong({ density: 'tight' })).toContain('expected a density');
    expect(wrong({ font: 'comic' })).toContain('expected a font');
    expect(wrong({ radius: 40 })).not.toBe('');
    expect(viewSchema.safeParse({ title: 'x', stylesheet: 'shop.css' }).success).toBe(false);
  });
});

describe('the views cookbook’s stylesheet (docs/views.md)', () => {
  it('passes the check as it is written', () => {
    const doc = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/views.md'),
      'utf8'
    );
    const css = /```css\n([\s\S]*?)```/u.exec(doc)?.[1] ?? '';
    expect(css).toContain('.stat-value');
    const style = checkViewSheet(css, { name: 'views/shop.css', picture: (p) => `/m/views/${p}` });
    expect(Object.keys(style.files)).toEqual(['paper.png']);
  });
});
