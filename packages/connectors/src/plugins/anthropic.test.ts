import Anthropic from '@anthropic-ai/sdk';
import { Core, definePlugin, parseManifest, VirtualClock } from '@megabottron1999/core';
import { secretsWith } from '@megabottron1999/core/test/secrets.ts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AnthropicClient,
  anthropicConfig,
  anthropicPlugin,
  type Ask,
  askWith,
  DEFAULT_MODEL,
  IMAGE_MAX_BASE64,
  IMAGES_MAX,
  imagesRefusal,
  REQUEST_MAX,
} from './anthropic.ts';

interface Reply {
  stop_reason?: string;
  text?: string;
  parsed_output?: unknown;
  cache?: boolean;
}

/** A client whose `parse` keeps each request and answers `reply`, or throws it. */
function fakeClient(reply: Reply | Error, requests: unknown[] = []): AnthropicClient {
  return {
    messages: {
      parse: (params: unknown) => {
        requests.push(params);
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve({
          model: (params as { model: string }).model,
          stop_reason: reply.stop_reason ?? 'end_turn',
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: reply.text ?? '' },
          ],
          parsed_output: reply.parsed_output ?? null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            ...(reply.cache === true
              ? { cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }
              : { cache_read_input_tokens: null, cache_creation_input_tokens: null }),
          },
        });
      },
    },
  } as unknown as AnthropicClient;
}

const defaults = anthropicConfig.parse({});
const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('askWith', () => {
  it('asks the default model, and answers its text', async () => {
    const requests: unknown[] = [];
    const ask = askWith(fakeClient({ text: 'four' }, requests), defaults);
    expect(await ask({ prompt: 'two and two?' })).toEqual({
      ok: true,
      text: 'four',
      model: DEFAULT_MODEL,
      usage: USAGE,
    });
    expect(requests).toEqual([
      {
        model: DEFAULT_MODEL,
        max_tokens: 16_000,
        messages: [{ role: 'user', content: 'two and two?' }],
      },
    ]);
  });

  it('caches the system prompt, and passes the model, the length and the effort asked', async () => {
    const requests: unknown[] = [];
    const ask = askWith(fakeClient({ text: 'ok', cache: true }, requests), {
      ...defaults,
      effort: 'low',
    });
    const r = await ask({ system: 'Be brief.', prompt: 'hi', model: 'claude-haiku-5-5' });
    expect(r).toMatchObject({ ok: true, usage: { cacheReadTokens: 3, cacheWriteTokens: 2 } });
    await ask({ prompt: 'hi', maxTokens: 100, effort: 'high' });
    expect(requests).toEqual([
      {
        model: 'claude-haiku-5-5',
        max_tokens: 16_000,
        system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'low' },
      },
      {
        model: DEFAULT_MODEL,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'high' },
      },
    ]);
  });

  it('keeps the system prompt cached for an hour when configured or asked', async () => {
    const requests: { system?: unknown }[] = [];
    const ask = askWith(fakeClient({ text: 'ok' }, requests), { ...defaults, cacheTtl: '1h' });
    await ask({ system: 'Be brief.', prompt: 'hi' });
    await ask({ system: 'Be brief.', prompt: 'hi', cacheTtl: '5m' });
    expect(requests.map((r) => r.system)).toEqual([
      [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
    ]);
    expect(defaults.cacheTtl).toBe('5m');
    expect(anthropicConfig.safeParse({ cacheTtl: '1d' }).success).toBe(false);
    // The prices are the code's, not the config's (D117): an old config's `prices` is dropped.
    expect(anthropicConfig.parse({ prices: { 'claude-x': { input: 1 } } })).not.toHaveProperty(
      'prices'
    );
  });

  it('answers the output parsed by the schema given', async () => {
    const requests: { output_config?: { format?: { type: string } } }[] = [];
    const roll = z.object({ dice: z.number() });
    const ask = askWith(
      fakeClient({ text: '{"dice":3}', parsed_output: { dice: 3 } }, requests),
      defaults
    );
    const r = await ask({ prompt: 'roll', schema: roll });
    expect(r).toMatchObject({ ok: true, text: '{"dice":3}', output: { dice: 3 } });
    expect(requests[0]?.output_config?.format?.type).toBe('json_schema');
    const unread = askWith(fakeClient({ text: 'no' }), defaults);
    expect(await unread({ prompt: 'roll', schema: roll })).toEqual({
      ok: false,
      error: 'unreadable answer',
      usage: USAGE,
    });
  });

  it('fails a refusal, an answer cut short and an error, without throwing', async () => {
    const ask = (reply: Reply | Error): ReturnType<Ask> =>
      askWith(fakeClient(reply), defaults)({ prompt: 'hi' });
    expect(await ask({ stop_reason: 'refusal' })).toMatchObject({ ok: false, error: 'refused' });
    expect(await ask({ stop_reason: 'max_tokens' })).toMatchObject({
      ok: false,
      error: 'answer cut short',
    });
    expect(await ask(new Error('offline'))).toEqual({ ok: false, error: 'offline' });
    const api = new Anthropic.APIError(429, undefined, 'slow down', new Headers());
    expect(await ask(api)).toEqual({ ok: false, error: 'API error 429 slow down' });
    const thrown = askWith(
      { messages: { parse: () => Promise.reject('odd') } } as unknown as AnthropicClient,
      defaults
    );
    expect(await thrown({ prompt: 'hi' })).toEqual({ ok: false, error: 'odd' });
  });
});

