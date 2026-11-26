import { defineConfig } from 'vitest/config';

// @js-jail/wasm's own tests (`npm test` here); the project's root config runs them too
export default defineConfig({
  test: {
    name: 'wasm',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
