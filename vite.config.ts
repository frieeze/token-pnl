import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  // The Svelte plugin is skipped under Vitest: with Vite 8's rolldown-based dependency
  // optimizer it makes the Node test environment's dep scan fail with a
  // "Could not resolve 'node:module' ... Tsconfig not found" startup error, even for
  // test files that never import a .svelte file. None of our lib tests need it.
  // `process.env.VITEST` is set by Vitest itself, so `npm run dev`/`npm run build` are unaffected.
  plugins: [!process.env.VITEST && svelte()].filter(Boolean),
  test: {
    environment: 'node',
  },
})
