// @vitest-environment happy-dom
/**
 * The form builder's media field, long text and list of objects (docs/bot-os.md D155), as any
 * action's input or config draws them: a file picked, previewed, refused past its limits, replaced
 * and removed; a kept media shown through its address.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonSchema } from '#src/ui/api.ts';
import { withDefaults } from './defaults.ts';
import {
  accepted,
  BYTES_KEY,
  fileRefusal,
  limitsText,
  mediaLimits,
  toBase64,
} from './MediaField.tsx';
import { SchemaForm } from './SchemaForm.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MB = 2 ** 20;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A Media's JSON Schema, as the core's `mediaField` writes it. */
const media = (limits: object, description?: string): JsonSchema => ({
  type: 'object',
  properties: { data: {}, mime: { type: 'string' } },
  required: ['data', 'mime'],
  media: limits,
  ...(description === undefined ? {} : { description }),
});

const CARD: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    behaviour: { type: 'string', long: true },
    face: media({ kinds: ['image'], maxBytes: 10 * MB }, 'A face, for the picture model'),
  },
  required: ['name', 'face'],
};

/** A form kept in state, its value shown for the test to read. */
function Harness(props: {
  schema: JsonSchema;
  start?: Record<string, unknown>;
  src?: (v: unknown) => string | undefined;
}) {
  const [value, setValue] = useState<Record<string, unknown>>(props.start ?? {});
  return (
    <>
      <SchemaForm
        legend="card"
        schema={props.schema}
        value={value}
        onChange={setValue}
        mediaSrc={props.src}
      />
      <pre aria-label="value">{JSON.stringify(value)}</pre>
    </>
  );
}
const valueOf = (): Record<string, unknown> =>
  JSON.parse(screen.getByLabelText('value').textContent ?? '{}') as Record<string, unknown>;

const file = (bytes: number[], name: string, type: string): File =>
  new File([new Uint8Array(bytes)], name, { type });

