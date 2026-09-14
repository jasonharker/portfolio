import { readFileSync } from 'node:fs';
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import yaml from 'js-yaml';

// Topology is parsed and validated here, at config load, rather than by the `file()`
// loader: that loader logs a YAML parse error and carries on, which would let a broken
// file through the build. A throw here fails `npm run build`, and with it Jenkins.

// Role text must not smuggle in what the schema has no field for (spec §4): no dotted
// numbers (addresses, versions, CIDRs) and no :port.
const role = z.string().min(1).refine((s) => !/\d\.\d|:\d/.test(s), 'looks like an address, version or port');
const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

const topologySchema = z
  .object({
    nodes: z.array(z.object({ id, role, layer: z.enum(['physical', 'proxmox', 'kubernetes', 'services']), pos: vec3.optional() }).strict()).min(1),
    links: z.array(z.object({ from: id, to: id }).strict()),
    waypoints: z.array(z.object({ id: z.enum(['constellation', 'incidents', 'gitops', 'documentation']), pos: vec3, focus: z.array(id).optional() }).strict()),
  })
  .strict()
  .superRefine((t, ctx) => {
    const ids = new Set<string>();
    for (const n of t.nodes) {
      if (ids.has(n.id)) ctx.addIssue({ code: 'custom', message: `duplicate node id: ${n.id}` });
      ids.add(n.id);
    }
    const missing = (ref: string, where: string) => {
      if (!ids.has(ref)) ctx.addIssue({ code: 'custom', message: `${where} references unknown node: ${ref}` });
    };
    t.links.forEach((l, i) => (missing(l.from, `links[${i}].from`), missing(l.to, `links[${i}].to`)));
    t.waypoints.forEach((w) => w.focus?.forEach((f) => missing(f, `waypoint ${w.id} focus`)));
    const places = new Set(t.waypoints.map((w) => w.id));
    if (places.size !== 4 || t.waypoints.length !== 4) ctx.addIssue({ code: 'custom', message: 'waypoints must list each place exactly once' });
  });

const topologyFile = new URL('./data/topology.yaml', import.meta.url);
const parsed = topologySchema.safeParse(yaml.load(readFileSync(topologyFile, 'utf-8')));
if (!parsed.success) {
  throw new Error(`src/data/topology.yaml is invalid:\n${z.prettifyError(parsed.error)}`);
}
const topology = parsed.data;
const nodeIds = topology.nodes.map((n) => n.id) as [string, ...string[]];

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
      focus: z.array(z.enum(nodeIds)).min(1),
    })
    .strict(),
});

export const collections = { topology: topologyCollection, incidents };
