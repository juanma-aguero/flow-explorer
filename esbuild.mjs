import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The bundled TypeScript compiler needs its lib.*.d.ts files; ship them next to the bundle.
// Tree-sitter runtime + Go grammar (WASM) used for Go support.
mkdirSync('dist/wasm', { recursive: true });
const require_ = createRequire(import.meta.url);
cpSync(require_.resolve('web-tree-sitter/tree-sitter.wasm'), 'dist/wasm/tree-sitter.wasm');
cpSync(join(dirname(require_.resolve('tree-sitter-wasms/package.json')), 'out', 'tree-sitter-go.wasm'), 'dist/wasm/tree-sitter-go.wasm');

const tsLib = dirname(createRequire(import.meta.url).resolve('typescript/lib/typescript.js'));
mkdirSync('dist/typescript-lib', { recursive: true });
for (const file of readdirSync(tsLib)) {
  if (/^lib\..*\.d\.ts$/.test(file)) cpSync(join(tsLib, file), join('dist/typescript-lib', file));
}

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  // web-tree-sitter's ESM build needs import.meta.url; the extension host bundle is CommonJS, so use its CJS build.
  alias: { 'web-tree-sitter': join(dirname(createRequire(import.meta.url).resolve('web-tree-sitter/tree-sitter.wasm')), 'tree-sitter.cjs') },
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
