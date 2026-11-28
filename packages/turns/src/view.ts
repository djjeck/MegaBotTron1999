/**
 * The generic view (docs/bot-os.md D170, docs/bot-os-api.md §5): a page of the owner's own, served
 * at `/v/<path>/` (its node's `path`, else its id), whose sections its config declares, each read
 * from the node bound to one of its inputs. A module ships a view of its own as a plugin whose
 * manifest declares its `view`; this one is for the owner's dashboards.
 *
 * - **Its inputs** are its config's `inputs`: each an interface input, by plugin (`plugin`) or by
 *   contract (`members`), always optional, so that a view starts with nothing bound and each edge is
 *   the owner's own (no input is wired for them). An edge dropped on its card from an interface
 *   output adds one (D80). The members its sections use are added to their input (`state.<read>`,
 *   `actions.<action>`), so that it binds only to a node that offers them.
 * - **Its page** is its config's `title`, `selector` and `sections`, in a view's format (the
 *   sections of a node page, each with the input it reads, `from`): checked against the manifest of
 *   the node each input is bound to, as the graph's check does every view's.
 * - It runs nothing: the web UI reads its bound nodes through the control API.
 */
import {
  definePlugin,
  type ManifestInput,
  type Plugin,
  selectorSchema,
  themeSchema,
  viewSectionSchema,
} from '@megabottron1999/core';
import { z } from 'zod';

export const VIEW = 'view';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MEMBER = /^(?:state|actions)\.[a-z][A-Za-z0-9_]*$/u;

/** A generic view's config: its inputs, its title, its selector, its sections and its theme. */
export const viewConfig = z.object({
  title: z.string().min(1).default('View').describe('Its title, at the top of its page'),
  inputs: z
    .record(
      z.string().regex(ID, 'expected lower-case words and dashes'),
      z.object({
        type: z.literal('interface').default('interface'),
        plugin: z
          .string()
          .regex(ID, 'expected a plugin id')
          .optional()
          .describe('The plugin whose node it reads; none: any node that offers its members'),
        members: z
          .array(z.string().regex(MEMBER, 'expected state.<name> or actions.<name>'))
          .default([])
          .describe('Members it needs beyond those its sections use'),
        help: z.string().min(1).optional().describe('What it is for, shown with the port'),
      })
    )
    .default({})
    .describe('The nodes it shows, by input: an edge from each one’s interface'),
  selector: selectorSchema
    .optional()
    .describe("One choice on the page, which its sections take as '$selector'"),
  sections: z
    .array(viewSectionSchema)
    .default([])
    .describe("Its sections, in order: each a page's section, read from the input it names (from)"),
  theme: themeSchema
    .optional()
    .describe('Its look (D175): colours light and dark, density, corners, font'),
});
export type ViewConfig = z.output<typeof viewConfig>;

const BASE: ManifestInput = {
  id: VIEW,
  kinds: ['view'],
  description: 'A page of your own, at /v/<path>/, showing the nodes wired to its inputs',
  config: viewConfig,
  view: { title: 'View', sections: [] },
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A view node's own manifest (D74), from its config: its inputs, and its page. */
export function viewManifest(config: Readonly<Record<string, unknown>>): ManifestInput {
  const c = viewConfig.safeParse(config);
  if (!c.success) return BASE;
  const { title, inputs, selector, sections, theme } = c.data;
  return {
    ...BASE,
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([port, i]) => [
        port,
        {
          type: 'interface' as const,
          ...(i.plugin === undefined ? {} : { plugin: i.plugin }),
          members: i.members,
          optional: true,
          ...(i.help === undefined ? {} : { help: i.help }),
        },
      ])
    ),
    view: {
      title,
      ...(selector === undefined ? {} : { selector }),
      sections,
      ...(theme === undefined ? {} : { theme }),
    },
  };
}

/** The generic view plugin: one node per page of the owner's. */
export function viewPlugin(): Plugin {
  return definePlugin({
    manifest: {
      ...BASE,
      node: (config) => viewManifest(isRecord(config) ? config : {}),
      configInputs: { key: 'inputs', types: ['interface'] },
    },
    create: () => ({}),
  });
}
