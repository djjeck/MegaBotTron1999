/**
 * What React Flow needs of a browser that happy-dom lacks, for the graph view's tests: element
 * sizes (so that nodes are measured and shown), a `ResizeObserver` that reports at once, and the
 * view's transform matrix (React Flow's own testing guide). Typed loosely: the root's type check
 * of `test/` has no DOM types.
 */
import { vi } from 'vitest';

type Observed = (entries: { target: unknown; contentRect: object }[], o: unknown) => void;

class ResizeObserver {
  private readonly callback: Observed;

  constructor(callback: Observed) {
    this.callback = callback;
  }

  observe(target: unknown): void {
    this.callback([{ target, contentRect: { width: 800, height: 600 } }], this);
  }

  unobserve(): void {}

  disconnect(): void {}
}

class DOMMatrixReadOnly {
  readonly m22: number;

  constructor(transform?: string) {
    const scale = /scale\(([\d.]+)\)/u.exec(transform ?? '')?.[1];
    this.m22 = scale === undefined ? 1 : Number(scale);
  }
}

/** Installs the stubs; `vi.unstubAllGlobals` and `restore` take them away. */
export function stubReactFlow(): () => void {
  vi.stubGlobal('ResizeObserver', ResizeObserver);
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnly);
  const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement
    .prototype;
  type Styled = { style: { height: string; width: string } };
  const before = {
    offsetHeight: Object.getOwnPropertyDescriptor(proto, 'offsetHeight'),
    offsetWidth: Object.getOwnPropertyDescriptor(proto, 'offsetWidth'),
  };
  Object.defineProperties(proto, {
    offsetHeight: {
      configurable: true,
      get(this: Styled) {
        return Number.parseFloat(this.style.height) || 100;
      },
    },
    offsetWidth: {
      configurable: true,
      get(this: Styled) {
        return Number.parseFloat(this.style.width) || 200;
      },
    },
  });
  return () => {
    for (const [key, d] of Object.entries(before))
      if (d !== undefined) Object.defineProperty(proto, key, d);
  };
}
