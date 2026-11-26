import { defineConfig } from 'vitest/config';

// @js-jail/node's own tests (`npm test` here); the project's root config runs them too
export default defineConfig({
  test: {
    name: 'node',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
