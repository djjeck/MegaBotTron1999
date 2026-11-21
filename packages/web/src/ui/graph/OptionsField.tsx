/**
 * A field whose options a read of its node gives (docs/bot-os.md D157): an action's input field
 * whose schema says `options: { read, path?, value?, label? }` (a plugin's zod `.meta({ options })`,
 * as a manifest cannot list options that change while it runs: a cast edited in a collection). Its
 * node's read is asked once (`GET /plugins/<id>/state/<read>`), and its items, at `path`, made
 * choices: each one's value at `value` (the item itself for none), its label at `label` (its value
 * for none). A value that is not among them (gone since) stays, shown as it is. The action still
 * checks what it gets. Drawn by `SchemaForm` wherever a form knows its node: a row action's
 * form on a node's page, an action called from its panel.
 */
import { useEffect, useState } from 'react';
import type { OptionsSource } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import { at, itemsOf } from './widget-text.ts';

/** One choice: its value, and its label. */
export interface Option {
  value: string;
  label: string;
}

const scalar = (v: unknown): v is string | number => typeof v === 'string' || typeof v === 'number';

/** The options a read's output gives, as `spec` says where (items without a value left out). */
export function optionsOf(output: unknown, spec: OptionsSource): Option[] {
  return (itemsOf(at(output, spec.path)) ?? []).flatMap((item) => {
    const v = at(item, spec.value);
    if (!scalar(v)) return [];
    const l = spec.label === undefined ? v : at(item, spec.label);
    return [{ value: String(v), label: scalar(l) ? String(l) : String(v) }];
  });
}

/** The options a schema says a read gives, or undefined when it says none, or not as it should. */
export function optionsSource(schema: Record<string, unknown>): OptionsSource | undefined {
  const o = schema['options'];
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return undefined;
  const read = (o as { read?: unknown }).read;
  return typeof read === 'string' ? (o as OptionsSource) : undefined;
}

export function OptionsField(props: {
  name: string;
  node: string;
  spec: OptionsSource;
  value: unknown;
  set: ((v: unknown) => void) | undefined;
}) {
  const { name, node, spec, value, set } = props;
  const [options, setOptions] = useState<Option[]>();
  const [error, setError] = useState<string>();
  const key = JSON.stringify(spec);
  useEffect(() => {
    let live = true;
    api<unknown>(`/plugins/${seg(node)}/state/${seg(spec.read)}`).then(
      (out) => {
        if (live) setOptions(optionsOf(out, spec));
      },
      (e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    );
    return () => {
      live = false;
    };
    // The spec is the schema's: asked again only when it or the node changes.
  }, [node, key]);
  const current = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const shown = options ?? [];
  const gone = current !== '' && !shown.some((o) => o.value === current);
  return (
    <>
      <select
        aria-label={name}
        value={current}
        disabled={set === undefined || options === undefined}
        onChange={(e) => set?.(e.target.value === '' ? undefined : e.target.value)}
      >
        <option value="">{options === undefined && error === undefined ? 'reading…' : ''}</option>
        {gone ? <option value={current}>{current}</option> : null}
        {shown.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error === undefined ? null : <small className="error">{error}</small>}
    </>
  );
}
