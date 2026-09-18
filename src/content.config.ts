import { readFileSync } from 'node:fs';
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import yaml from 'js-yaml';

// The sky is parsed and validated here, at config load, rather than by the `file()` loader: that
// loader logs a YAML parse error and carries on, which would let a broken file through the build.
// A throw here fails `npm run build`, and with it Jenkins.

const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const vec2 = z.tuple([z.number(), z.number()]);

const skySchema = z
  .object({
    // A chapter of the landing essay and the asterism standing behind it. The figure is authored
    // (src/data/topology.yaml), so the only thing worth checking is that it is a figure: enough
    // stars to draw, and no line reaching past the end of the list.
    chapters: z
      .array(
        z
          .object({
            id,
            name: z.string().min(1),
            at: vec2,
            stars: z.array(vec2).min(3),
            lines: z.array(z.tuple([z.number().int(), z.number().int()])).min(1),
          })
          .strict()
          .superRefine((c, ctx) => {
            for (const [a, b] of c.lines) {
              if (a < 0 || b < 0 || a >= c.stars.length || b >= c.stars.length) {
                ctx.addIssue({ code: 'custom', message: `chapter ${c.id}: line [${a}, ${b}] has no such star` });
              }
            }
          }),
      )
      .min(1),
    waypoints: z.array(z.object({ id: z.enum(['constellation', 'incidents', 'gitops', 'documentation', 'resume']), pos: vec3 }).strict()),
  })
  .strict()
  .superRefine((t, ctx) => {
    const ids = new Set<string>();
    for (const c of t.chapters) {
      if (ids.has(c.id)) ctx.addIssue({ code: 'custom', message: `duplicate chapter id: ${c.id}` });
      ids.add(c.id);
    }
    const places = new Set(t.waypoints.map((w) => w.id));
    if (places.size !== 5 || t.waypoints.length !== 5) ctx.addIssue({ code: 'custom', message: 'waypoints must list each place exactly once' });
  });

const skyFile = new URL('./data/topology.yaml', import.meta.url);
const parsed = skySchema.safeParse(yaml.load(readFileSync(skyFile, 'utf-8')));
if (!parsed.success) {
  throw new Error(`src/data/topology.yaml is invalid:\n${z.prettifyError(parsed.error)}`);
}
const topology = parsed.data;

const topologyCollection = defineCollection({
  loader: {
    name: 'topology',
    load: async ({ store }) => {
      store.clear();
      store.set({ id: 'thales', data: topology });
    },
  },
});

const incidents = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/incidents' }),
  schema: z
    .object({
      title: z.string(),
      dek: z.string(),
      label: z.string(),
      order: z.number().int().positive(),
      // What the incident touched. Free text since the sky stopped being the lab: the orrery reads
      // only how many there are, and sizes its planet by that.
      focus: z.array(z.string().min(1)).min(1),
    })
    .strict(),
});

export const collections = { topology: topologyCollection, incidents };
