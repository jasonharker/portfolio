import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

// Built from the nav's pages and the incidents collection, so a new incident is listed without an
// edit here. A new top-level page has to be added to `pages`.
const pages = ['/', '/resume/', '/documentation/', '/gitops/', '/incidents/'];

export const GET: APIRoute = async ({ site }) => {
  const incidents = (await getCollection('incidents')).map((e) => `/incidents/${e.id}/`);
  const urls = [...pages, ...incidents].map((p) => `  <url><loc>${new URL(p, site).href}</loc></url>`);
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
};
