/**
 * The `anthropic` connector (docs/bot-os-api.md §5, bot-os.md D49): LLM access through the Claude
 * API, implemented once in the shell. It holds the API key (the `anthropic_api_key` Docker secret,
 * P9) and offers one higher-order call, `ask`: a prompt, an optional system prompt, and optionally a
 * zod schema that the answer must fit (structured output). A plugin reaches it through an interface
 * input bound to it (`ctx.use(port).actions.ask`), so that the edge is the permission (P6, P17).
 * Nobody gets the key. A request may show the model images (`images`, bot-os.md D152), sent before
 * the prompt's text, checked against the API's limits before the call.
 *
 * A refusal, an answer cut short, an unreadable one or an error of the API is a failed answer
 * (`ok: false`, with why), never an exception, so that a plugin's loop survives the network.
 *
 * A model connector (bot-os.md D117, its manifest's `model`): it logs every call itself, whoever
 * calls (`anthropic.call`: the calling node, the model, the tokens and the cost in USD from its
 * price table, `PRICES`, a model without one logged with its cost unknown and a warning), and keeps the
 * last 24 hours by calling node and by model (`spend.ts`), on its card, its page and its panel.
 *
 * A service connector (bot-os.md D148, its manifest's `chat: false`): its account has no chat, so
 * its node has no chat-in output and no chat-out input, only its `interface`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  type ActionCall,
  definePlugin,
  type Media,
  mediaRefusal,
  mediaSchema,
  type Plugin,
} from '@megabottron1999/core';
import { z } from 'zod';
import { ServiceConnector } from './service.ts';
import {
  type CallRecord,
  costOf,
  OWNER_CALLER,
  priceOf,
  type Prices,
  SPEND_PAGE,
  SPEND_WIDGET,
  SpendLedger,
  spendStatus,
} from './spend.ts';

export const ANTHROPIC = 'anthropic';
export const ANTHROPIC_KEY = 'anthropic_api_key';
/** The model when neither the request nor the configuration names one. */
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
/** How long the API keeps a cached system prompt: its default five minutes, or an hour. */
export const CACHE_TTLS = ['5m', '1h'] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];

/** The day the prices were read from Anthropic's published pricing. */
export const PRICES_AS_OF = '2026-11-03';

/** A price whose cache writes cost 1.25 times its input for 5 minutes, and twice for an hour. */
const priced = (input: number, output: number, cacheRead: number) => ({
  input,
  output,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead,
});

/**
 * The current Claude models' prices, in USD per million tokens, as Anthropic publishes them for its
 * own API (`PRICES_AS_OF`): input, output, cache writes (5 minutes: 1.25 times the input; an hour:
 * twice), cache reads. Claude Haiku 5.5's are five times higher for a prompt over 100K tokens.
 * Kept here, not in the config, so that a release updates it (bot-os.md D117); a model not here is
 * logged with its cost unknown. The cache reads marked "derived" are not published per model: they
 * follow the published rule of about a tenth of the input price.
 */
export const PRICES: Prices = {
  'claude-fable-5-2': priced(8, 40, 0.2),
  'claude-mythos-5-2': priced(8, 40, 0.2),
  'claude-fable-5-1': priced(10, 50, 0.25),
  'claude-mythos-5-1': priced(10, 50, 0.25),
  'claude-fable-5': priced(10, 50, 1),
  'claude-mythos-5': priced(10, 50, 1),
  'claude-opus-5-5': priced(4, 20, 0.2),
  'claude-opus-5': priced(5, 25, 0.5), // cache read derived
  'claude-opus-4-8': priced(5, 25, 0.5), // cache read derived
  'claude-opus-4-7': priced(5, 25, 0.5), // cache read derived
  'claude-opus-4-6': priced(5, 25, 0.5), // cache read derived
  'claude-sonnet-5-5': priced(2, 10, 0.1),
  'claude-sonnet-5': priced(2, 10, 0.2), // cache read derived
  'claude-sonnet-4-6': priced(3, 15, 0.3), // cache read derived
  'claude-haiku-5-5': {
    ...priced(0.1, 0.5, 0.01), // cache read derived
    over: { promptTokens: 100_000, ...priced(0.5, 2.5, 0.05) }, // cache read derived
  },
  'claude-haiku-4-5': priced(1, 5, 0.1), // cache read derived
};

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
  // No `prices`: the price table is the code's (`PRICES`, D117). A config saved when it had one
  // still loads: this schema, not a strict one, drops a key it does not know.
});

