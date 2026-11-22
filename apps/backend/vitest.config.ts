import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'src/blockchain/__tests__/**/*.compat.test.ts',
      'tests/**/*.compat.test.ts',
    ],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});