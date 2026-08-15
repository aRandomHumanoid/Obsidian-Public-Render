import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string, file: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/${file}`, import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: [
      // Subpath imports first — the worker uses them to keep `yaml` out of its
      // bundle, and the broader alias below would otherwise swallow them.
      { find: /^@notes\/shared\/(.*)\.js$/, replacement: `${src('shared', '')}$1.ts` },
      { find: /^@notes\/shared$/, replacement: src('shared', 'index.ts') },
      { find: /^@notes\/build\/(.*)\.js$/, replacement: `${src('build', '')}$1.ts` },
      { find: /^@notes\/build$/, replacement: src('build', 'index.ts') },
      // The plugin imports a handful of runtime values from `obsidian`, which
      // only exists inside the app. Everything else it needs from there is a
      // type, so a small stub is enough to exercise the real code paths.
      {
        find: /^obsidian$/,
        replacement: fileURLToPath(new URL('./tests/harness/obsidian.ts', import.meta.url)),
      },
    ],
  },
});