/** The media types an image may have (bot-os.md D152): the Messages API's. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/**
 * The Messages API's limits on images, checked before the call (D152), from Anthropic's vision
 * guide, "Request limits" (https://platform.claude.com/docs/en/build-with-claude/vision, read on
 * 2026-11-21), each the lowest that holds for every model, so that a release updates them:
 * - `IMAGES_MAX`: images per request: 100 for a model with a 200K-token context window, 600 for the
 *   others.
 * - `IMAGE_MAX_BASE64`: an image's size, base64-encoded: 10 MB on the Claude API, taken as
 *   10,000,000 bytes.
 * - `REQUEST_MAX`: the whole request: 128 MB on the Claude API, counted as the images base64-encoded
 *   and the prompts' UTF-8, taken as 128,000,000 bytes less a margin for the rest of the request.
 * Not checked here: an image's size in pixels (8000 by 8000 at most, and less in a request of more
 * than 20 images), which only decoding it tells; the API refuses it, and its error is the answer.
 */
export const IMAGES_MAX = 100;
export const IMAGE_MAX_BASE64 = 10_000_000;
export const REQUEST_MAX = 128_000_000 - 1_000_000;

/** What `ask` asks. */
export interface AskRequest<T = unknown> {
  /** The fixed instructions, cached by the API between calls that share them. */
  system?: string;
  prompt: string;
  /**
   * Images the model sees with the prompt (D152), sent before its text in the user's turn: each a
   * `Media` (D153) of `IMAGE_TYPES`, within the API's limits (`IMAGES_MAX`, `IMAGE_MAX_BASE64`,
   * `REQUEST_MAX`); a width and a height are not sent.
   */
  images?: readonly Media[];
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

/** `ask`; the core tells it who calls (D117), which a caller does not pass. */
export type Ask = <T = unknown>(request: AskRequest<T>, call?: ActionCall) => Promise<AskResult<T>>;

/** The part of the SDK's client that `ask` uses. */
export type AnthropicClient = Pick<Anthropic, 'messages'>;

const askInput = z.object({
  system: z.string().optional(),
  prompt: z.string().min(1),
  images: z.array(mediaSchema).optional(),
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

/** An image's size base64-encoded, in bytes. */
const base64Size = (n: number): number => 4 * Math.ceil(n / 3);

/** A size in words: `512 B`, `1.2 MB`. */
const mb = (n: number): string => (n < 1_000_000 ? `${n} B` : `${(n / 1_000_000).toFixed(1)} MB`);

/**
 * Why the images of a request cannot go (D152), checked before the call: their number, each one
 * (`mediaRefusal`, D153: a `Media` of `IMAGE_TYPES`, its bytes the type it says), each one's size
 * and the request's; undefined when they can.
 */
export function imagesRefusal(
  r: Pick<AskRequest, 'images' | 'prompt' | 'system'>
): string | undefined {
  const images = r.images ?? [];
  if (images.length > IMAGES_MAX)
    return `${images.length} images, more than the ${IMAGES_MAX} a request may carry`;
  let total = Buffer.byteLength(r.prompt) + Buffer.byteLength(r.system ?? '');
  for (const [i, image] of images.entries()) {
    const which = `image ${i + 1}`;
    const refused = mediaRefusal(image, { mimes: IMAGE_TYPES });
    if (refused !== undefined) return `${which}: ${refused}`;
    const size = base64Size(image.data.byteLength);
    if (size > IMAGE_MAX_BASE64)
      return `${which}: ${mb(size)} base64-encoded, more than the ${mb(IMAGE_MAX_BASE64)} the API takes`;
    total += size;
  }
  if (total > REQUEST_MAX)
    return `the request would be ${mb(total)}, more than the ${mb(REQUEST_MAX)} the API takes`;
  return undefined;
}

/**
 * The user's turn: the prompt's text alone, or the images first, each a base64 image block, then
 * the text (D152).
 */
function contentOf(r: Pick<AskRequest, 'images' | 'prompt'>): Anthropic.MessageParam['content'] {
  if (r.images === undefined || r.images.length === 0) return r.prompt;
  return [
    ...r.images.map((image) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: image.mime as ImageType,
        data: Buffer.from(image.data).toString('base64'),
      },
    })),
    { type: 'text' as const, text: r.prompt },
  ];
}

