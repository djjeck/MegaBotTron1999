// @vitest-environment happy-dom
/** A page left open across an upgrade (#74): told when the instance serves another app. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appChanged, entryOf, ownEntry } from './stale.ts';

/** A page's entry script, as the built page names it; typed once in, as happy-dom runs none. */
function loaded(src: string): void {
  const script = document.createElement('script');
  script.setAttribute('type', 'text/plain');
  script.setAttribute('src', src);
  document.head.append(script);
  script.setAttribute('type', 'module');
}

const page = (src: string): string =>
  `<!doctype html><html><head><script>1</script><script type="module" crossorigin src="${src}"></script></head></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

describe('the app a page runs (#74)', () => {
  it('reads a page’s entry script, its module script’s', () => {
    expect(entryOf(page('./assets/index-AAA.js'))).toBe('./assets/index-AAA.js');
    expect(entryOf('<script src="./x.js"></script><script type=module>1</script>')).toBeUndefined();
    expect(entryOf('no script')).toBeUndefined();
  });

  it('knows the one this page loaded, none in a page without', () => {
    expect(ownEntry()).toBeUndefined();
    loaded('./assets/index-AAA.js');
    expect(ownEntry()).toBe('./assets/index-AAA.js');
  });

  it('says whether the instance serves another, never asking without one of its own', async () => {
    const served = vi.fn((_: string, _init?: RequestInit) =>
      Promise.resolve(new Response(page('./assets/index-BBB.js')))
    );
    vi.stubGlobal('fetch', served);
    expect(await appChanged(undefined)).toBe(false);
    expect(served).not.toHaveBeenCalled();
    expect(await appChanged('./assets/index-AAA.js')).toBe(true);
    expect(served).toHaveBeenCalledWith('./', { cache: 'no-store', credentials: 'same-origin' });
    expect(await appChanged('./assets/index-BBB.js')).toBe(false);
  });

  it('takes no answer, a refusal or a page without an entry for no change', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    expect(await appChanged('./assets/index-AAA.js')).toBe(false);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('down', { status: 502 })));
    expect(await appChanged('./assets/index-AAA.js')).toBe(false);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<p>hello</p>')));
    expect(await appChanged('./assets/index-AAA.js')).toBe(false);
  });
});
