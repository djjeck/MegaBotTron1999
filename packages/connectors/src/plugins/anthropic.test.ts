import Anthropic from '@anthropic-ai/sdk';
import { Core, definePlugin, VirtualClock } from '@megabottron1999/core';
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

describe('the anthropic plugin', () => {
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
      config: { anthropic: { model: 'claude-sonnet-5-5' } },
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
