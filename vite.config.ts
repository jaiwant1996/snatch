/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * SNATCH! is a single static page with no client-side routes, so a *relative*
 * base path ('./') is the most robust choice for GitHub Pages: the same build
 * works at https://<user>.github.io/<repo>/, at a custom domain root, or in any
 * sub-folder, without hard-coding the repository name.
 *
 * Override with BASE_PATH=/my-repo/ if you ever need an absolute base.
 *
 * `--mode e2e` swaps the default Trystero (Nostr) strategy for a local WebSocket
 * relay so the automated two-browser test can run offline. Production builds
 * never include that shim.
 */
export default defineConfig(({ mode }) => ({
  base: process.env.BASE_PATH ?? './',
  resolve:
    mode === 'e2e'
      ? {
          alias: {
            trystero: fileURLToPath(new URL('./tests/e2e/trysteroLocalRelay.ts', import.meta.url)),
          },
        }
      : undefined,
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: (id: string) => (id.includes('node_modules/phaser') ? 'phaser' : undefined),
      },
    },
  },
  server: { host: true },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
}));
