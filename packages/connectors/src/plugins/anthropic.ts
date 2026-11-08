/**
 * The `anthropic` connector (docs/bot-os-api.md §5, bot-os.md D49): LLM access through the Claude
 * API, implemented once in the shell. It holds the API key (the `anthropic_api_key` Docker secret,
 * P9) and offers one higher-order call, `ask`: a prompt, an optional system prompt, and optionally a
 * zod schema that the answer must fit (structured output). A plugin reaches it through an interface
 * input bound to it (`ctx.use(port).actions.ask`), so that the edge is the permission (P6, P17).
 * Nobody gets the key.
 *
 * A refusal, an answer cut short, an unreadable one or an error of the API is a failed answer
 * (`ok: false`, with why), never an exception, so that a plugin's loop survives the network.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { definePlugin, type Plugin } from '@megabottron1999/core';
import { z } from 'zod';
import { ServiceConnector } from './service.ts';

export const ANTHROPIC = 'anthropic';
export const ANTHROPIC_KEY = 'anthropic_api_key';
/** The model when neither the request nor the configuration names one. */
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
/** How long the API keeps a cached system prompt: its default five minutes, or an hour. */
export const CACHE_TTLS = ['5m', '1h'] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];

export const anthropicConfig = z.object({
  model: z.string().min(1).default(DEFAULT_MODEL).describe('The model asked by default'),
  maxTokens: z
    .number()
    .int()
    .positive()
    .default(16_000)
    .describe('The longest answer, in tokens, by default'),
  effort: z
    .enum(EFFORTS)
    .optional()
    .describe('How hard the model thinks by default; the model’s own default when unset'),
  cacheTtl: z
    .enum(CACHE_TTLS)
    .default('5m')
    .describe(
      'How long the system prompt stays cached: 5m (the API’s default), or 1h for calls further apart (a dearer write)'
    ),
});

/** What `ask` asks. */
export interface AskRequest<T = unknown> {
  /** The fixed instructions, cached by the API between calls that share them. */
  system?: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  effort?: Effort;
  /** How long the system prompt stays cached; the configuration's `cacheTtl` by default. */
  cacheTtl?: CacheTtl;
  /** The shape the answer must have: it is returned parsed, as `output`. */
  schema?: z.ZodType<T>;
}

export interface AskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** What `ask` answers: the text, and the parsed output when a schema was given; or why not. */
export type AskResult<T = unknown> =
  | { ok: true; text: string; output?: T; model: string; usage: AskUsage }
  | { ok: false; error: string; usage?: AskUsage };

export type Ask = <T = unknown>(request: AskRequest<T>) => Promise<AskResult<T>>;

/** The part of the SDK's client that `ask` uses. */
export type AnthropicClient = Pick<Anthropic, 'messages'>;

const askInput = z.object({
  system: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  effort: z.enum(EFFORTS).optional(),
  cacheTtl: z.enum(CACHE_TTLS).optional(),
  schema: z.custom<z.ZodType>((v) => v instanceof z.ZodType, 'a zod schema').optional(),
});

const usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
});

const askOutput = z.union([
  z.object({
    ok: z.literal(true),
    text: z.string(),
    output: z.unknown().optional(),
    model: z.string(),
    usage,
  }),
  z.object({ ok: z.literal(false), error: z.string(), usage: usage.optional() }),
]);

/** The `ask` of a client, with the configuration's defaults. */
export function askWith(client: AnthropicClient, defaults: z.infer<typeof anthropicConfig>): Ask {
  return async <T>(r: AskRequest<T>): Promise<AskResult<T>> => {
    const effort = r.effort ?? defaults.effort;
    // The breakpoint after the system prompt: five minutes is the API's own default, so only an
    // hour is written out.
    const ttl = r.cacheTtl ?? defaults.cacheTtl;
    const cache_control =
      ttl === '1h' ? { type: 'ephemeral' as const, ttl } : { type: 'ephemeral' as const };
    const output_config = {
      ...(effort === undefined ? {} : { effort }),
      ...(r.schema === undefined ? {} : { format: zodOutputFormat(r.schema) }),
    };
    try {
      const response = await client.messages.parse({
        model: r.model ?? defaults.model,
        max_tokens: r.maxTokens ?? defaults.maxTokens,
        ...(r.system === undefined
          ? {}
          : { system: [{ type: 'text', text: r.system, cache_control }] }),
        messages: [{ role: 'user', content: r.prompt }],
        ...(Object.keys(output_config).length === 0 ? {} : { output_config }),
      });
      const u = response.usage;
      const used: AskUsage = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      };
      if (response.stop_reason === 'refusal') return { ok: false, error: 'refused', usage: used };
      if (response.stop_reason === 'max_tokens')
        return { ok: false, error: 'answer cut short', usage: used };
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      if (r.schema === undefined) return { ok: true, text, model: response.model, usage: used };
      if (response.parsed_output === null || response.parsed_output === undefined)
        return { ok: false, error: 'unreadable answer', usage: used };
      return {
        ok: true,
        text,
        output: response.parsed_output as T,
        model: response.model,
        usage: used,
      };
    } catch (error) {
      if (error instanceof Anthropic.APIError)
        return { ok: false, error: `API error ${error.message}` };
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export interface AnthropicPluginOptions {
  /** The account's name: `anthropic:<name>`; `api` by default. */
  name?: string;
  /** Makes the client from the key: the SDK's by default. */
  client?: (apiKey: string) => AnthropicClient;
}

/** The plugin: the Claude API's account, and its `ask`. */
export function anthropicPlugin(o: AnthropicPluginOptions = {}): Plugin {
  const account = `anthropic:${o.name ?? 'api'}`;
  const makeClient = o.client ?? ((apiKey: string) => new Anthropic({ apiKey }));
  return definePlugin({
    manifest: {
      id: ANTHROPIC,
      version: '0.1.0',
      kinds: ['connector'],
      description: 'The Claude API: asks a model, with structured output',
      account,
      secrets: [ANTHROPIC_KEY],
      config: anthropicConfig,
      interface: {
        actions: {
          ask: {
            help: 'Asks a model: a prompt, an optional system prompt and a schema for the answer',
            input: askInput,
            output: askOutput,
          },
        },
      },
    },
    create: (ctx) => {
      const config = ctx.config as z.infer<typeof anthropicConfig>;
      const ask = askWith(makeClient(ctx.secrets?.get(ANTHROPIC_KEY) ?? ''), config);
      return {
        connector: new ServiceConnector(ctx.account ?? account, ANTHROPIC),
        interface: { actions: { ask } },
      };
    },
  });
}
