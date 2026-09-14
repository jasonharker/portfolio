import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://jasonharker.com',
  // CSP is script-src 'self' (nginx.conf): never inline scripts, however small.
  vite: { build: { assetsInlineLimit: 0 } },
});