/** The `ask` of a client, with the configuration's defaults. */
export function askWith(client: AnthropicClient, defaults: z.infer<typeof anthropicConfig>): Ask {
  return async <T>(r: AskRequest<T>): Promise<AskResult<T>> => {
    const refused = imagesRefusal(r);
    if (refused !== undefined) return { ok: false, error: refused };
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
        messages: [{ role: 'user', content: contentOf(r) }],
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
      kinds: ['connector'],
      description: 'The Claude API: asks a model, with structured output',
      account,
      // A service connector (bot-os.md D148): its `ask` is its only port to it, no chat.
      chat: false,
      model: true,
      secrets: [ANTHROPIC_KEY],
      config: anthropicConfig,
      widget: SPEND_WIDGET,
      page: SPEND_PAGE,
      interface: {
        state: {
          status: {
            help: 'What it spent over the last 24 hours, by calling node and by model',
            output: spendStatus,
          },
        },
        actions: {
          ask: {
            help: 'Asks a model: a prompt, optional images, an optional system prompt and a schema for the answer',
            input: askInput,
            output: askOutput,
          },
        },
      },
    },
    create: (ctx) => {
      const config = ctx.config as z.infer<typeof anthropicConfig>;
      const asked = askWith(makeClient(ctx.secrets?.get(ANTHROPIC_KEY) ?? ''), config);
      const ledger = new SpendLedger(ctx.store, ctx.clock);
      const unpriced = new Set<string>();
      /** Logs a call and counts it: its cost, or unknown for a model of no price. */
      const logged = (r: AskRequest, result: AskResult, node: string): void => {
        const model = result.ok ? result.model : (r.model ?? config.model);
        const used = result.usage ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        const price = priceOf(PRICES, model);
        if (price === undefined && !unpriced.has(model)) {
          unpriced.add(model);
          ctx.log.warn(
            `no price for the model ${model}: its calls are logged with their cost unknown until a release prices it`
          );
        }
        const record: CallRecord = {
          node,
          model,
          ok: result.ok,
          ...(result.ok ? {} : { error: result.error }),
          ...used,
          usd: price === undefined ? null : costOf(price, used, r.cacheTtl ?? config.cacheTtl),
        };
        // The images' count and bytes, never their content (D152).
        const images = r.images ?? [];
        ctx.record(`${ANTHROPIC}.call`, {
          ...record,
          ...(images.length === 0
            ? {}
            : {
                images: images.length,
                imageBytes: images.reduce((n, image) => n + image.data.byteLength, 0),
              }),
        });
        ledger.add(record);
      };
      const ask: Ask = async <T>(r: AskRequest<T>, call?: ActionCall): Promise<AskResult<T>> => {
        const result = await asked(r);
        logged(r as AskRequest, result as AskResult, call?.node ?? OWNER_CALLER);
        return result;
      };
      return {
        connector: new ServiceConnector(ctx.account ?? account, ANTHROPIC),
        interface: { state: { status: () => ledger.status() }, actions: { ask } },
        cost: () => ({ spend: ledger.spend() }),
      };
    },
  });
}