describe('ask with images (D152)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 2]);

  it('sends each image as a base64 block, before the prompt’s text, in the user’s turn', async () => {
    const requests: { messages?: unknown }[] = [];
    const ask = askWith(fakeClient({ text: 'a dungeon' }, requests), defaults);
    const r = await ask({
      prompt: 'Where is this?',
      images: [
        { data: PNG, mime: 'image/png' },
        { data: JPEG, mime: 'image/jpeg' },
      ],
    });
    expect(r).toMatchObject({ ok: true, text: 'a dungeon' });
    expect(requests[0]?.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: Buffer.from(PNG).toString('base64'),
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: Buffer.from(JPEG).toString('base64'),
            },
          },
          { type: 'text', text: 'Where is this?' },
        ],
      },
    ]);
    // No images: the prompt alone, as a text.
    await ask({ prompt: 'hi', images: [] });
    expect(requests[1]?.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('refuses before the call, with why: a type, bytes of another, the count, the sizes', async () => {
    const requests: unknown[] = [];
    const ask = askWith(fakeClient({ text: 'no' }, requests), defaults);
    const gif = new TextEncoder().encode('GIF89a');
    const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');
    expect(
      imagesRefusal({
        prompt: 'p',
        images: [
          { data: gif, mime: 'image/gif' },
          { data: webp, mime: 'image/webp' },
        ],
      })
    ).toBeUndefined();
    expect(await ask({ prompt: 'p', images: [{ data: PNG, mime: 'image/bmp' }] })).toEqual({
      ok: false,
      error:
        'image 1: image/bmp is not a type the API takes (image/jpeg, image/png, image/gif, image/webp)',
    });
    expect(
      imagesRefusal({
        prompt: 'p',
        images: [
          { data: PNG, mime: 'image/png' },
          { data: PNG, mime: '' },
        ],
      })
    ).toBe(
      'image 2: no type is not a type the API takes (image/jpeg, image/png, image/gif, image/webp)'
    );
    expect(imagesRefusal({ prompt: 'p', images: [{ data: PNG, mime: 'image/jpeg' }] })).toBe(
      'image 1: its bytes are image/png, not the image/jpeg it says'
    );
    expect(
      imagesRefusal({ prompt: 'p', images: [{ data: new Uint8Array([1, 2]), mime: 'image/png' }] })
    ).toBe('image 1: its bytes are no JPEG, PNG, GIF or WebP image, not the image/png it says');
    const many = Array.from({ length: IMAGES_MAX + 1 }, () => ({ data: PNG, mime: 'image/png' }));
    expect(imagesRefusal({ prompt: 'p', images: many })).toBe(
      `${IMAGES_MAX + 1} images, more than the ${IMAGES_MAX} a request may carry`
    );
    expect(imagesRefusal({ prompt: 'p', images: many.slice(1) })).toBeUndefined();
    // 7.5 MB of bytes is 10 MB base64-encoded: the most an image may be.
    const at = (n: number) => {
      const data = new Uint8Array(n);
      data.set(JPEG);
      return { data, mime: 'image/jpeg' };
    };
    expect(
      imagesRefusal({ prompt: 'p', images: [at((IMAGE_MAX_BASE64 / 4) * 3)] })
    ).toBeUndefined();
    expect(imagesRefusal({ prompt: 'p', images: [at((IMAGE_MAX_BASE64 / 4) * 3 + 1)] })).toBe(
      'image 1: 10.0 MB base64-encoded, more than the 10.0 MB the API takes'
    );
    const big = at(7_000_000);
    const filled = Array.from({ length: 19 }, () => big);
    expect(imagesRefusal({ prompt: 'p', images: filled })).toBe(
      `the request would be 177.3 MB, more than the ${(REQUEST_MAX / 1_000_000).toFixed(1)} MB the API takes`
    );
    expect(requests).toEqual([]);
  }, 30_000);
});

