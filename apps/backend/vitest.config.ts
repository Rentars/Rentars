import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          globals: false,
          include: [
            'src/**/*.{test,spec}.ts',
            'src/**/*.{test,spec}.tsx',
            'src/blockchain/__tests__/**/*.compat.test.ts',
            'tests/**/*.compat.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**', '**/rls/**'],
          testTimeout: 30000,
        },
        resolve: {
          alias: {
            '@': path.resolve(__dirname, './src'),
          },
        },
      },
      {
        test: {
          name: 'rls',
          environment: 'node',
          globals: false,
          include: ['src/**/rls/**/*.{test,spec}.ts', 'tests/rls/**/*.{test,spec}.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          // RLS tests must never be silently skipped. If the database is
          // unavailable, the suite fails rather than reporting success.
          passWithNoTests: false,
          bail: 0,
          testTimeout: 30000,
          hookTimeout: 60000,
        },
        resolve: {
          alias: {
            '@': path.resolve(__dirname, './src'),
          },
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});