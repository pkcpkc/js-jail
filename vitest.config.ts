import { defineConfig } from 'vitest/config';

// Both packages' tests; each package also runs its own (`npm test` in node/ or wasm/)
export default defineConfig({
  test: {
    projects: ['node', 'wasm'],
  },
});
