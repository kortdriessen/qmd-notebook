import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
  }),
  // Comment-thread renderer (runs in the notebook webview).
  esbuild.context({
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2020',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    entryPoints: ['src/renderer/index.ts'],
    outfile: 'dist/renderer.js',
  }),
  // Bundle the MCP companion into the extension too, so users can point Claude/Codex at
  // <extension>/dist/qmd-notebook-mcp.js without a separate npm install.
  esbuild.context({
    ...common,
    entryPoints: ['../mcp-server/src/cli.ts'],
    outfile: 'dist/qmd-notebook-mcp.js',
    banner: { js: '#!/usr/bin/env node' },
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