describe('the anthropic plugin', () => {
  it('is a service connector: no chat in or out, its interface alone (D148)', () => {
    const manifest = parseManifest(anthropicPlugin().manifest);
    expect(manifest.chat).toBe(false);
    expect(manifest.inputs).toEqual({});
    expect(Object.keys(manifest.outputs)).toEqual(['interface']);
  });

  it('makes its client from its own secret, and a plugin bound to it asks', async () => {
    const keys: string[] = [];
    const answers: unknown[] = [];
    const asker = definePlugin({
      manifest: {
        id: 'asker',
        version: '0.1.0',
        kinds: ['agent'],
        description: 'Asks',
        inputs: { llm: { type: 'interface', plugin: 'anthropic', members: ['actions.ask'] } },
      },
      create: (ctx) => ({
        async start() {
          const { actions } = ctx.use<{ actions: { ask: Ask } }>('llm');
          answers.push(await actions.ask({ prompt: 'hi' }));
        },
      }),
    });
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ anthropic_api_key: 'sk-example-key' }),
      // A config saved when the prices were the config's still loads, the key dropped (D117).
      config: { anthropic: { model: 'claude-sonnet-5-5', prices: { 'claude-sonnet-5-5': {} } } },
    });
    core.register(
      anthropicPlugin({ client: (key) => (keys.push(key), fakeClient({ text: 'hello' })) }),
      asker
    );
    await core.start();
    expect(keys).toEqual(['sk-example-key']);
    expect(answers).toEqual([
      { ok: true, text: 'hello', model: 'claude-sonnet-5-5', usage: USAGE },
    ]);
    expect(core.connector('anthropic')?.account).toBe('anthropic:api');
  });

  it('logs each call itself, its caller, tokens and cost, and keeps the last 24 hours', async () => {
    const records: Record<string, unknown>[] = [];
    const warnings: string[] = [];
    const asker = definePlugin({
      manifest: {
        id: 'asker',
        version: '0.1.0',
        kinds: ['agent'],
        description: 'Asks',
        inputs: { llm: { type: 'interface', plugin: 'anthropic', members: ['actions.ask'] } },
      },
      create: (ctx) => ({
        async start() {
          const { actions } = ctx.use<{ actions: { ask: Ask } }>('llm');
          await actions.ask({ prompt: 'hi', system: 'Be brief.' });
          await actions.ask({ prompt: 'hi', model: 'claude-new-1' });
          await actions.ask({ prompt: 'hi', model: 'claude-new-1' });
        },
      }),
    });
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ anthropic_api_key: 'sk-example-key' }),
      record: (r) => {
        if (r.type === 'anthropic.call') records.push(r as unknown as Record<string, unknown>);
      },
      print: (line) => {
        if (line.includes('no price')) warnings.push(line);
      },
    });
    core.register(
      anthropicPlugin({ client: () => fakeClient({ text: 'hello', cache: true }) }),
      asker
    );
    await core.start();
    // The owner's call from the panel is no node's.
    expect(await core.controls.act('anthropic', 'ask', { prompt: 'hi' })).toMatchObject({
      output: { ok: true },
    });
    // 10 input, 5 output, 3 cache reads and 2 writes at Claude Opus 5.5's prices.
    const usd = (10 * 4 + 5 * 20 + 3 * 0.2 + 2 * 5) / 1_000_000;
    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({
      type: 'anthropic.call',
      node: 'asker',
      model: DEFAULT_MODEL,
      ok: true,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    });
    expect(records[0]?.['usd']).toBeCloseTo(usd);
    expect(records[1]).toMatchObject({ node: 'asker', model: 'claude-new-1', usd: null });
    expect(records[3]).toMatchObject({ node: '(owner)', model: DEFAULT_MODEL });
    // An unknown model's cost is unknown, said once.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no price for the model claude-new-1');
    const node = core.controls.status().plugins.find((p) => p.id === 'anthropic');
    expect(node?.widget).toMatchObject({ calls: 4, unpriced: 2 });
    expect((node?.widget as { byNode: unknown[] }).byNode).toMatchObject([
      { node: 'asker', calls: 3, unpriced: 2 },
      { node: '(owner)', calls: 1 },
    ]);
    expect(node?.cost?.own?.spend).toMatchObject({ calls: 4, unpriced: 2 });
    expect(node?.cost?.own?.spend?.usd).toBeCloseTo(2 * usd);
    await core.stop();
  });

  it('logs the images’ count and bytes, never their content (D152)', async () => {
    const records: Record<string, unknown>[] = [];
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ anthropic_api_key: 'sk-example-key' }),
      record: (r) => {
        if (r.type === 'anthropic.call') records.push(r as unknown as Record<string, unknown>);
      },
    });
    core.register(anthropicPlugin({ client: () => fakeClient({ text: 'a room' }) }));
    await core.start();
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    await core.controls.act('anthropic', 'ask', {
      prompt: 'hi',
      images: [
        { data: PNG, mime: 'image/png' },
        { data: PNG, mime: 'image/png' },
      ],
    });
    await core.controls.act('anthropic', 'ask', {
      prompt: 'hi',
      images: [{ data: PNG, mime: 'image/tiff' }],
    });
    expect(records).toEqual([
      expect.objectContaining({ ok: true, images: 2, imageBytes: 20 }),
      expect.objectContaining({ ok: false, images: 1, imageBytes: 10, usd: 0 }),
    ]);
    expect(JSON.stringify(records)).not.toContain('137');
    await core.stop();
  });

  it('logs a failed call too, at no cost when nothing was used', async () => {
    const records: Record<string, unknown>[] = [];
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ anthropic_api_key: 'sk-example-key' }),
      record: (r) => {
        if (r.type === 'anthropic.call') records.push(r as unknown as Record<string, unknown>);
      },
    });
    core.register(anthropicPlugin({ client: () => fakeClient(new Error('offline')) }));
    await core.start();
    await core.controls.act('anthropic', 'ask', { prompt: 'hi', model: 'claude-haiku-5-5' });
    expect(records).toEqual([
      expect.objectContaining({
        node: '(owner)',
        model: 'claude-haiku-5-5',
        ok: false,
        error: 'offline',
        inputTokens: 0,
        usd: 0,
      }),
    ]);
    await core.stop();
  });

  it('makes the SDK’s client by default, under the account name it is given', async () => {
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ anthropic_api_key: 'sk-example-key' }),
    });
    core.register(anthropicPlugin({ name: 'supervisor' }));
    await core.start();
    expect(core.state('anthropic')?.state).toBe('running');
    expect(core.connector('anthropic')?.account).toBe('anthropic:supervisor');
  });
});
