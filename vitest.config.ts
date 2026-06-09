import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@amplitude/mcp-analytics': resolve(__dirname, './src'),
    },
  },
  test: {
    passWithNoTests: true,
    exclude: ['**/node_modules/**', '**/dist/**'],
    silent: process.env.CI === 'true',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
