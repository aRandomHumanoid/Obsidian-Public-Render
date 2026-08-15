import esbuild from 'esbuild';
import builtins from 'builtin-modules';

const production = process.argv[2] === 'production';

/**
 * `isDesktopOnly: true` (§13), so Node builtins are available and are marked
 * external rather than bundled — the plugin shells out to `git` (§3.9) and
 * reads the vault's `.git` state, neither of which has a browser equivalent.
 */
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'node',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  minify: production,
  outfile: 'main.js',
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
  ],
  banner: {
    js: '/* Note publisher — built from packages/plugin. Do not edit. */',
  },
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