describe('a media field', () => {
  it('picks a file, previews it, replaces and removes it', async () => {
    render(<Harness schema={CARD} />);
    const face = screen.getByRole('group', { name: 'face' });
    expect(within(face).getByText('none')).toBeDefined();
    expect(within(face).getByText('image, up to 10.0 MB')).toBeDefined();
    expect(within(face).getByText('Choose a file')).toBeDefined();
    const input = within(face).getByLabelText('face file');
    expect(input.getAttribute('accept')).toBe('image/*');
    fireEvent.change(input, { target: { files: [file(PNG, 'ada.png', 'image/png')] } });
    await waitFor(() => expect(valueOf()['face']).toBeDefined());
    expect(valueOf()['face']).toMatchObject({
      data: { [BYTES_KEY]: toBase64(new Uint8Array(PNG)) },
      mime: 'image/png',
    });
    const img = within(face).getByRole('img', { name: 'face preview' });
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${toBase64(new Uint8Array(PNG))}`);
    expect(within(face).getByText('image/png, 8 B')).toBeDefined();
    expect(within(face).getByText('Replace')).toBeDefined();
    fireEvent.click(within(face).getByRole('button', { name: 'Remove' }));
    expect(valueOf()['face']).toBeUndefined();
    expect(within(face).queryByRole('img')).toBeNull();
  });

  it('refuses a file past its limits, saying why, and keeps the value', async () => {
    render(
      <Harness
        schema={{
          type: 'object',
          properties: { face: media({ mimes: ['image/png'], maxBytes: 4 }) },
        }}
      />
    );
    const face = screen.getByRole('group', { name: 'face' });
    const input = within(face).getByLabelText('face file');
    expect(input.getAttribute('accept')).toBe('image/png');
    fireEvent.change(input, { target: { files: [file(PNG, 'big.png', 'image/png')] } });
    expect(await within(face).findByText('8 B, more than the 4 B taken here')).toBeDefined();
    fireEvent.change(input, { target: { files: [file([1], 'a.gif', 'image/gif')] } });
    expect(
      await within(face).findByText('image/gif is not a type taken here (image/png)')
    ).toBeDefined();
    expect(valueOf()['face']).toBeUndefined();
    // No file picked: nothing happens.
    fireEvent.change(input, { target: { files: [] } });
    expect(valueOf()['face']).toBeUndefined();
  });

  it('shows a kept media through its address, and a document by its type', () => {
    const kept = { id: `sha256:${'a'.repeat(64)}`, mime: 'image/png' };
    render(
      <Harness
        schema={{ type: 'object', properties: { face: media({}), scan: media({}) } }}
        start={{
          face: kept,
          scan: { data: { [BYTES_KEY]: 'JVBERg==' }, mime: 'application/pdf' },
        }}
        src={(v) => `api/files/${(v as { id: string }).id}`}
      />
    );
    const face = screen.getByRole('group', { name: 'face' });
    expect(within(face).getByRole('img').getAttribute('src')).toBe(`api/files/${kept.id}`);
    expect(within(face).getByText('image/png')).toBeDefined();
    const scan = screen.getByRole('group', { name: 'scan' });
    expect(within(scan).queryByRole('img')).toBeNull();
    expect(within(scan).getByText('application/pdf, 4 B')).toBeDefined();
    expect(within(scan).getByText('any file')).toBeDefined();
  });

  it('is read only without a change: its preview, no buttons', () => {
    render(
      <SchemaForm
        legend="echo input"
        schema={{ type: 'object', properties: { picture: media({}) } }}
        value={{ picture: { data: { [BYTES_KEY]: 'iVBORw==' }, mime: 'image/png' } }}
      />
    );
    const picture = screen.getByRole('group', { name: 'picture' });
    expect(within(picture).getByRole('img')).toBeDefined();
    expect(within(picture).queryByRole('button')).toBeNull();
    expect(within(picture).queryByLabelText('picture file')).toBeNull();
  });

  it('reads its limits, what a file input accepts, and why a file is refused', () => {
    expect(mediaLimits({ type: 'object' })).toBeUndefined();
    expect(mediaLimits({ media: [] })).toBeUndefined();
    expect(mediaLimits({ media: { maxBytes: 3 } })).toEqual({ maxBytes: 3 });
    expect(accepted({})).toBeUndefined();
    expect(accepted({ kinds: ['image', 'video'] })).toBe('image/*,video/*');
    expect(accepted({ kinds: ['image', 'document'] })).toBeUndefined();
    expect(fileRefusal({ size: 1, type: '' }, { kinds: ['image'] })).toBe(
      'application/octet-stream is not image'
    );
    expect(fileRefusal({ size: 1, type: 'audio/ogg' }, { kinds: ['audio'] })).toBeUndefined();
    expect(fileRefusal({ size: 1, type: 'video/mp4' }, { kinds: ['video'] })).toBeUndefined();
    expect(limitsText({ mimes: ['image/png'], maxBytes: 2048 })).toBe('image/png, up to 2.0 KB');
    expect(toBase64(new Uint8Array(0x9000).fill(65))).toHaveLength(Math.ceil(0x9000 / 3) * 4);
  });

  it('is never made of defaults', () => {
    expect(withDefaults(CARD, {})).toEqual({});
  });
});

describe('a long text', () => {
  it('is typed in a larger box', () => {
    render(<Harness schema={CARD} />);
    const box = screen.getByLabelText('behaviour');
    expect(box.tagName).toBe('TEXTAREA');
    fireEvent.change(box, { target: { value: 'Haggles,\nthen gives in' } });
    expect(valueOf()['behaviour']).toBe('Haggles,\nthen gives in');
  });
});

describe('a list of objects', () => {
  const FIELDS: JsonSchema = {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, required: { type: 'boolean' } },
          required: ['name'],
        },
      },
    },
  };

  it('is a form per item, added, moved and removed; emptied, taken away', () => {
    render(<Harness schema={FIELDS} start={{ fields: [{ name: 'name' }, { name: 'role' }] }} />);
    const list = screen.getByRole('group', { name: 'fields' });
    expect(within(list).getAllByRole('group', { name: /^fields \d$/u })).toHaveLength(2);
    fireEvent.click(within(list).getByLabelText('move fields 2 up'));
    expect(valueOf()['fields']).toEqual([{ name: 'role' }, { name: 'name' }]);
    fireEvent.click(within(list).getByLabelText('move fields 1 down'));
    expect(valueOf()['fields']).toEqual([{ name: 'name' }, { name: 'role' }]);
    fireEvent.click(within(list).getByLabelText('add to fields'));
    const third = within(list).getByRole('group', { name: 'fields 3' });
    fireEvent.change(within(third).getByLabelText('name'), { target: { value: 'face' } });
    expect(valueOf()['fields']).toEqual([{ name: 'name' }, { name: 'role' }, { name: 'face' }]);
    for (let i = 3; i >= 1; i--) fireEvent.click(within(list).getByLabelText(`remove fields ${i}`));
    expect(valueOf()['fields']).toBeUndefined();
    expect(within(list).getByText('none')).toBeDefined();
  });

  it('is read only without a change', () => {
    render(<SchemaForm legend="config" schema={FIELDS} value={{ fields: [{ name: 'x' }, 'y'] }} />);
    const list = screen.getByRole('group', { name: 'fields' });
    expect(within(list).queryByRole('button')).toBeNull();
    expect(within(list).getAllByRole('group', { name: /^fields \d$/u })).toHaveLength(2);
  });
});
